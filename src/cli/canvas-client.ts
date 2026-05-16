// @ts-nocheck
import { execFileSync } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

import {
  buildSlackCanvasUrl,
  canvasHtmlToMarkdown,
  hydrateCanvasHtmlControls,
  normalizeWorkspaceUrl,
} from "./canvas-lib.ts";
import {
  allProtoStrings,
  decodeProto,
  protoMessage,
  protoString,
  protoVarint,
  type ProtoField,
} from "./canvas-encoder.ts";

export type CanvasWorkspace = {
  workspace_url: string;
  workspace_name?: string;
  team_id?: string;
  auth: {
    xoxc_token: string;
    xoxd_cookie: string;
  };
};

export type CanvasCredentials = {
  version?: number;
  default_workspace_url?: string;
  workspaces?: CanvasWorkspace[];
};

export type CanvasFile = {
  id: string;
  title?: string;
  name?: string;
  permalink?: string;
  created?: number;
  updated?: number;
  user?: string;
  quip_thread_id?: string;
  url_private?: string;
  url_private_download?: string;
  team_id?: string;
  shares?: unknown;
  [key: string]: unknown;
};

export type CanvasEditContext = {
  threadId: string;
  docId: string;
  sequence: number;
  session: string;
  userId: string;
  jsClientHash: string;
};

const CREDENTIALS_FILE = join(homedir(), ".config", "agent-slack", "credentials.json");
const KEYCHAIN_SERVICE = "agent-slack";
const DEFAULT_JS_CLIENT_HASH = "60PDpHxXPk4YDQTp_I4Fhw";
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const controllerSessions = new Map<
  string,
  Omit<CanvasEditContext, "threadId" | "docId" | "sequence">
>();

export async function loadCanvasCredentials(): Promise<CanvasCredentials> {
  let raw: Record<string, unknown> = { version: 1, workspaces: [] };
  if (existsSync(CREDENTIALS_FILE)) {
    raw = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as Record<string, unknown>;
  }
  const rawWorkspaces = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  const workspaces = rawWorkspaces
    .map(hydrateWorkspace)
    .filter((workspace): workspace is CanvasWorkspace => workspace != null);
  return {
    version: 1,
    default_workspace_url:
      typeof raw.default_workspace_url === "string" ? raw.default_workspace_url : undefined,
    workspaces,
  };
}

export async function resolveCanvasWorkspace(selector?: string): Promise<CanvasWorkspace> {
  const creds = await loadCanvasCredentials();
  const envToken = (process.env.SLACK_XOXC_TOKEN ?? process.env.SLACK_TOKEN)?.trim();
  const envCookie = (process.env.SLACK_XOXD_COOKIE ?? process.env.SLACK_COOKIE_D)?.trim();
  const envWorkspace = selector ?? process.env.SLACK_WORKSPACE_URL ?? creds.default_workspace_url;
  if (envToken || envCookie) {
    if (!envToken?.startsWith("xoxc-")) {
      throw new Error("Browser Canvas auth requires a Slack web xoxc token");
    }
    if (!envCookie) {
      throw new Error(
        "Browser Canvas auth requires Slack's d cookie in SLACK_COOKIE_D or SLACK_XOXD_COOKIE",
      );
    }
    if (!envWorkspace) {
      throw new Error(
        "Browser Canvas auth from environment requires SLACK_WORKSPACE_URL or --workspace",
      );
    }
    return {
      workspace_url: normalizeWorkspaceUrl(envWorkspace),
      auth: { xoxc_token: envToken, xoxd_cookie: envCookie },
    };
  }
  const workspaces = creds.workspaces ?? [];
  if (workspaces.length === 0) {
    throw new Error(
      'No Slack browser credentials available. Run "agent-slack auth import-desktop".',
    );
  }
  if (!selector) {
    const def = creds.default_workspace_url;
    return (
      workspaces.find(
        (w) => def && normalizeWorkspaceUrl(w.workspace_url) === normalizeWorkspaceUrl(def),
      ) ?? workspaces[0]
    );
  }
  const normalized = selector.startsWith("http") ? normalizeWorkspaceUrl(selector) : undefined;
  const matches = workspaces.filter((w) => {
    const url = normalizeWorkspaceUrl(w.workspace_url);
    return normalized
      ? url === normalized
      : url.includes(selector) ||
          (w.workspace_name ?? "").toLowerCase().includes(selector.toLowerCase());
  });
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new Error(`No configured workspace matches selector "${selector}"`);
  }
  throw new Error(`Workspace selector "${selector}" is ambiguous`);
}

export async function slackApi(
  workspace: CanvasWorkspace,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  body.set("token", workspace.auth.xoxc_token);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const resp = await fetch(`${workspace.workspace_url.replace(/\/$/, "")}/api/${method}`, {
    method: "POST",
    headers: browserFormHeaders(workspace),
    body,
  });
  return await parseSlackResponse(method, resp);
}

export async function privateCanvasPost(
  workspace: CanvasWorkspace,
  path: string,
  body: URLSearchParams,
): Promise<Buffer> {
  body.set("token", workspace.auth.xoxc_token);
  const resp = await fetch(`${workspace.workspace_url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: browserFormHeaders(workspace),
    body,
  });
  const binary = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new Error(
      `Private Canvas request failed: HTTP ${resp.status}: ${binary.toString("utf8").slice(0, 240)}`,
    );
  }
  return binary;
}

export async function loadCanvasEditContext(
  workspace: CanvasWorkspace,
  input: { canvasId: string; threadId: string; forceRefresh?: boolean },
): Promise<CanvasEditContext> {
  const { controller, payload } = await loadCanvasDataPayload(workspace, input);
  const docId =
    stringField(payload, 10) ??
    allProtoStrings(payload).find(
      (value) => /^[A-Za-z0-9]{11}$/.test(value) && value !== input.threadId,
    );
  if (!docId) {
    throw new Error(`Canvas load-data did not return a document id for ${input.canvasId}`);
  }
  return {
    ...controller,
    threadId: input.threadId,
    docId,
    sequence: numberField(payload, 107) ?? 1,
  };
}

export async function fetchCanvasLoadDataStrings(
  workspace: CanvasWorkspace,
  input: { canvasId: string; threadId: string; forceRefresh?: boolean },
): Promise<string[]> {
  const controller = await canvasControllerSession(workspace, input.forceRefresh);
  const body = canvasPrivateBody(controller);
  body.set(
    "request_binary",
    Buffer.concat([
      protoString(1, input.threadId),
      protoMessage(3, [protoVarint(1, 1), protoString(2, input.threadId)]),
      protoString(5, "editor"),
      protoVarint(6, 1),
    ]).toString("base64"),
  );
  const response = await privateCanvasPost(workspace, "/canvas/-/load-data/editor/1", body);
  return allProtoStrings(decodeProto(response));
}

export async function fetchCanvasLatestStrings(
  workspace: CanvasWorkspace,
  input: { canvasId: string; threadId: string; since?: number },
): Promise<string[]> {
  const context = await loadCanvasEditContext(workspace, input);
  const body = canvasPrivateBody(context);
  body.set(
    "request_binary",
    protoMessage(1, [
      protoString(1, context.threadId),
      protoVarint(2, input.since ?? 1),
      protoVarint(3, 2000),
    ]).toString("base64"),
  );
  const response = await privateCanvasPost(workspace, "/canvas/-/fetch-latest", body);
  return allProtoStrings(decodeProto(response));
}

async function loadCanvasDataPayload(
  workspace: CanvasWorkspace,
  input: { canvasId: string; threadId: string; forceRefresh?: boolean },
): Promise<{
  controller: Omit<CanvasEditContext, "threadId" | "docId" | "sequence">;
  payload: ProtoField[];
}> {
  const controller = await canvasControllerSession(workspace, input.forceRefresh);
  const requestBinary = protoString(1, input.threadId);
  const body = canvasPrivateBody(controller);
  body.set("request_binary", requestBinary.toString("base64"));
  const response = await privateCanvasPost(workspace, "/canvas/-/load-data", body);
  return { controller, payload: decodeLoadDataPayload(response) };
}

export async function listCanvases(
  workspace: CanvasWorkspace,
  input: { count: number; page: number },
): Promise<{ files: CanvasFile[]; paging?: Record<string, unknown> }> {
  const payload = await slackApi(workspace, "files.list", {
    types: "spaces",
    count: input.count,
    page: input.page,
  });
  return {
    files: Array.isArray(payload.files)
      ? payload.files.filter(isRecord).map((file) => file as CanvasFile)
      : [],
    paging: isRecord(payload.paging) ? payload.paging : undefined,
  };
}

export async function canvasInfo(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<CanvasFile> {
  const payload = await slackApi(workspace, "files.info", { file: canvasId });
  if (!isRecord(payload.file)) {
    throw new Error(`files.info did not return file metadata for ${canvasId}`);
  }
  return payload.file as CanvasFile;
}

export async function readCanvas(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<{ file: CanvasFile; markdown: string; html?: string }> {
  const file = await canvasInfo(workspace, canvasId);
  const downloadUrl =
    typeof file.url_private_download === "string"
      ? file.url_private_download
      : typeof file.url_private === "string"
        ? file.url_private
        : undefined;
  if (!downloadUrl) {
    return { file, markdown: "" };
  }
  let html = await fetchBrowserText(workspace, downloadUrl);
  const threadId =
    typeof file.quip_thread_id === "string"
      ? file.quip_thread_id
      : typeof file.thread_ts === "string"
        ? file.thread_ts
        : undefined;
  if (threadId && html.includes("<control")) {
    try {
      html = hydrateCanvasHtmlControls(
        html,
        await fetchCanvasLoadDataStrings(workspace, { canvasId, threadId, forceRefresh: true }),
      );
    } catch {
      // Keep read resilient when Slack's private load-data endpoint is temporarily stale.
    }
  }
  return { file, markdown: canvasHtmlToMarkdown(html), html };
}

export async function createCanvas(
  workspace: CanvasWorkspace,
  input: { title: string; markdown?: string; channel?: string; silent?: boolean },
): Promise<Record<string, unknown>> {
  const controller = await canvasControllerSession(workspace, true);
  const threadPrefix = await canvasThreadPrefix(workspace);
  const tempThreadId = `temp:A:${threadPrefix}${randomHex(16)}`;
  const tempDocumentId = `temp:B${randomHex(16)}`;
  const requestBinary = Buffer.concat([
    protoString(1, input.title || "Untitled"),
    protoString(3, tempThreadId),
    protoString(4, tempDocumentId),
    protoVarint(8, 1),
  ]);
  const body = canvasPrivateBody(controller);
  body.set("handler", "167");
  body.set("request_binary", requestBinary.toString("base64"));
  body.set("secret_paths", "{}");
  const response = await privateCanvasPost(
    workspace,
    "/canvas/-/call-handler/create-collab-document",
    body,
  );
  const threadIds = [
    ...new Set(
      allProtoStrings(decodeProto(response)).filter((value) => /^[A-Za-z0-9]{11}$/.test(value)),
    ),
  ];
  for (const threadId of threadIds) {
    const canvasId = await lookupCanvasIdByThread(workspace, threadId);
    if (!canvasId) {
      continue;
    }
    if (input.channel) {
      await shareCanvas(workspace, {
        canvasId,
        channel: input.channel,
        grant: "write",
        silent: input.silent,
      });
    }
    const docId = threadIds.find(
      (value) => value !== threadId && value.startsWith(threadId.slice(0, 3)),
    );
    return {
      ok: true,
      canvas_id: canvasId,
      file: { id: canvasId, quip_thread_id: threadId, document_id: docId },
      private_response_bytes: response.length,
    };
  }
  throw new Error(
    `Private Canvas create did not resolve a file id. Candidate thread ids: ${threadIds.join(", ") || "none"}`,
  );
}

export async function deleteCanvas(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.delete", { file: canvasId });
}

export async function shareCanvas(
  workspace: CanvasWorkspace,
  input: { canvasId: string; channel: string; grant: "read" | "write"; silent?: boolean },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.share", {
    files: input.canvasId,
    channel: input.channel,
    resharing_aware: true,
    permissions: [{ grant: input.grant, file_id: input.canvasId }],
    skip_dlp_user_warning: false,
    from_share_modal: true,
    client_context_team_id: workspace.team_id,
    silent_share: input.silent ? true : undefined,
    _x_reason: "share_dialog_permission_share_to_user",
  });
}

export async function updateCanvasUserPermission(
  workspace: CanvasWorkspace,
  input: { canvasId: string; userId: string; level: "read" | "write"; teamId?: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.updatePermission", {
    file_id: input.canvasId,
    user_id_access_level_map: [{ user_id: input.userId, access_level: input.level }],
    team_id: input.teamId ?? workspace.team_id,
    _x_reason: "update-permission",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
}

export async function revokeCanvasUserPermission(
  workspace: CanvasWorkspace,
  input: { canvasId: string; userId: string; teamId?: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.revokePermission", {
    file_id: input.canvasId,
    user_id: input.userId,
    team_id: input.teamId ?? workspace.team_id,
    _x_reason: "revoke-permission",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
}

export async function revokeCanvasShare(
  workspace: CanvasWorkspace,
  input: { canvasId: string; channel: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.revokePermission", {
    file_id: input.canvasId,
    channel_id: input.channel,
    team_id: workspace.team_id,
    _x_reason: "revoke-permission",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
}

export async function setWorkspaceCanvasAccess(
  workspace: CanvasWorkspace,
  input: { canvasId: string; level: "invitation" | "read" | "write" },
): Promise<Record<string, unknown>> {
  const teamId =
    workspace.team_id ??
    stringValue((await canvasInfo(workspace, input.canvasId)).user_team) ??
    stringValue((await canvasInfo(workspace, input.canvasId)).team_id);
  if (input.level === "invitation") {
    return await slackApi(workspace, "files.disableCrossWorkspaceLinkSharing", {
      file_id: input.canvasId,
      entity_type: "workspace",
      entity_id: teamId,
      _x_reason: "enable_cross_org_link_share",
      _x_mode: "online",
      _x_sonic: true,
      _x_app_name: "client",
    });
  }
  return await slackApi(workspace, "files.enableCrossWorkspaceLinkSharing", {
    file_id: input.canvasId,
    entity_type: "workspace",
    entity_id: teamId,
    access_level: input.level,
    _x_reason: "enable_cross_org_link_share",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
}

export async function uploadCanvasFile(
  workspace: CanvasWorkspace,
  filePath: string,
): Promise<{ fileId: string; title: string }> {
  const bytes = await readFile(filePath);
  const title = basename(filePath);
  const upload = await slackApi(workspace, "files.getUploadURL", {
    filename: title,
    length: bytes.length,
    _x_reason: "upload-queue",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
  const fileId = stringValue(upload.file) ?? stringValue(upload.file_id);
  const uploadUrl = stringValue(upload.upload_url);
  if (!fileId || !uploadUrl) {
    throw new Error("files.getUploadURL did not return file and upload_url");
  }
  const form = new FormData();
  form.set("file", new Blob([bytes]), title);
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Referer: "",
    },
    body: form,
  });
  const uploadText = await uploadResp.text();
  if (!uploadResp.ok) {
    throw new Error(
      `Slack upload URL failed: HTTP ${uploadResp.status}: ${uploadText.slice(0, 240)}`,
    );
  }
  await slackApi(workspace, "files.completeUpload", {
    files: [{ id: fileId, title }],
    _x_reason: "upload-queue",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
  return { fileId, title };
}

export async function addCanvasStar(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "stars.add", { file: canvasId });
}

export async function removeCanvasStar(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "stars.remove", { file: canvasId });
}

export async function canvasShares(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.getShares", {
    file_id: canvasId,
    _x_reason: "file-shares-store.ConditionalFetchManager.fetch",
  });
}

export async function canvasAccessMetadata(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "files.getMetadata", {
    file_id: canvasId,
    type: "users",
    limit: 30,
    _x_reason: "fetch-file-metadata",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
}

export async function addCanvasReaction(
  workspace: CanvasWorkspace,
  input: { channel: string; timestamp: string; name: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "reactions.add", {
    channel: input.channel,
    timestamp: input.timestamp,
    name: input.name,
  });
}

export async function removeCanvasReaction(
  workspace: CanvasWorkspace,
  input: { channel: string; timestamp: string; name: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "reactions.remove", {
    channel: input.channel,
    timestamp: input.timestamp,
    name: input.name,
  });
}

export async function canvasReactions(
  workspace: CanvasWorkspace,
  input: { channel: string; timestamp: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "reactions.get", {
    channel: input.channel,
    timestamp: input.timestamp,
    full: true,
  });
}

export async function addCanvasComment(
  workspace: CanvasWorkspace,
  input: { channel: string; threadTs: string; text: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "chat.postMessage", {
    channel: input.channel,
    thread_ts: input.threadTs,
    text: input.text,
  });
}

export async function listCanvasComments(
  workspace: CanvasWorkspace,
  input: { channel: string; threadTs: string },
): Promise<Record<string, unknown>> {
  return await slackApi(workspace, "conversations.replies", {
    channel: input.channel,
    ts: input.threadTs,
  });
}

export async function fetchBrowserText(workspace: CanvasWorkspace, url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      Cookie: `d=${encodeURIComponent(workspace.auth.xoxd_cookie)}`,
      "Cache-Control": "no-cache",
      "User-Agent": BROWSER_USER_AGENT,
      Referer: `${workspace.workspace_url.replace(/\/$/, "")}/`,
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 240)}`);
  }
  return text;
}

export function compactCanvasFile(
  workspace: CanvasWorkspace,
  file: CanvasFile,
): Record<string, unknown> {
  return pruneEmpty({
    id: file.id,
    title: file.title ?? file.name,
    url:
      typeof file.permalink === "string"
        ? file.permalink
        : buildSlackCanvasUrl(
            workspace.workspace_url,
            file.id,
            workspace.team_id ?? file.team_id ?? stringValue(file.user_team),
          ),
    created: file.created,
    updated: file.updated,
    user: file.user,
    quip_thread_id: file.quip_thread_id,
    team_id: workspace.team_id ?? file.team_id ?? stringValue(file.user_team),
  });
}

export function extractFirstShare(
  fileOrPayload: unknown,
): { channel: string; ts: string } | undefined {
  const shares =
    isRecord(fileOrPayload) && isRecord(fileOrPayload.shares)
      ? fileOrPayload.shares
      : isRecord(fileOrPayload) &&
          isRecord(fileOrPayload.file) &&
          isRecord(fileOrPayload.file.shares)
        ? fileOrPayload.file.shares
        : undefined;
  if (!isRecord(shares)) {
    return undefined;
  }
  for (const bucket of Object.values(shares)) {
    if (!isRecord(bucket)) {
      continue;
    }
    for (const [channel, entries] of Object.entries(bucket)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.ts === "string") {
          return { channel, ts: entry.ts };
        }
      }
    }
  }
  return undefined;
}

export function extractCanvasFileThread(
  fileOrPayload: unknown,
): { channel: string; ts: string } | undefined {
  const file =
    isRecord(fileOrPayload) && isRecord(fileOrPayload.file) ? fileOrPayload.file : fileOrPayload;
  const shares = isRecord(file) && isRecord(file.shares) ? file.shares : undefined;
  if (shares && isRecord(shares.message_threads)) {
    const found = firstShareEntry(shares.message_threads);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function canvasControllerSession(
  workspace: CanvasWorkspace,
  forceRefresh = false,
): Promise<Omit<CanvasEditContext, "threadId" | "docId" | "sequence">> {
  const key = workspace.workspace_url;
  if (!forceRefresh) {
    const cached = controllerSessions.get(key);
    if (cached) {
      return cached;
    }
  }
  const form = new FormData();
  form.set("token", workspace.auth.xoxc_token);
  form.set("canvas_loadshed_priority", "low");
  const resp = await fetch(
    `${workspace.workspace_url.replace(/\/$/, "")}/canvas/collab/controller-init?format=map`,
    {
      method: "POST",
      headers: browserFetchHeaders(workspace),
      body: form,
    },
  );
  const text = await resp.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Private Canvas controller-init returned non-JSON HTTP ${resp.status}: ${text.slice(0, 240)}`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `Private Canvas controller-init failed: HTTP ${resp.status}: ${text.slice(0, 240)}`,
    );
  }
  const userId = stringValue(payload.user_id);
  if (!userId) {
    throw new Error("Private Canvas controller-init did not return a Quip user id");
  }
  const session = {
    session: randomBytes(6).toString("hex"),
    userId,
    jsClientHash: DEFAULT_JS_CLIENT_HASH,
  };
  controllerSessions.set(key, session);
  return session;
}

function canvasPrivateBody(
  context: Omit<CanvasEditContext, "threadId" | "docId" | "sequence">,
): URLSearchParams {
  const now = Date.now();
  const body = new URLSearchParams();
  body.set("_csrf", "undefined");
  body.set("_js_client_hash", context.jsClientHash);
  body.set("_js_request_id", `r${randomHex(5)}`);
  body.set("_js_request_time", String(now));
  body.set("_js_request_time_ms", String(now));
  body.set("_resource_bundle", "collab_controller");
  body.set("_user_id", context.userId);
  body.set("_version", "10");
  body.set("_window_session_id", context.session);
  return body;
}

async function canvasThreadPrefix(workspace: CanvasWorkspace): Promise<string> {
  try {
    const payload = await listCanvases(workspace, { count: 20, page: 1 });
    for (const file of payload.files) {
      const match = file.quip_thread_id?.match(/^([A-Za-z]{3})9[A-Za-z0-9]{7}$/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Fall back to the prefix observed in Slack web if recent files are unavailable.
  }
  return "XBV";
}

async function lookupCanvasIdByThread(
  workspace: CanvasWorkspace,
  threadId: string,
): Promise<string | undefined> {
  try {
    const payload = await slackApi(workspace, "quip.lookupFileId", { quip_thread_id: threadId });
    return (
      stringValue(payload.file_id) ??
      (isRecord(payload.file) ? stringValue(payload.file.id) : undefined)
    );
  } catch {
    return undefined;
  }
}

function decodeLoadDataPayload(binary: Buffer): ProtoField[] {
  const root = decodeProto(binary);
  const wrapper = getMessage(root, 2);
  const response = wrapper ? decodeProto(wrapper) : root;
  const payload = getMessage(response, 2);
  const nested = payload ? decodeProto(payload) : response;
  const direct = getMessage(nested, 3);
  return direct ? decodeProto(direct) : nested;
}

function getMessage(fields: ProtoField[], no: number): Buffer | undefined {
  const field = fields.find(
    (candidate) => candidate.no === no && candidate.wire === 2 && Buffer.isBuffer(candidate.value),
  );
  return field?.value as Buffer | undefined;
}

function stringField(fields: ProtoField[], no: number): string | undefined {
  return getMessage(fields, no)?.toString("utf8");
}

function numberField(fields: ProtoField[], no: number): number | undefined {
  const field = fields.find(
    (candidate) =>
      candidate.no === no && candidate.wire === 0 && typeof candidate.value === "bigint",
  );
  return field ? Number(field.value) : undefined;
}

function firstShareEntry(value: unknown): { channel: string; ts: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [channel, entries] of Object.entries(value)) {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.ts === "string") {
          return { channel, ts: entry.ts };
        }
      }
      continue;
    }
    const nested = firstShareEntry(entries);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function hydrateWorkspace(value: unknown): CanvasWorkspace | null {
  if (!isRecord(value) || typeof value.workspace_url !== "string") {
    return null;
  }
  const workspaceUrl = normalizeWorkspaceUrl(value.workspace_url);
  const auth = isRecord(value.auth) ? value.auth : {};
  const xoxc = keychainGet(`xoxc:${workspaceUrl}`) ?? stringValue(auth.xoxc_token);
  const xoxd = keychainGet("xoxd") ?? stringValue(auth.xoxd_cookie);
  if (!xoxc || !xoxd) {
    return null;
  }
  return {
    workspace_url: workspaceUrl,
    workspace_name: stringValue(value.workspace_name),
    team_id: stringValue(value.team_id),
    auth: { xoxc_token: xoxc, xoxd_cookie: xoxd },
  };
}

function browserFormHeaders(workspace: CanvasWorkspace): HeadersInit {
  return {
    Cookie: `d=${encodeURIComponent(workspace.auth.xoxd_cookie)}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": BROWSER_USER_AGENT,
    Referer: `${workspace.workspace_url.replace(/\/$/, "")}/`,
  };
}

function browserFetchHeaders(workspace: CanvasWorkspace): HeadersInit {
  return {
    Cookie: `d=${encodeURIComponent(workspace.auth.xoxd_cookie)}`,
    "User-Agent": BROWSER_USER_AGENT,
    Referer: `${workspace.workspace_url.replace(/\/$/, "")}/`,
  };
}

async function parseSlackResponse(
  method: string,
  resp: Response,
): Promise<Record<string, unknown>> {
  const text = await resp.text();
  let payload: Record<string, unknown>;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${method} returned non-JSON HTTP ${resp.status}: ${text.slice(0, 240)}`);
  }
  if (!resp.ok || payload.ok === false) {
    const detail = [payload.error, payload.detail].filter(Boolean).join(": ");
    throw new Error(`${method} failed: ${detail || `HTTP ${resp.status}`}`);
  }
  return payload;
}

function keychainGet(account: string): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function randomHex(bytes: number): string {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, bytes * 2);
}

function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => pruneEmpty(item)).filter((item) => item !== undefined) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = pruneEmpty(child);
    if (next === undefined || next === null) {
      continue;
    }
    if (Array.isArray(next) && next.length === 0) {
      continue;
    }
    if (isRecord(next) && Object.keys(next).length === 0) {
      continue;
    }
    out[key] = next;
  }
  return out as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
