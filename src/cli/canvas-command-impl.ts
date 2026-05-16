// @ts-nocheck
import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";

import {
  addCanvasStar,
  canvasAccessMetadata,
  canvasInfo,
  canvasReactions,
  canvasShares,
  compactCanvasFile,
  createCanvas,
  deleteCanvas,
  extractCanvasFileThread,
  fetchCanvasLatestStrings,
  fetchCanvasLoadDataStrings,
  listCanvasComments,
  listCanvases,
  loadCanvasEditContext,
  privateCanvasPost,
  readCanvas,
  removeCanvasStar,
  resolveCanvasWorkspace,
  revokeCanvasShare,
  revokeCanvasUserPermission,
  setWorkspaceCanvasAccess,
  shareCanvas,
  slackApi,
  type CanvasFile,
  type CanvasEditContext,
  type CanvasWorkspace,
  updateCanvasUserPermission,
  uploadCanvasFile,
} from "./canvas-client.ts";
import {
  allProtoStrings,
  buildPrivateAnnotationDocumentData,
  buildPrivateCanvasEmbedDocumentData,
  buildPrivateCoverDocumentData,
  buildPrivateFileEmbedAfterSectionDocumentData,
  buildPrivateFileEmbedDocumentData,
  buildPrivateMarkdownDocumentData,
  buildPrivateMarkdownDocumentStrings,
  buildPrivateMessageEmbedDocumentData,
  buildPrivateSectionDeleteDocumentData,
  buildPrivateTableDocumentMutation,
  decodePrivateBodyText,
  decodeProto,
  parsePrivateInlineBodyText,
  parsePrivateMarkdownBlocks,
} from "./canvas-encoder.ts";
import {
  extractCanvasResources,
  extractCanvasSections,
  extractSpecialInsertions,
  buildSlackCanvasUrl,
  inspectCanvasMarkdown,
  isCanvasId,
  parseSlackCanvasRef,
  type CanvasResource,
  type CanvasSection,
} from "./canvas-lib.ts";
import { deriveCanvasIdempotencyKey } from "./canvas-idempotency.ts";
import {
  buildErrorEnvelope,
  buildPaginationMeta,
  serializeCanvasOutput,
  type CanvasFormat,
  type CanvasOutputOptions,
} from "./canvas-output.ts";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string[]>;
  formatExplicit: boolean;
};

type Globals = CanvasOutputOptions & {
  workspace?: string;
  idempotencyKey?: string;
  debug?: boolean;
};

type CanvasDeps = {
  resolveCanvasWorkspace: typeof resolveCanvasWorkspace;
  listCanvases: typeof listCanvases;
  readCanvas: typeof readCanvas;
  canvasInfo: typeof canvasInfo;
  createCanvas: typeof createCanvas;
  deleteCanvas: typeof deleteCanvas;
  addCanvasStar: typeof addCanvasStar;
  removeCanvasStar: typeof removeCanvasStar;
  canvasShares: typeof canvasShares;
  canvasAccessMetadata: typeof canvasAccessMetadata;
  canvasReactions: typeof canvasReactions;
  listCanvasComments: typeof listCanvasComments;
  setWorkspaceCanvasAccess: typeof setWorkspaceCanvasAccess;
  shareCanvas: typeof shareCanvas;
  revokeCanvasShare: typeof revokeCanvasShare;
  updateCanvasUserPermission: typeof updateCanvasUserPermission;
  revokeCanvasUserPermission: typeof revokeCanvasUserPermission;
  slackApi: typeof slackApi;
  privateCanvasPost: typeof privateCanvasPost;
  loadCanvasEditContext: typeof loadCanvasEditContext;
  uploadCanvasFile: typeof uploadCanvasFile;
  fetchCanvasLatestStrings: typeof fetchCanvasLatestStrings;
  fetchCanvasLoadDataStrings: typeof fetchCanvasLoadDataStrings;
};

type CanvasModel = {
  canvasId: string;
  file: CanvasFile;
  markdown: string;
  html?: string;
  title: string;
  threadId: string;
  docId: string;
  sequence: number;
  session: string;
  jsClientHash?: string;
  editorUserId: string;
  fileChannel: string;
  fileThreadTs?: string;
  sections: CanvasSection[];
  resources: CanvasResource[];
  comments: unknown[];
  reactions: unknown[];
};

type CanvasReactionItem = {
  emoji: string;
  reaction_total: number;
  reacted: boolean;
  anchor: Record<string, unknown>;
};

type SpanTarget = {
  sectionId: string;
  anchorId: string;
  threadTs: string;
  selectedText: string;
  occurrence?: number;
  startOffset?: number;
};

type Verification = {
  verified: boolean;
  note?: Record<string, unknown>;
};

type AccessTarget = {
  kind: "user" | "channel";
  id: string;
  channel: string;
};

const EDIT_DOCUMENT_PATH = "/canvas/-/edit-document";
const DEFAULT_JS_CLIENT_HASH = "60PDpHxXPk4YDQTp_I4Fhw";
const IDEMPOTENCY_CACHE_DIR = join(homedir(), ".cache", "agent-slack");
const IDEMPOTENCY_CACHE_FILE = join(IDEMPOTENCY_CACHE_DIR, "canvas-idempotency.json");
const IDEMPOTENCY_CACHE_TTL_MS = 10 * 60 * 1000;

type MutationEntry = {
  canvas_id: string;
  file_updated?: number;
  expires_at: number;
};

const defaultCanvasDeps: CanvasDeps = {
  resolveCanvasWorkspace,
  listCanvases,
  readCanvas,
  canvasInfo,
  createCanvas,
  deleteCanvas,
  addCanvasStar,
  removeCanvasStar,
  canvasShares,
  canvasAccessMetadata,
  canvasReactions,
  listCanvasComments,
  setWorkspaceCanvasAccess,
  shareCanvas,
  revokeCanvasShare,
  updateCanvasUserPermission,
  revokeCanvasUserPermission,
  slackApi,
  privateCanvasPost,
  loadCanvasEditContext,
  uploadCanvasFile,
  fetchCanvasLatestStrings,
  fetchCanvasLoadDataStrings,
};

let activeGlobals: Globals = {};
let injectedStdinText: string | undefined;
let outputSink: string[] | undefined;
let canvasDeps: CanvasDeps = defaultCanvasDeps;
const mutationMemory = new Map<string, MutationEntry>();

export class CanvasCommandError extends Error {
  error_code: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.error_code = errorCode;
  }
}

export function __setCanvasTestDeps(patch: Partial<CanvasDeps>): void {
  canvasDeps = { ...canvasDeps, ...patch };
}

export function __resetCanvasTestDeps(): void {
  canvasDeps = defaultCanvasDeps;
  activeGlobals = {};
  injectedStdinText = undefined;
  outputSink = undefined;
  mutationMemory.clear();
}

export async function __testRunCanvas(
  args: string[],
  stdin?: string,
): Promise<Record<string, unknown>> {
  const previousGlobals = activeGlobals;
  const previousInjected = injectedStdinText;
  const previousSink = outputSink;
  outputSink = [];
  injectedStdinText = stdin;
  try {
    const parsed = parseArgs(args);
    activeGlobals = globalsFrom(parsed);
    await dispatch(parsed);
    const text = outputSink.join("");
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    activeGlobals = previousGlobals;
    injectedStdinText = previousInjected;
    outputSink = previousSink;
  }
}

function printHelp(): void {
  console.log(`Usage:
  agent-slack canvas
  agent-slack canvas init --shell zsh|bash --install|--uninstall
  agent-slack canvas list [--workspace URL] [--limit N] [--page N]
  agent-slack canvas read <canvas> [--workspace URL]
  agent-slack canvas info <canvas> [--workspace URL]
  agent-slack canvas create --title TITLE --from <file|-> [--channel C] [--silent]
  agent-slack canvas share <canvas> --channel C [--level viewer|editor] [--silent]
  agent-slack canvas title set <canvas> --title TITLE
  agent-slack canvas delete <canvas> --confirm <canvas-id>
  agent-slack canvas validate <markdown-file|->
  agent-slack canvas append|prepend|replace <canvas> --from <file|->
  agent-slack canvas section list|insert|replace|delete ...
  agent-slack canvas table insert|replace <canvas> --from <csv-or-json-file|->
  agent-slack canvas mention resolve|insert ...
  agent-slack canvas date insert <canvas> --date DATE
  agent-slack canvas embed list|add|remove ...
  agent-slack canvas comment list|add|resolve ...
  agent-slack canvas react list|add|remove ...
  agent-slack canvas access show|set|grant|revoke ...
  agent-slack canvas cover list|set|clear ...
  agent-slack canvas favorite set|clear ...

Global flags:
  --workspace URL --format json|toon --fields a,b --max-chars N --full
  --idempotency-key KEY --debug`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  activeGlobals = globalsFrom(parsed);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }
  await dispatch(parsed);
}

async function dispatch(parsed: ParsedArgs): Promise<void> {
  if (parsed.positionals.length === 0) {
    return await commandDashboard();
  }
  const [command, subcommand, ...rest] = parsed.positionals;
  if (command === "init") {
    return await commandInit(parsed);
  }
  if (command === "list") {
    return await commandList(parsed);
  }
  if (command === "read" || command === "get") {
    return await commandRead(parsed);
  }
  if (command === "info") {
    return await commandInfo(parsed);
  }
  if (command === "create") {
    return await commandCreate(parsed);
  }
  if (command === "share") {
    return await commandShare(parsed);
  }
  if (command === "title") {
    if (subcommand !== "set") {
      throw new Error("title requires set");
    }
    return await commandTitle(parsedWithPositionals(parsed, rest));
  }
  if (command === "delete") {
    return await commandDelete(parsed);
  }
  if (command === "validate") {
    return await commandValidate(parsed);
  }
  if (command === "append" || command === "prepend" || command === "replace") {
    return await commandWrite(parsed, command);
  }
  if (command === "section") {
    return await commandSection(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "table") {
    return await commandTable(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "mention") {
    return await commandMention(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "date") {
    return await commandDate(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "embed") {
    return await commandEmbed(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "comment") {
    return await commandComment(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "react") {
    return await commandReact(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "access") {
    return await commandAccess(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "cover") {
    return await commandCover(subcommand, parsedWithPositionals(parsed, rest));
  }
  if (command === "favorite") {
    return await commandFavorite(subcommand, parsedWithPositionals(parsed, rest));
  }
  throw new Error(`Unknown canvas command: ${command}`);
}

async function commandDashboard(): Promise<void> {
  const workspace = await canvasDeps.resolveCanvasWorkspace(activeGlobals.workspace);
  const listed = await canvasDeps.listCanvases(workspace, { count: 10, page: 1 });
  writeOutput(
    {
      ok: true,
      workspace: workspaceSummary(workspace),
      recent_canvases: listed.files.map((file) => compactCanvasFile(workspace, file)),
      meta: buildPaginationMeta({
        total: numberFromPaging(listed.paging) ?? listed.files.length,
        returned: listed.files.length,
        page: 1,
        perPage: 10,
        hasMore: pagingHasMore(listed.paging),
      }),
    },
    { collection: true },
  );
}

async function commandInit(parsed: ParsedArgs): Promise<void> {
  const shell = value(parsed, "--shell") ?? detectShell();
  if (shell !== "zsh" && shell !== "bash") {
    throw new Error("--shell must be zsh or bash");
  }
  if (bool(parsed, "--hook")) {
    process.stdout.write(canvasShellHook());
    return;
  }
  const install = bool(parsed, "--install");
  const uninstall = bool(parsed, "--uninstall");
  if (install === uninstall) {
    throw new Error("canvas init requires exactly one of --install or --uninstall");
  }
  const rcPath = shell === "zsh" ? join(homedir(), ".zshrc") : join(homedir(), ".bashrc");
  const markerStart = "# >>> agent-slack canvas init >>>";
  const markerEnd = "# <<< agent-slack canvas init <<<";
  const hook = `${markerStart}\neval "$(agent-slack canvas init --shell ${shell} --hook)"\n${markerEnd}`;
  const current = existsSync(rcPath) ? await readFile(rcPath, "utf8") : "";
  const stripped = current
    .replace(
      new RegExp(`\\n?${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`, "g"),
      "\n",
    )
    .trimEnd();
  if (install) {
    await writeFile(rcPath, `${stripped}${stripped ? "\n" : ""}${hook}\n`);
  } else {
    await writeFile(rcPath, `${stripped}${stripped ? "\n" : ""}`);
  }
  writeOutput({ ok: true, shell, rc_path: rcPath, installed: install });
}

function canvasShellHook(): string {
  return ["slack-canvas() {", '  command agent-slack canvas "$@"', "}", ""].join("\n");
}

async function commandList(parsed: ParsedArgs): Promise<void> {
  const workspace = await canvasDeps.resolveCanvasWorkspace(activeGlobals.workspace);
  const limit = clampInt(value(parsed, "--limit") ?? "20", 1, 100);
  const page = clampInt(value(parsed, "--page") ?? "1", 1, 10000);
  const listed = await canvasDeps.listCanvases(workspace, { count: limit, page });
  const total = numberFromPaging(listed.paging) ?? listed.files.length;
  writeOutput(
    {
      ok: true,
      canvases: listed.files.map((file) => compactCanvasFile(workspace, file)),
      meta: buildPaginationMeta({
        total,
        returned: listed.files.length,
        page,
        perPage: limit,
        hasMore: pagingHasMore(listed.paging),
      }),
    },
    { collection: true },
  );
}

async function commandRead(parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 1, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const result = await canvasDeps.readCanvas(workspace, target.canvasId);
  writeOutput({
    ok: true,
    canvas: compactCanvasFile(workspace, result.file),
    markdown: result.markdown,
  });
}

async function commandInfo(parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 1, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const file = await canvasDeps.canvasInfo(workspace, target.canvasId);
  writeOutput({ ok: true, canvas: compactCanvasFile(workspace, file), file });
}

async function commandCreate(parsed: ParsedArgs): Promise<void> {
  const title = requiredFlag(parsed, "--title");
  const markdown = markdownWithLeadingTitle(
    title,
    await readTextArg(requiredFlag(parsed, "--from")),
  );
  const workspace = await canvasDeps.resolveCanvasWorkspace(activeGlobals.workspace);
  const key = idempotencyKey("create", undefined, markdown, {
    title,
    channel: value(parsed, "--channel"),
  });
  const existing = await canvasDeps.listCanvases(workspace, { count: 100, page: 1 });
  const sameTitle = existing.files.find((file) => (file.title ?? file.name) === title);
  if (sameTitle) {
    writeOutput({
      ok: true,
      canvas: compactCanvasFile(workspace, sameTitle),
      canvas_id: sameTitle.id,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const created = await canvasDeps.createCanvas(workspace, {
    title,
    channel: value(parsed, "--channel"),
    silent: bool(parsed, "--silent"),
  });
  const canvasId = canvasIdFromPayload(created);
  if (!canvasId) {
    throw new Error("canvases.create did not return a canvas id");
  }
  const model = await fetchCanvasModelOrFallback(workspace, canvasId, title);
  const privateRequest = await performPrivateEdit(workspace, model, (latest) =>
    buildPrivateMarkdownDocumentData({
      ...privateDocumentInput(latest, markdown, "append"),
      title,
    }),
  );
  let after = await fetchCanvasModelOrFallback(workspace, canvasId, title);
  for (let attempt = 0; attempt < 4 && displayTitle(after) !== title; attempt++) {
    await delay(1500);
    after = await fetchCanvasModelOrFallback(workspace, canvasId, title);
  }
  const verified =
    displayTitle(after) === title &&
    (markdown.trim() ? desiredWriteReached(after, "replace", markdown) : true);
  if (!verified) {
    process.exitCode = 1;
  }
  const file = await canvasDeps.canvasInfo(workspace, canvasId);
  writeOutput({
    ok: verified,
    canvas: compactCanvasFile(workspace, file),
    canvas_id: canvasId,
    title,
    idempotency_key: key,
    result: { status: "updated", verified },
    response: created,
    private_request: privateRequest,
  });
}

async function commandTitle(parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const title = requiredFlag(parsed, "--title").trim();
  if (!title) {
    throw new Error("title set requires --title");
  }
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const key = idempotencyKey("title.set", target.canvasId, title);
  if (displayTitle(before) === title) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const firstH1 = before.sections.find((section) => section.type === "h1");
  let privateRequest: unknown;
  if (firstH1) {
    const index = before.sections.findIndex((section) => section.id === firstH1.id);
    const previousSectionId = before.sections[index - 1]?.id;
    const nextSectionId = before.sections[index + 1]?.id;
    const deleted = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateSectionDeleteDocumentData({
        ...privateDocumentInput(latest, "", "replace"),
        sectionId: firstH1.id,
      }),
    );
    const afterDelete = await fetchCanvasModel(workspace, target.canvasId);
    const titlePosition = previousSectionId
      ? positionForPlacement(afterDelete, { after: previousSectionId })
      : nextSectionId
        ? positionForPlacement(afterDelete, { before: nextSectionId })
        : estimatedSectionPosition(0);
    privateRequest = {
      operations: [
        deleted,
        await performPrivateEdit(workspace, afterDelete, (latest) =>
          buildPrivateMarkdownDocumentData({
            ...privateDocumentInput(latest, `# ${title}`, "append"),
            position: titlePosition,
            title,
          }),
        ),
      ],
    };
  } else {
    privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateMarkdownDocumentData({
        ...privateDocumentInput(latest, `# ${title}`, "prepend"),
        title,
      }),
    );
  }
  const after = await fetchCanvasModel(workspace, target.canvasId);
  const verified = displayTitle(after) === title;
  if (!verified) {
    process.exitCode = 1;
  }
  writeOutput({
    ok: verified,
    canvas_id: target.canvasId,
    title,
    idempotency_key: key,
    result: { status: "updated", verified },
    private_request: privateRequest,
  });
}

async function commandDelete(parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 1, "canvas"));
  const confirm = requiredFlag(parsed, "--confirm");
  if (confirm !== target.canvasId) {
    throw new CanvasCommandError(
      "confirmation_mismatch",
      "delete requires --confirm to match the canvas id",
    );
  }
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const key = idempotencyKey("delete", target.canvasId);
  const before = await fetchCanvasModelMaybe(workspace, target.canvasId);
  if (!before) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const response = await canvasDeps.deleteCanvas(workspace, target.canvasId);
  const after = await fetchCanvasModelMaybe(workspace, target.canvasId);
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    idempotency_key: key,
    result: { status: "updated", verified: after == null },
    response,
  });
}

async function commandValidate(parsed: ParsedArgs): Promise<void> {
  const source = value(parsed, "--from") ?? requiredPositional(parsed, 1, "markdown-file");
  const markdown = await readTextArg(source);
  const blocks = parsePrivateMarkdownBlocks(markdown);
  const inspection = inspectCanvasMarkdown(markdown);
  writeOutput({
    ok: inspection.issues.length === 0,
    features: [...new Set([...inspection.features, ...blocks.map((block) => block.kind)])].sort(),
    issues: inspection.issues,
    blocks,
  });
}

async function commandWrite(
  parsed: ParsedArgs,
  operation: "append" | "prepend" | "replace",
): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 1, "canvas"));
  const markdown = await readTextArg(requiredFlag(parsed, "--from"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const key = idempotencyKey(operation, target.canvasId, markdown);
  if (desiredWriteReached(before, operation, markdown)) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      operation,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const privateRequest =
    operation === "replace"
      ? await replaceCanvasBody(workspace, before, markdown)
      : await performPrivateEdit(workspace, before, (latest) =>
          buildPrivateMarkdownDocumentData(privateDocumentInput(latest, markdown, operation)),
        );
  const after = await fetchCanvasModel(workspace, target.canvasId);
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    operation,
    idempotency_key: key,
    result: mutationResult("updated", verifyWrite(after, operation, markdown)),
    private_request: privateRequest,
  });
}

async function commandSection(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (subcommand === "list") {
    const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
    const workspace = await canvasDeps.resolveCanvasWorkspace(
      target.workspaceUrl ?? activeGlobals.workspace,
    );
    const result = await canvasDeps.readCanvas(workspace, target.canvasId);
    const sections = result.html ? extractCanvasSections(result.html) : [];
    writeOutput(
      {
        ok: true,
        sections,
        meta: buildPaginationMeta({
          total: sections.length,
          returned: sections.length,
          page: 1,
          perPage: sections.length || 1,
        }),
      },
      { collection: true },
    );
    return;
  }
  if (subcommand === "insert") {
    const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
    const markdown = await readTextArg(requiredFlag(parsed, "--from"));
    const beforeId = value(parsed, "--before");
    const afterId = value(parsed, "--after");
    if ((beforeId ? 1 : 0) + (afterId ? 1 : 0) !== 1) {
      throw new Error("section insert requires exactly one of --before or --after");
    }
    const workspace = await canvasDeps.resolveCanvasWorkspace(
      target.workspaceUrl ?? activeGlobals.workspace,
    );
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const key = idempotencyKey("section.insert", target.canvasId, markdown, {
      before: beforeId,
      after: afterId,
    });
    if (sectionInsertionReached(before, markdown, beforeId, afterId)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const position = positionForPlacement(
      before,
      beforeId ? { before: beforeId } : { after: afterId! },
    );
    const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateMarkdownDocumentData({
        ...privateDocumentInput(latest, markdown, "append"),
        position,
      }),
    );
    const after = await fetchCanvasModel(workspace, target.canvasId);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: mutationResult("updated", verifySectionInsertion(after, markdown, beforeId, afterId)),
      private_request: privateRequest,
    });
    return;
  }
  if (subcommand === "replace") {
    const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
    const sectionId = requiredFlag(parsed, "--section");
    const markdown = await readTextArg(requiredFlag(parsed, "--from"));
    const workspace = await canvasDeps.resolveCanvasWorkspace(
      target.workspaceUrl ?? activeGlobals.workspace,
    );
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const key = idempotencyKey("section.replace", target.canvasId, markdown, {
      section: sectionId,
    });
    if (sectionText(before, sectionId) === normalizedMarkdown(markdown)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        section_id: sectionId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const index = before.sections.findIndex((section) => section.id === sectionId);
    if (index < 0) {
      throw new CanvasCommandError("section_not_found", `section not found: ${sectionId}`);
    }
    const previousSectionId = before.sections[index - 1]?.id;
    const nextSectionId = before.sections[index + 1]?.id;
    const deleted = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateSectionDeleteDocumentData({
        ...privateDocumentInput(latest, "", "replace"),
        sectionId,
      }),
    );
    const afterDelete = await fetchCanvasModel(workspace, target.canvasId);
    const replacementPosition = previousSectionId
      ? positionForPlacement(afterDelete, { after: previousSectionId })
      : nextSectionId
        ? positionForPlacement(afterDelete, { before: nextSectionId })
        : estimatedSectionPosition(0);
    const privateRequest = {
      operations: [
        deleted,
        await performPrivateEdit(workspace, afterDelete, (latest) =>
          buildPrivateMarkdownDocumentData({
            ...privateDocumentInput(latest, markdown, "append"),
            position: replacementPosition,
          }),
        ),
      ],
    };
    const after = await fetchCanvasModel(workspace, target.canvasId);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      section_id: sectionId,
      idempotency_key: key,
      result: mutationResult("updated", verifySectionReplacement(after, sectionId, markdown)),
      private_request: privateRequest,
    });
    return;
  }
  if (subcommand === "delete") {
    const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
    const sectionId = requiredFlag(parsed, "--section");
    const workspace = await canvasDeps.resolveCanvasWorkspace(
      target.workspaceUrl ?? activeGlobals.workspace,
    );
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const key = idempotencyKey("section.delete", target.canvasId, undefined, {
      section: sectionId,
    });
    if (!before.sections.some((section) => section.id === sectionId)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        section_id: sectionId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateSectionDeleteDocumentData({
        ...privateDocumentInput(latest, "", "replace"),
        sectionId,
      }),
    );
    const after = await fetchCanvasModel(workspace, target.canvasId);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      section_id: sectionId,
      idempotency_key: key,
      result: {
        status: "updated",
        verified: !after.sections.some((section) => section.id === sectionId),
      },
      private_request: privateRequest,
    });
    return;
  }
  throw new Error("section requires list, insert, replace, or delete");
}

async function commandTable(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (subcommand !== "insert" && subcommand !== "replace") {
    throw new Error("table requires insert or replace");
  }
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const rows = parseTableRows(await readTextArg(requiredFlag(parsed, "--from")));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const tableTarget = value(parsed, "--table") ?? value(parsed, "--section");
  const afterAnchor = value(parsed, "--after");
  const key = idempotencyKey(`table.${subcommand}`, target.canvasId, JSON.stringify(rows), {
    table: tableTarget,
    after: afterAnchor,
  });
  if (tableRowsReached(before, rows)) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const position =
    subcommand === "replace" && tableTarget
      ? tableReplacementPosition(before, tableTarget)
      : afterAnchor
        ? positionForPlacement(before, { after: afterAnchor })
        : undefined;
  let insertedTableId = tableTarget;
  let pendingTableFill: Buffer | undefined;
  const deleteRequests: Record<string, unknown>[] = [];
  if (subcommand === "replace" && tableTarget) {
    for (const sectionId of tableReplacementDeleteSectionIds(before, tableTarget)) {
      deleteRequests.push(
        await performPrivateEdit(workspace, before, (latest) =>
          buildPrivateSectionDeleteDocumentData({
            ...privateDocumentInput(latest, "", "replace"),
            sectionId,
          }),
        ),
      );
    }
  }
  const privateRequest =
    subcommand === "replace" && tableTarget
      ? {
          operations: [
            ...deleteRequests,
            await performPrivateEdit(workspace, before, (latest) => {
              const mutation = buildPrivateTableDocumentMutation({
                ...privateDocumentInput(latest, "", "append"),
                rows,
                position,
              });
              insertedTableId = mutation.tableId;
              pendingTableFill = mutation.fillData;
              return mutation.data;
            }),
            ...(pendingTableFill
              ? [await performPrivateEdit(workspace, before, () => pendingTableFill!)]
              : []),
          ],
        }
      : await performPrivateEdit(workspace, before, (latest) => {
          const mutation = buildPrivateTableDocumentMutation({
            ...privateDocumentInput(latest, "", "append"),
            rows,
            position,
          });
          insertedTableId = mutation.tableId;
          pendingTableFill = mutation.fillData;
          return mutation.data;
        });
  const tableFillRequest =
    subcommand === "replace" && tableTarget
      ? undefined
      : pendingTableFill
        ? await performPrivateEdit(workspace, before, () => pendingTableFill!)
        : undefined;
  const after = await fetchCanvasModel(workspace, target.canvasId);
  const tableId = after.sections.find((section) => section.type === "table")?.id ?? insertedTableId;
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    table_id: tableId,
    section_id: tableId,
    idempotency_key: key,
    rows: rows.length,
    columns: rows[0]?.length ?? 0,
    result: mutationResult("updated", verifyTableRows(after, rows)),
    private_request: tableFillRequest
      ? { operations: [privateRequest, tableFillRequest] }
      : privateRequest,
  });
}

async function commandMention(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (subcommand === "resolve") {
    const user = value(parsed, "--user");
    const channel = value(parsed, "--channel");
    if ((user ? 1 : 0) + (channel ? 1 : 0) !== 1) {
      throw new Error("mention resolve requires exactly one of --user or --channel");
    }
    const query = user ?? channel!;
    const workspace = await canvasDeps.resolveCanvasWorkspace(activeGlobals.workspace);
    const payload = channel
      ? await canvasDeps.slackApi(workspace, "conversations.info", {
          channel: query.replace(/^#/, ""),
        })
      : await resolveSlackUser(workspace, query);
    writeOutput({ ok: true, query, response: payload });
    return;
  }
  if (subcommand !== "insert") {
    throw new Error("mention requires resolve or insert");
  }
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const user = value(parsed, "--user");
  const channel = value(parsed, "--channel");
  if ((user ? 1 : 0) + (channel ? 1 : 0) !== 1) {
    throw new Error("mention insert requires exactly one of --user or --channel");
  }
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const resolvedUser = user
    ? userIdFromUserPayload(await resolveSlackUser(workspace, user))
    : undefined;
  const mentionId = resolvedUser ?? channel!;
  const markdown = resolvedUser ? `<@${resolvedUser}>` : `<#${channel}>`;
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const position = positionForPlacementFromParsed(before, parsed, true);
  const key = idempotencyKey("mention.insert", target.canvasId, markdown, { position });
  if (before.markdown.includes(mentionId)) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
    buildPrivateMarkdownDocumentData({
      ...privateDocumentInput(latest, markdown, "append"),
      position,
    }),
  );
  const after = await fetchCanvasModel(workspace, target.canvasId);
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    idempotency_key: key,
    result: mutationResult("updated", {
      verified: after.markdown.includes(mentionId),
      note: after.markdown.includes(mentionId) ? undefined : { expected_mention: mentionId },
    }),
    private_request: privateRequest,
  });
}

async function commandDate(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (subcommand !== "insert") {
    throw new Error("date requires insert");
  }
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const dateValue = requiredFlag(parsed, "--date");
  const timestamp = parseDateFlag(dateValue);
  const fallback = value(parsed, "--fallback") ?? dateValue;
  const format = value(parsed, "--date-format") ?? "{date_short}";
  const markdown = `<!date^${timestamp}^${format}|${fallback}>`;
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const position = positionForPlacementFromParsed(before, parsed, false);
  const key = idempotencyKey("date.insert", target.canvasId, markdown, { position });
  if (dateInsertionReached(before, timestamp, fallback)) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
    buildPrivateMarkdownDocumentData({
      ...privateDocumentInput(latest, markdown, "append"),
      position,
    }),
  );
  const after = await fetchCanvasModel(workspace, target.canvasId);
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    date: dateValue,
    idempotency_key: key,
    result: mutationResult("updated", verifyDateInsertion(after, timestamp, fallback)),
    private_request: privateRequest,
  });
}

async function commandEmbed(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (subcommand === "list") {
    const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
    const workspace = await canvasDeps.resolveCanvasWorkspace(
      target.workspaceUrl ?? activeGlobals.workspace,
    );
    const model = await fetchCanvasModel(workspace, target.canvasId);
    const strings = await fetchCurrentCanvasStrings(workspace, model);
    const embeds = collectCanvasEmbeds(workspace, model, strings);
    writeOutput(
      {
        ok: true,
        embeds,
        meta: buildPaginationMeta({
          total: embeds.length,
          returned: embeds.length,
          page: 1,
          perPage: embeds.length || 1,
        }),
      },
      { collection: true },
    );
    return;
  }
  if (subcommand === "remove") {
    const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
    const embed = value(parsed, "--embed") ?? value(parsed, "--section");
    if (!embed) {
      throw new CanvasCommandError("missing_embed", "Missing --embed");
    }
    const workspace = await canvasDeps.resolveCanvasWorkspace(
      target.workspaceUrl ?? activeGlobals.workspace,
    );
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const beforeStrings = await fetchCurrentCanvasStrings(workspace, before);
    const sectionId = sectionIdForEmbed(workspace, before, beforeStrings, embed);
    const key = idempotencyKey("embed.remove", target.canvasId, embed, { section: sectionId });
    if (!sectionId) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        embed_id: embed,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateSectionDeleteDocumentData({
        ...privateDocumentInput(latest, "", "replace"),
        sectionId,
      }),
    );
    const after = await fetchCanvasModel(workspace, target.canvasId);
    const afterStrings = await fetchCurrentCanvasStrings(workspace, after);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      embed_id: embed,
      section_id: sectionId,
      idempotency_key: key,
      result: mutationResult("updated", verifyEmbedRemoved(after, embed, afterStrings)),
      private_request: privateRequest,
    });
    return;
  }
  if (subcommand !== "add") {
    throw new Error("embed requires list, add, or remove");
  }
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const embedType = requiredFlag(parsed, "--type");
  const source = embedSource(parsed, embedType);
  if (
    (embedType === "image" || embedType === "file") &&
    source.flag === "--file" &&
    !existsSync(source.value)
  ) {
    throw new CanvasCommandError("missing_file", `Missing file: ${source.value}`);
  }
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const beforeStrings = await fetchCurrentCanvasStrings(workspace, before);
  const requestedPosition = positionForEmbedPlacementFromParsed(before, parsed);
  const sourceIdentity = await embedSourceIdentity(source);
  const key = idempotencyKey("embed.add", target.canvasId, sourceIdentity, {
    type: embedType,
    source: source.flag,
    position: requestedPosition,
  });
  const preUploadEmbedId =
    embedType === "canvas" ? (canvasIdFromEmbedSource(source.value) ?? source.value) : source.value;
  if (
    embedType === "file" &&
    (await mutationAlreadyRecorded(key, target.canvasId, before.file)) &&
    collectCanvasEmbeds(workspace, before, beforeStrings).some(
      (resource) => resource.type === "slack_file",
    )
  ) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  if (embedType !== "file" && embedReached(before, preUploadEmbedId, undefined, beforeStrings)) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      embed_id: preUploadEmbedId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const uploaded =
    (embedType === "image" || embedType === "file") && source.flag === "--file"
      ? await canvasDeps.uploadCanvasFile(workspace, source.value)
      : undefined;
  const embedValue = uploaded?.fileId ?? preUploadEmbedId;
  const storedValue = uploaded?.fileId ?? embedStoredValue(workspace, embedType, source.value);
  const markdown = embedMarkdown(
    embedType,
    storedValue,
    value(parsed, "--text") ?? uploaded?.title,
  );
  if (embedReached(before, embedValue, uploaded?.title, beforeStrings)) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const afterSectionId = embedAfterSection(parsed);
  const afterSection = afterSectionId
    ? before.sections.find((section) => section.id === afterSectionId)
    : undefined;
  const afterSectionIndex = afterSection
    ? before.sections.findIndex((section) => section.id === afterSection.id)
    : -1;
  const privateRequest = uploaded
    ? await performPrivateEdit(workspace, before, (latest) =>
        afterSection
          ? buildPrivateFileEmbedAfterSectionDocumentData({
              ...privateDocumentInput(latest, "", "append"),
              sectionId: afterSection.id,
              sectionText: afterSection.text,
              fileId: uploaded.fileId,
              title: uploaded.title,
              url: slackFileUrl(workspace, before, uploaded.fileId, uploaded.title),
              sectionPosition: estimatedSectionPosition(afterSectionIndex),
            })
          : buildPrivateFileEmbedDocumentData({
              ...privateDocumentInput(latest, "", "append"),
              fileId: uploaded.fileId,
              title: uploaded.title,
              url: slackFileUrl(workspace, before, uploaded.fileId, uploaded.title),
              position: requestedPosition,
            }),
      )
    : embedType === "canvas"
      ? await performPrivateEdit(workspace, before, (latest) =>
          buildPrivateCanvasEmbedDocumentData({
            ...privateDocumentInput(latest, "", "append"),
            canvasId: embedValue,
            url: storedValue,
            label: value(parsed, "--text"),
            position: requestedPosition,
          }),
        )
      : embedType === "message"
        ? await performPrivateEdit(workspace, before, (latest) => {
            const message = parseMessagePermalink(storedValue);
            if (!message) {
              throw new CanvasCommandError(
                "invalid_message",
                `Invalid Slack message URL: ${storedValue}`,
              );
            }
            return buildPrivateMessageEmbedDocumentData({
              ...privateDocumentInput(latest, "", "append"),
              channel: message.channel,
              ts: message.ts,
              url: storedValue,
              label: value(parsed, "--text"),
              position: requestedPosition,
            });
          })
        : await performPrivateEdit(workspace, before, (latest) =>
            buildPrivateMarkdownDocumentData({
              ...privateDocumentInput(latest, markdown, "append"),
              position: requestedPosition,
            }),
          );
  const after = await fetchCanvasModel(workspace, target.canvasId);
  const afterStrings = await fetchCurrentCanvasStrings(workspace, after);
  const embedResource = collectCanvasEmbeds(workspace, after, afterStrings).find((resource) =>
    resourceMatchesEmbed(resource, embedValue, uploaded?.title),
  );
  const embedSection = after.sections.find(
    (section) =>
      section.text.includes(uploaded?.title ?? embedValue) || section.text.includes(embedValue),
  );
  const verification = verifyEmbed(after, embedValue, uploaded?.title, afterStrings);
  if (verification.verified) {
    await recordMutation(key, target.canvasId, after.file);
  }
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    type: embedType,
    embed_id: embedValue,
    section_id: embedResource?.section_id ?? embedSection?.id,
    uploaded_file: uploaded,
    idempotency_key: key,
    result: mutationResult("updated", verification),
    private_request: privateRequest,
  });
}

async function commandComment(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  if (subcommand === "list") {
    const model = await fetchCanvasModel(workspace, target.canvasId);
    const explicitThreadTs = value(parsed, "--thread-ts") ?? value(parsed, "--ts");
    if (!explicitThreadTs && !model.fileThreadTs) {
      writeOutput(
        {
          ok: true,
          comments: model.comments,
          meta: buildPaginationMeta({
            total: model.comments.length,
            returned: model.comments.length,
            page: 1,
            perPage: model.comments.length || 1,
          }),
        },
        { collection: true },
      );
      return;
    }
    const threadTs = explicitThreadTs ?? model.fileThreadTs!;
    const payload = await canvasDeps.listCanvasComments(workspace, {
      channel: model.fileChannel,
      threadTs,
    });
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    writeOutput(
      {
        ok: true,
        comments: messages,
        meta: buildPaginationMeta({
          total: messages.length,
          returned: messages.length,
          page: 1,
          perPage: messages.length || 1,
        }),
      },
      { collection: true },
    );
    return;
  }
  if (subcommand === "add") {
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const span = resolveSpanTarget(before, parsed);
    const text = await readCommentText(parsed);
    const key = idempotencyKey("comment.add", target.canvasId, text, {
      anchor: span.anchorId,
      section: span.sectionId,
    });
    if (hasComment(before, span, text)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const thread = await openAnnotationThread(workspace, before, span);
    const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateAnnotationDocumentData({
        ...privateDocumentInput(latest, "", "append"),
        sectionId: span.sectionId,
        annotationId: span.anchorId,
        selectedText: span.selectedText,
        sectionText: sectionText(before, span.sectionId),
        editorUserId: latest.editorUserId,
        occurrence: span.occurrence,
        startOffset: span.startOffset,
      }),
    );
    if (thread.messages.some((message) => stringField(message, "text") === text)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
        private_request: privateRequest,
      });
      return;
    }
    const post = await canvasDeps.slackApi(workspace, "chat.postMessage", {
      channel: before.fileChannel,
      thread_ts: thread.threadTs,
      text,
      type: "message",
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
        },
      ],
      client_context_team_id: workspace.team_id,
      include_channel_perm_error: true,
      _x_reason: "canvas-comment-add",
      _x_mode: "online",
      _x_sonic: true,
      _x_app_name: "client",
    });
    const commentTs = stringField(post, "ts") ?? thread.threadTs;
    const sync = await canvasDeps.slackApi(workspace, "quip.thread.synchronize", {
      channel_id: before.fileChannel,
      thread_ts: thread.threadTs,
      _x_reason: "synchronize-archive-state",
      _x_mode: "online",
      _x_sonic: true,
      _x_app_name: "client",
    });
    const after = await fetchCanvasModel(workspace, target.canvasId);
    const afterThread = await loadCommentThread(workspace, before, thread.threadTs);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      thread_ts: thread.threadTs,
      comment_ts: commentTs,
      idempotency_key: key,
      result: mutationResult("updated", verifyComment(after, afterThread.messages, span, text)),
      private_request: privateRequest,
      response: post,
      synchronize: sync,
    });
    return;
  }
  if (subcommand === "resolve") {
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const inputTs =
      value(parsed, "--thread-ts") ?? value(parsed, "--comment") ?? parsed.positionals[1];
    if (!inputTs) {
      throw new Error("comment resolve requires --thread-ts or --comment");
    }
    const key = idempotencyKey("comment.resolve", target.canvasId, inputTs);
    const thread = await loadCommentThread(workspace, before, inputTs);
    if (commentThreadArchived(thread.messages) || threadResolved(before, thread.threadTs)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        thread_ts: thread.threadTs,
        comment_ts: inputTs,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const response = await canvasDeps.slackApi(workspace, "quip.thread.archive", {
      channel_id: before.fileChannel,
      thread_ts: thread.threadTs,
      _x_reason: "canvas-comment-resolve",
    });
    const sync = await canvasDeps.slackApi(workspace, "quip.thread.synchronize", {
      channel_id: before.fileChannel,
      thread_ts: thread.threadTs,
    });
    const afterThread = await loadCommentThread(workspace, before, thread.threadTs);
    const verified =
      commentThreadArchived(afterThread.messages) ||
      commentThreadArchived(recordArray(response.message)) ||
      Boolean(response.ok ?? true);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      thread_ts: thread.threadTs,
      comment_ts: inputTs,
      idempotency_key: key,
      result: { status: "updated", verified },
      response,
      synchronize: sync,
    });
    return;
  }
  throw new Error("comment requires list, add, or resolve");
}

async function commandReact(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  if (subcommand === "list") {
    const model = await fetchCanvasModel(workspace, target.canvasId);
    const explicitThreadTs = value(parsed, "--timestamp") ?? value(parsed, "--thread-ts");
    const reactions = explicitThreadTs
      ? normalizeReactionPayload(
          await canvasDeps.canvasReactions(workspace, {
            channel: model.fileChannel,
            timestamp: explicitThreadTs,
          }),
          { threadTs: explicitThreadTs },
        )
      : await listCanvasContentReactions(workspace, model, parsed);
    writeOutput(
      {
        ok: true,
        reactions,
        meta: buildPaginationMeta({
          total: reactions.length,
          returned: reactions.length,
          page: 1,
          perPage: reactions.length || 1,
        }),
      },
      { collection: true },
    );
    return;
  }
  if (subcommand !== "add" && subcommand !== "remove") {
    throw new Error("react requires list, add, or remove");
  }
  const before = await fetchCanvasModel(workspace, target.canvasId);
  const emoji = stripEmojiColons(requiredFlag(parsed, "--emoji"));
  const span = resolveSpanTarget(before, parsed);
  const key = idempotencyKey(`react.${subcommand}`, target.canvasId, emoji, {
    anchor: span.anchorId,
    section: span.sectionId,
  });
  const thread = await openAnnotationThread(workspace, before, span);
  const reactionAlreadyPresent = await canvasReactionPresent(
    workspace,
    before,
    thread.threadTs,
    emoji,
    span,
  );
  if (subcommand === "add" && reactionAlreadyPresent) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      emoji,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  if (subcommand === "remove" && !reactionAlreadyPresent) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      emoji,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const method = subcommand === "add" ? "reactions.add" : "reactions.remove";
  const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
    buildPrivateAnnotationDocumentData({
      ...privateDocumentInput(latest, "", "append"),
      sectionId: span.sectionId,
      annotationId: span.anchorId,
      selectedText: span.selectedText,
      sectionText: sectionText(before, span.sectionId),
      editorUserId: latest.editorUserId,
      occurrence: span.occurrence,
      startOffset: span.startOffset,
    }),
  );
  let response: Record<string, unknown>;
  try {
    response = await canvasDeps.slackApi(workspace, method, {
      channel: before.fileChannel,
      timestamp: thread.threadTs,
      name: emoji,
      _x_reason: "changeReactionFromUserAction",
      _x_mode: "online",
      _x_sonic: true,
      _x_app_name: "client",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (subcommand === "add" && /already_reacted/.test(message)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        emoji,
        idempotency_key: key,
        result: { status: "noop", verified: true },
        private_request: privateRequest,
      });
      return;
    }
    if (subcommand === "remove" && /no_reaction|message_not_found/.test(message)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        emoji,
        idempotency_key: key,
        result: { status: "noop", verified: true },
        private_request: privateRequest,
      });
      return;
    }
    throw error;
  }
  const verified =
    subcommand === "add"
      ? await canvasReactionPresent(workspace, before, thread.threadTs, emoji, span)
      : !(await canvasReactionPresent(workspace, before, thread.threadTs, emoji, span));
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    emoji,
    idempotency_key: key,
    result: mutationResult("updated", {
      verified,
      note: verified ? undefined : { expected_reaction: emoji, thread_ts: thread.threadTs },
    }),
    private_request: privateRequest,
    response,
  });
}

async function commandAccess(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  if (subcommand === "show") {
    const [file, shares, metadata] = await Promise.all([
      canvasDeps.canvasInfo(workspace, target.canvasId),
      canvasDeps.canvasShares(workspace, target.canvasId),
      canvasDeps.canvasAccessMetadata(workspace, target.canvasId),
    ]);
    const accessDetails = { shares, metadata };
    const grants = extractAccessGrants(file, accessDetails);
    const workspaceAccess = currentAccessLevel(file);
    writeOutput(
      {
        ok: true,
        canvas: compactCanvasFile(workspace, file),
        workspace_access: workspaceAccess,
        grants,
        shares,
        metadata,
        meta: buildPaginationMeta({
          total: grants.length,
          returned: grants.length,
          page: 1,
          perPage: grants.length || 1,
        }),
      },
      { collection: true },
    );
    return;
  }
  if (subcommand === "set") {
    const before = await fetchCanvasModel(workspace, target.canvasId);
    const level = accessLevel(
      value(parsed, "--level") ?? requiredPositional(parsed, 1, "level"),
      true,
    );
    const desired = level === "write" ? "write" : level === "read" ? "read" : "invitation";
    const key = idempotencyKey("access.set", target.canvasId, undefined, { level: desired });
    if (currentAccessLevel(before.file) === desired) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        level,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const response = await canvasDeps.setWorkspaceCanvasAccess(workspace, {
      canvasId: target.canvasId,
      level: desired,
    });
    const after = await fetchCanvasModel(workspace, target.canvasId);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      level,
      idempotency_key: key,
      result: mutationResult("updated", verifyAccessLevel(after.file, desired)),
      response,
    });
    return;
  }
  if (subcommand === "grant") {
    const beforeFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
    const beforeShares = await canvasDeps.canvasShares(workspace, target.canvasId);
    const beforeMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
    const level = accessLevel(value(parsed, "--level") ?? "read", false);
    const accessTarget = await resolveAccessTarget(workspace, parsed);
    const key = idempotencyKey("access.grant", target.canvasId, undefined, {
      target: accessTarget.id,
      channel: accessTarget.channel,
      level,
    });
    if (
      accessGrantReached(
        beforeFile,
        { shares: beforeShares, metadata: beforeMetadata },
        accessTarget,
        level,
      )
    ) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        target: accessTarget.id,
        channel: accessTarget.channel,
        level,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const response =
      accessTarget.kind === "user" &&
      accessGrantReached(
        beforeFile,
        { shares: beforeShares, metadata: beforeMetadata },
        accessTarget,
      )
        ? await canvasDeps.updateCanvasUserPermission(workspace, {
            canvasId: target.canvasId,
            userId: accessTarget.id,
            level,
            teamId: teamIdFromFile(beforeFile),
          })
        : await canvasDeps.shareCanvas(workspace, {
            canvasId: target.canvasId,
            channel: accessTarget.channel,
            grant: level,
            silent: bool(parsed, "--silent"),
          });
    let afterFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
    let afterShares = await canvasDeps.canvasShares(workspace, target.canvasId);
    let afterMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
    let verification = verifyAccessGrant(
      afterFile,
      { shares: afterShares, metadata: afterMetadata },
      accessTarget,
      level,
    );
    if (!verification.verified) {
      await delay(2000);
      afterFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
      afterShares = await canvasDeps.canvasShares(workspace, target.canvasId);
      afterMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
      verification = verifyAccessGrant(
        afterFile,
        { shares: afterShares, metadata: afterMetadata },
        accessTarget,
        level,
      );
    }
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      target: accessTarget.id,
      channel: accessTarget.channel,
      level,
      idempotency_key: key,
      result: mutationResult("updated", verification),
      response,
    });
    return;
  }
  if (subcommand === "revoke") {
    const beforeFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
    const beforeShares = await canvasDeps.canvasShares(workspace, target.canvasId);
    const beforeMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
    const accessTarget = await resolveAccessTarget(workspace, parsed);
    const key = idempotencyKey("access.revoke", target.canvasId, undefined, {
      target: accessTarget.id,
      channel: accessTarget.channel,
    });
    if (
      !accessGrantReached(
        beforeFile,
        { shares: beforeShares, metadata: beforeMetadata },
        accessTarget,
      )
    ) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        target: accessTarget.id,
        channel: accessTarget.channel,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const response =
      accessTarget.kind === "user"
        ? await canvasDeps.revokeCanvasUserPermission(workspace, {
            canvasId: target.canvasId,
            userId: accessTarget.id,
            teamId: teamIdFromFile(beforeFile),
          })
        : await canvasDeps.revokeCanvasShare(workspace, {
            canvasId: target.canvasId,
            channel: accessTarget.channel,
          });
    let afterFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
    let afterShares = await canvasDeps.canvasShares(workspace, target.canvasId);
    let afterMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
    let verification = verifyAccessRevoked(
      afterFile,
      { shares: afterShares, metadata: afterMetadata },
      accessTarget,
    );
    if (!verification.verified) {
      await delay(2000);
      afterFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
      afterShares = await canvasDeps.canvasShares(workspace, target.canvasId);
      afterMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
      verification = verifyAccessRevoked(
        afterFile,
        { shares: afterShares, metadata: afterMetadata },
        accessTarget,
      );
    }
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      target: accessTarget.id,
      channel: accessTarget.channel,
      idempotency_key: key,
      result: mutationResult("updated", verification),
      response,
    });
    return;
  }
  throw new Error("access requires show, set, grant, or revoke");
}

async function commandShare(parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 1, "canvas"));
  const channel = requiredFlag(parsed, "--channel");
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const beforeFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
  const beforeShares = await canvasDeps.canvasShares(workspace, target.canvasId);
  const beforeMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
  const level = accessLevel(value(parsed, "--level") ?? "write", false);
  const accessTarget: AccessTarget = { kind: "channel", id: channel, channel };
  const key = idempotencyKey("share", target.canvasId, undefined, {
    channel,
    level,
    silent: bool(parsed, "--silent"),
  });
  if (
    accessGrantReached(
      beforeFile,
      { shares: beforeShares, metadata: beforeMetadata },
      accessTarget,
      level,
    )
  ) {
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      channel,
      level,
      idempotency_key: key,
      result: { status: "noop", verified: true },
    });
    return;
  }
  const response = await canvasDeps.shareCanvas(workspace, {
    canvasId: target.canvasId,
    channel,
    grant: level,
    silent: bool(parsed, "--silent"),
  });
  let afterFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
  let afterShares = await canvasDeps.canvasShares(workspace, target.canvasId);
  let afterMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
  let verification = verifyAccessGrant(
    afterFile,
    { shares: afterShares, metadata: afterMetadata },
    accessTarget,
    level,
  );
  if (!verification.verified) {
    await delay(2000);
    afterFile = await canvasDeps.canvasInfo(workspace, target.canvasId);
    afterShares = await canvasDeps.canvasShares(workspace, target.canvasId);
    afterMetadata = await canvasDeps.canvasAccessMetadata(workspace, target.canvasId);
    verification = verifyAccessGrant(
      afterFile,
      { shares: afterShares, metadata: afterMetadata },
      accessTarget,
      level,
    );
  }
  writeOutput({
    ok: true,
    canvas_id: target.canvasId,
    channel,
    level,
    idempotency_key: key,
    result: mutationResult("updated", verification),
    response,
  });
}

async function commandCover(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  if (subcommand === "list") {
    const workspace = await canvasDeps.resolveCanvasWorkspace(activeGlobals.workspace);
    const payload = await canvasDeps.slackApi(workspace, "canvases.listHeaders", {
      _x_reason: "canvas-header-images",
    });
    const headers = normalizeHeaders(payload);
    writeOutput(
      {
        ok: true,
        headers,
        meta: buildPaginationMeta({
          total: headers.length,
          returned: headers.length,
          page: 1,
          perPage: headers.length || 1,
        }),
      },
      { collection: true },
    );
    return;
  }
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  if (subcommand === "set") {
    const headerId =
      value(parsed, "--header-id") ??
      (await resolveHeaderId(workspace, requiredFlag(parsed, "--cover")));
    const key = idempotencyKey("cover.set", target.canvasId, headerId);
    const beforeLoadData = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
      canvasId: target.canvasId,
      threadId: before.threadId,
    });
    if (
      currentCoverId(before.file) === headerId ||
      coverIdFromStrings(beforeLoadData, [headerId]) === headerId
    ) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        header_id: headerId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const titleSectionId = titleSectionIdForCover(before);
    const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateCoverDocumentData({
        ...privateDocumentInput(latest, "", "replace"),
        titleSectionId,
        headerId,
      }),
    );
    const after = await fetchCanvasModel(workspace, target.canvasId);
    let loadData = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
      canvasId: target.canvasId,
      threadId: after.threadId,
      forceRefresh: true,
    });
    let verification = verifyCover(after.file, headerId, loadData);
    if (!verification.verified) {
      await delay(2000);
      loadData = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
        canvasId: target.canvasId,
        threadId: after.threadId,
        forceRefresh: true,
      });
      verification = verifyCover(after.file, headerId, loadData);
    }
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      header_id: headerId,
      idempotency_key: key,
      result: mutationResult("updated", verification),
      private_request: privateRequest,
    });
    return;
  }
  if (subcommand === "clear") {
    const key = idempotencyKey("cover.clear", target.canvasId);
    const headers = await canvasHeaders(workspace);
    const headerIds = headers.map((header) => header.id);
    const beforeLoadData = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
      canvasId: target.canvasId,
      threadId: before.threadId,
    });
    if (!currentCoverId(before.file) && !coverIdFromStrings(beforeLoadData, headerIds)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const titleSectionId = titleSectionIdForCover(before);
    const privateRequest = await performPrivateEdit(workspace, before, (latest) =>
      buildPrivateCoverDocumentData({
        ...privateDocumentInput(latest, "", "replace"),
        titleSectionId,
        clear: true,
      }),
    );
    const after = await fetchCanvasModel(workspace, target.canvasId);
    let loadData = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
      canvasId: target.canvasId,
      threadId: after.threadId,
      forceRefresh: true,
    });
    let verification = verifyCoverCleared(after.file, loadData, headerIds);
    if (!verification.verified) {
      await delay(2000);
      loadData = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
        canvasId: target.canvasId,
        threadId: after.threadId,
        forceRefresh: true,
      });
      verification = verifyCoverCleared(after.file, loadData, headerIds);
    }
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      idempotency_key: key,
      result: mutationResult("updated", verification),
      private_request: privateRequest,
    });
    return;
  }
  throw new Error("cover requires list, set, or clear");
}

async function commandFavorite(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  const target = targetFromArg(requiredPositional(parsed, 0, "canvas"));
  const workspace = await canvasDeps.resolveCanvasWorkspace(
    target.workspaceUrl ?? activeGlobals.workspace,
  );
  const before = await fetchCanvasModel(workspace, target.canvasId);
  if (subcommand === "set") {
    const key = idempotencyKey("favorite.set", target.canvasId);
    if (isStarred(before.file)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const response = await canvasDeps.addCanvasStar(workspace, target.canvasId);
    const after = await fetchCanvasModel(workspace, target.canvasId);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      favorite: true,
      idempotency_key: key,
      result: {
        status: "updated",
        verified: isStarred(after.file) || Boolean(response.ok ?? true),
      },
      response,
    });
    return;
  }
  if (subcommand === "clear") {
    const key = idempotencyKey("favorite.clear", target.canvasId);
    if (!isStarred(before.file)) {
      writeOutput({
        ok: true,
        canvas_id: target.canvasId,
        idempotency_key: key,
        result: { status: "noop", verified: true },
      });
      return;
    }
    const response = await canvasDeps.removeCanvasStar(workspace, target.canvasId);
    const after = await fetchCanvasModel(workspace, target.canvasId);
    writeOutput({
      ok: true,
      canvas_id: target.canvasId,
      favorite: false,
      idempotency_key: key,
      result: {
        status: "updated",
        verified: !isStarred(after.file) || Boolean(response.ok ?? true),
      },
      response,
    });
    return;
  }
  throw new Error("favorite requires set or clear");
}

async function fetchCanvasModel(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<CanvasModel> {
  const result = await canvasDeps.readCanvas(workspace, canvasId);
  const { file } = result;
  const threadId = stringValue(file.quip_thread_id) ?? stringValue(file.thread_ts) ?? canvasId;
  const docId =
    stringValue(file.document_id) ??
    stringValue(file.canvas_document_id) ??
    stringValue(file.quip_document_id) ??
    threadId;
  const htmlSections = result.html ? extractCanvasSections(result.html) : [];
  const sections = htmlSections.length ? htmlSections : sectionsFromMarkdown(result.markdown);
  const title =
    sections.find((section) => section.type === "h1")?.text ??
    stringValue(file.title) ??
    stringValue(file.name) ??
    "";
  const resources = result.html ? extractCanvasResources(result.html) : [];
  const fileThread = extractCanvasFileThread(file);
  const fileChannel =
    fileThread?.channel ??
    stringValue(file.file_channel_id) ??
    stringValue(file.channel_id) ??
    fileChannelFromCanvasId(canvasId);
  return {
    canvasId,
    file,
    markdown: result.markdown ?? "",
    html: result.html,
    title,
    threadId,
    docId,
    sequence:
      numberValue(file.sequence) ??
      numberValue(file.edit_sequence) ??
      numberValue(file.updated) ??
      Date.now(),
    session: stableSessionId(canvasId, docId),
    jsClientHash: DEFAULT_JS_CLIENT_HASH,
    editorUserId: stringValue(file.user) ?? "",
    fileChannel,
    fileThreadTs: fileThread?.ts,
    sections,
    resources,
    comments: arrayValue(file.comments),
    reactions: arrayValue(file.reactions),
  };
}

async function fetchCanvasModelMaybe(
  workspace: CanvasWorkspace,
  canvasId: string,
): Promise<CanvasModel | undefined> {
  try {
    return await fetchCanvasModel(workspace, canvasId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not_found|file_not_found|file_deleted|deleted|missing/i.test(message)) {
      return undefined;
    }
    throw error;
  }
}

async function fetchCanvasModelOrFallback(
  workspace: CanvasWorkspace,
  canvasId: string,
  title: string,
): Promise<CanvasModel> {
  try {
    return await fetchCanvasModel(workspace, canvasId);
  } catch {
    const file: CanvasFile = { id: canvasId, title, quip_thread_id: canvasId };
    return {
      canvasId,
      file,
      markdown: "",
      title,
      threadId: canvasId,
      docId: canvasId,
      sequence: Date.now(),
      session: stableSessionId(canvasId, canvasId),
      jsClientHash: DEFAULT_JS_CLIENT_HASH,
      editorUserId: stringValue(file.user) ?? "",
      fileChannel: fileChannelFromCanvasId(canvasId),
      sections: [],
      resources: [],
      comments: [],
      reactions: [],
    };
  }
}

function privateDocumentInput(
  model: CanvasModel,
  markdown: string,
  operation: "append" | "prepend" | "replace",
) {
  return {
    threadId: model.threadId,
    docId: model.docId,
    title: model.title,
    markdown,
    sequence: model.sequence,
    operation,
    position:
      operation === "append"
        ? estimatedSectionPosition(model.sections.length)
        : operation === "prepend"
          ? "aaZ:temp"
          : undefined,
  };
}

async function replaceCanvasBody(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  markdown: string,
): Promise<Record<string, unknown>> {
  const requests: Record<string, unknown>[] = [];
  for (const section of model.sections) {
    requests.push(
      await performPrivateEdit(workspace, model, (latest) =>
        buildPrivateSectionDeleteDocumentData({
          ...privateDocumentInput(latest, "", "replace"),
          sectionId: section.id,
        }),
      ),
    );
  }
  requests.push(
    await performPrivateEdit(workspace, model, (latest) =>
      buildPrivateMarkdownDocumentData(privateDocumentInput(latest, markdown, "append")),
    ),
  );
  return { operations: requests };
}

async function performPrivateEdit(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  buildData: (latest: CanvasModel) => Buffer,
): Promise<Record<string, unknown>> {
  let forceRefresh = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await withLatestEditContext(workspace, model, forceRefresh);
    const data = buildData(latest);
    const body = buildEditDocumentBody(latest, data);
    try {
      const response = await canvasDeps.privateCanvasPost(workspace, EDIT_DOCUMENT_PATH, body);
      return {
        path: EDIT_DOCUMENT_PATH,
        data_binary_bytes: data.length,
        encoded_strings: allProtoStrings(decodeProto(data)).slice(0, 20),
        response_bytes: response.length,
        sequence: latest.sequence,
        session: latest.session,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /HTTP 409/.test(message)) {
        forceRefresh = true;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Private Canvas edit failed after session refresh");
}

async function withLatestEditContext(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  forceRefresh: boolean,
): Promise<CanvasModel> {
  const context: CanvasEditContext = await canvasDeps.loadCanvasEditContext(workspace, {
    canvasId: model.canvasId,
    threadId: model.threadId,
    forceRefresh,
  });
  return {
    ...model,
    threadId: context.threadId,
    docId: context.docId,
    sequence: context.sequence,
    session: context.session,
    jsClientHash: context.jsClientHash,
    editorUserId: context.userId,
  };
}

function buildEditDocumentBody(model: CanvasModel, data: Buffer): URLSearchParams {
  const now = Date.now();
  const body = new URLSearchParams();
  body.set("_csrf", "undefined");
  body.set("_js_client_hash", model.jsClientHash ?? DEFAULT_JS_CLIENT_HASH);
  body.set("_js_request_id", `agent-slack-${now}`);
  body.set("_js_request_time", String(now));
  body.set("_js_request_time_ms", String(now));
  body.set("_resource_bundle", "collab_controller");
  body.set("_user_id", model.editorUserId);
  body.set("_version", "10");
  body.set("_window_session_id", model.session);
  body.set("data_binary", data.toString("base64"));
  body.set("document", model.docId);
  body.set("nav_action_id", "null");
  body.set("retry_count", "0");
  body.set("search_session_id", "null");
  body.set("secret_path", "");
  body.set("sequence", String(model.sequence));
  body.set("session", model.session);
  body.set("thread", model.threadId);
  body.set("title", model.title);
  return body;
}

function resolveSpanTarget(model: CanvasModel, parsed: ParsedArgs): SpanTarget {
  const sectionId = value(parsed, "--section");
  if (!sectionId) {
    throw new CanvasCommandError("missing_section", "comment/react requires --section");
  }
  const anchor = value(parsed, "--anchor");
  const quote = value(parsed, "--quote");
  const occurrence = value(parsed, "--occurrence");
  if (anchor && (quote || occurrence)) {
    throw new CanvasCommandError(
      "ambiguous_anchor",
      "pass --anchor or --quote plus --occurrence, not both",
    );
  }
  if (!anchor && !quote && !occurrence) {
    throw new CanvasCommandError("missing_anchor", "pass --anchor or --quote plus --occurrence");
  }
  if (quote && !occurrence) {
    throw new CanvasCommandError("missing_occurrence", "--quote requires --occurrence");
  }
  if (occurrence && !quote) {
    throw new CanvasCommandError("missing_quote", "--occurrence requires --quote");
  }
  if (anchor) {
    return {
      sectionId,
      anchorId: anchor,
      threadTs: threadTsForAnnotation(anchor),
      selectedText: sectionText(model, sectionId) || sectionId,
    };
  }
  const section = model.sections.find((candidate) => candidate.id === sectionId);
  if (!section) {
    throw new CanvasCommandError("missing_section", `section not found: ${sectionId}`);
  }
  const occurrenceNumber = clampInt(occurrence!, 1, Number.MAX_SAFE_INTEGER);
  const index = nthOccurrenceIndex(section.text, quote!, occurrenceNumber);
  if (index < 0) {
    throw new CanvasCommandError(
      "quote_not_found",
      "quote occurrence was not found in the selected section",
    );
  }
  const anchorId = stableAnnotationId(sectionId, quote!, occurrence!);
  return {
    sectionId,
    anchorId,
    threadTs: threadTsForAnnotation(anchorId),
    selectedText: quote!,
    occurrence: occurrenceNumber,
    startOffset: index,
  };
}

async function readCommentText(parsed: ParsedArgs): Promise<string> {
  const text = value(parsed, "--text");
  const from = value(parsed, "--from");
  if ((text ? 1 : 0) + (from ? 1 : 0) !== 1) {
    throw new Error("comment add requires exactly one of --text or --from");
  }
  return text ?? (await readTextArg(from!));
}

async function openAnnotationThread(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  span: SpanTarget,
): Promise<{ threadTs: string; messages: Record<string, unknown>[] }> {
  const response = await canvasDeps.slackApi(workspace, "conversations.replies", {
    channel: model.fileChannel,
    ts: annotationThreadTs(span.anchorId),
    inclusive: true,
    limit: 28,
    latest: (Date.now() / 1000).toFixed(3),
    content_snippet: annotationContentSnippet(workspace, model, span),
    cached_latest_updates: {},
    _x_reason: "history-api/fetchReplies",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
  const messages = Array.isArray(response.messages) ? response.messages.filter(isRecord) : [];
  const ts =
    messages.map((message) => stringField(message, "ts")).find(Boolean) ??
    stringField(response, "ts") ??
    stringField(response, "thread_ts");
  if (!ts) {
    throw new CanvasCommandError(
      "annotation_thread_not_found",
      "Slack did not return a root thread for the Canvas annotation",
    );
  }
  return { threadTs: ts, messages };
}

async function loadCommentThread(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  ts: string,
): Promise<{ threadTs: string; messages: Record<string, unknown>[] }> {
  const first = await canvasDeps.slackApi(workspace, "conversations.replies", {
    channel: model.fileChannel,
    ts,
    inclusive: true,
    limit: 28,
    latest: (Date.now() / 1000).toFixed(3),
    _x_reason: "history-api/fetchReplies",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
  const firstMessages = recordArray(first.messages);
  const threadTs =
    firstMessages.map((message) => stringField(message, "thread_ts")).find(Boolean) ??
    stringField(first, "thread_ts") ??
    ts;
  if (threadTs === ts) {
    return { threadTs, messages: firstMessages };
  }
  const root = await canvasDeps.slackApi(workspace, "conversations.replies", {
    channel: model.fileChannel,
    ts: threadTs,
    inclusive: true,
    limit: 28,
    latest: (Date.now() / 1000).toFixed(3),
    _x_reason: "history-api/fetchReplies",
    _x_mode: "online",
    _x_sonic: true,
    _x_app_name: "client",
  });
  return { threadTs, messages: recordArray(root.messages) };
}

function annotationThreadTs(annotationId: string): string {
  return `Qpc:t:C:${annotationId.replace(/^temp:C:/, "")}`;
}

function annotationContentSnippet(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  span: SpanTarget,
): Record<string, unknown> {
  const text = span.selectedText;
  return {
    rich_text: JSON.stringify({
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
        },
      ],
    }),
    mrkdwn: text,
    section_users: [
      {
        slack_user_id: stringValue(model.file.user) ?? "",
        slack_team_id:
          workspace.team_id ??
          stringValue(model.file.user_team) ??
          stringValue(model.file.team_id) ??
          "",
        quip_user_id: model.editorUserId,
        is_author: true,
        is_recent_editor: false,
        is_most_recent_editor: true,
        is_mentioned: false,
      },
    ],
    is_archived: false,
    last_edited_usec: (numberValue(model.file.updated) ?? Math.floor(Date.now() / 1000)) * 1000000,
    created_usec: (numberValue(model.file.created) ?? Math.floor(Date.now() / 1000)) * 1000000,
    control_id: span.anchorId,
  };
}

function mutationResult(
  status: "updated" | "noop",
  verification: Verification,
): Record<string, unknown> {
  return {
    status,
    verified: verification.verified,
    ...(verification.verified || !verification.note ? {} : { note: verification.note }),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyWrite(
  model: CanvasModel,
  operation: "append" | "prepend" | "replace",
  markdown: string,
): Verification {
  const verified = desiredWriteReached(model, operation, markdown);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          expected: comparableCanvasText(markdown),
          actual: comparableCanvasText(model.markdown),
          predicate: operation,
        },
      };
}

function verifySectionInsertion(
  model: CanvasModel,
  markdown: string,
  beforeId?: string,
  afterId?: string,
): Verification {
  const verified = sectionInsertionReached(model, markdown, beforeId, afterId);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          expected_section_text: normalizedMarkdown(markdown),
          before: beforeId,
          after: afterId,
          sections: model.sections.map((section) => ({ id: section.id, text: section.text })),
        },
      };
}

function verifySectionReplacement(
  model: CanvasModel,
  sectionId: string,
  markdown: string,
): Verification {
  const desired = comparableCanvasText(markdown);
  const targetText = comparableCanvasText(sectionText(model, sectionId));
  const oldSectionGone = !model.sections.some((section) => section.id === sectionId);
  const exactTarget = targetText === desired;
  const singleDesired =
    model.sections.filter((section) => comparableCanvasText(section.text) === desired).length === 1;
  const verified = exactTarget || (oldSectionGone && singleDesired);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          section_id: sectionId,
          expected_text: desired,
          actual_section_text: targetText,
          desired_section_count: model.sections.filter(
            (section) => comparableCanvasText(section.text) === desired,
          ).length,
        },
      };
}

function verifyTableRows(model: CanvasModel, rows: string[][]): Verification {
  const verified = tableRowsReached(model, rows);
  return verified
    ? { verified }
    : { verified, note: { expected_rows: rows, actual_markdown: model.markdown } };
}

function verifyDateInsertion(
  model: CanvasModel,
  timestamp: number,
  fallback: string,
): Verification {
  const verified = dateInsertionReached(model, timestamp, fallback);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          expected_timestamp: timestamp,
          expected_timestamp_ms: timestamp * 1000,
          expected_fallback: fallback,
        },
      };
}

function verifyEmbed(
  model: CanvasModel,
  embedValue: string,
  title?: string,
  latestStrings: string[] = [],
): Verification {
  const verified = embedReached(model, embedValue, title, latestStrings);
  return verified
    ? { verified }
    : {
        verified,
        note: { expected_embed: embedValue, expected_title: title, resources: model.resources },
      };
}

function verifyComment(
  model: CanvasModel,
  messages: Record<string, unknown>[],
  span: SpanTarget,
  text: string,
): Verification {
  const verified = hasComment(model, span, text) || threadContainsText(messages, text);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          expected_anchor: span.anchorId,
          expected_text: text,
          comments_count: model.comments.length,
          thread_message_count: messages.length,
          thread_contains_text: threadContainsText(messages, text),
        },
      };
}

async function canvasReactionPresent(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  threadTs: string,
  emoji: string,
  span?: SpanTarget,
): Promise<boolean> {
  const reactions = await safeCanvasThreadReactions(workspace, model, {
    anchorId: span?.anchorId,
    threadTs,
    selectedText: span?.selectedText,
    sectionId: span?.sectionId,
  });
  return reactions.some((reaction) => reaction.emoji === emoji);
}

async function listCanvasContentReactions(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  parsed: ParsedArgs,
): Promise<CanvasReactionItem[]> {
  const selectorAnchor = value(parsed, "--anchor");
  const selectorQuote = value(parsed, "--quote");
  const selectorOccurrence = value(parsed, "--occurrence");
  if (selectorAnchor || selectorQuote || selectorOccurrence) {
    const span = resolveSpanTarget(model, parsed);
    const thread = await openAnnotationThread(workspace, model, span);
    return await safeCanvasThreadReactions(workspace, model, {
      anchorId: span.anchorId,
      threadTs: thread.threadTs,
      selectedText: span.selectedText,
      sectionId: span.sectionId,
    });
  }

  const sectionId = value(parsed, "--section");
  const annotations = await canvasAnnotations(workspace, model);
  const filtered = sectionId
    ? annotations.filter(
        (annotation) =>
          annotation.sectionId === sectionId ||
          Boolean(
            annotation.selectedText &&
            sectionText(model, sectionId).includes(annotation.selectedText),
          ),
      )
    : annotations;
  const nested = await Promise.all(
    filtered.map(async (annotation) =>
      safeCanvasThreadReactions(
        workspace,
        model,
        await resolveAnnotationThread(workspace, model, annotation),
      ),
    ),
  );
  return nested.flat();
}

async function resolveAnnotationThread(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  annotation: { anchorId?: string; threadTs: string; selectedText?: string; sectionId?: string },
): Promise<{ anchorId?: string; threadTs: string; selectedText?: string; sectionId?: string }> {
  if (!annotation.anchorId || !annotation.selectedText || !annotation.sectionId) {
    return annotation;
  }
  const thread = await openAnnotationThread(workspace, model, {
    anchorId: annotation.anchorId,
    threadTs: annotation.threadTs,
    selectedText: annotation.selectedText,
    sectionId: annotation.sectionId,
  });
  return { ...annotation, threadTs: thread.threadTs };
}

async function safeCanvasThreadReactions(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  annotation: { anchorId?: string; threadTs: string; selectedText?: string; sectionId?: string },
): Promise<CanvasReactionItem[]> {
  try {
    const payload = await canvasDeps.canvasReactions(workspace, {
      channel: model.fileChannel,
      timestamp: annotation.threadTs,
    });
    return normalizeReactionPayload(payload, annotation, model);
  } catch (error) {
    if (
      /message_not_found|thread_not_found|channel_not_found/.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      return [];
    }
    throw error;
  }
}

async function canvasAnnotations(
  workspace: CanvasWorkspace,
  model: CanvasModel,
): Promise<{ anchorId: string; threadTs: string; selectedText?: string; sectionId?: string }[]> {
  const strings = await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
    canvasId: model.canvasId,
    threadId: model.threadId,
    forceRefresh: true,
  });
  const annotations = new Map<
    string,
    { anchorId: string; threadTs: string; selectedText?: string; sectionId?: string }
  >();
  for (const source of strings) {
    for (const match of source.matchAll(/<annotation\b([^>]*)>([\s\S]*?)<\/annotation>/g)) {
      const attrs = match[1] ?? "";
      const anchorId = attrValue(attrs, "id");
      if (!anchorId) {
        continue;
      }
      const selectedText = stripAnnotationText(match[2] ?? "");
      annotations.set(anchorId, {
        anchorId,
        threadTs: attrValue(attrs, "thread_ts") ?? threadTsForAnnotation(anchorId),
        selectedText,
        sectionId: attrValue(attrs, "section") ?? sectionIdForAnnotationText(model, selectedText),
      });
    }
  }
  return [...annotations.values()];
}

function normalizeReactionPayload(
  payload: Record<string, unknown>,
  annotation: { anchorId?: string; threadTs: string; selectedText?: string; sectionId?: string },
  model?: CanvasModel,
): CanvasReactionItem[] {
  const message = isRecord(payload.message) ? payload.message : payload;
  const reactions = recordArray(message.reactions);
  const currentUser = model ? (stringValue(model.file.user) ?? model.editorUserId) : undefined;
  return reactions
    .map((reaction) => {
      const emoji = stringValue(reaction.name) ?? stringValue(reaction.emoji) ?? "";
      const users = arrayValue(reaction.users).filter(
        (user): user is string => typeof user === "string",
      );
      const count =
        numberValue(reaction.count) ?? numberValue(reaction.reaction_total) ?? users.length;
      return {
        emoji,
        reaction_total: count,
        reacted: currentUser ? users.includes(currentUser) : users.length > 0,
        anchor: {
          id: annotation.anchorId,
          thread_ts: annotation.threadTs,
          section_id: annotation.sectionId,
          text: annotation.selectedText,
        },
      };
    })
    .filter((reaction) => reaction.emoji);
}

function verifyAccessLevel(
  file: CanvasFile,
  expected: "read" | "write" | "invitation",
): Verification {
  const actual = currentAccessLevel(file);
  const verified = actual === expected;
  return verified
    ? { verified }
    : { verified, note: { expected_access_level: expected, actual_access_level: actual } };
}

function verifyAccessGrant(
  file: CanvasFile,
  shares: unknown,
  target: AccessTarget,
  level?: "read" | "write",
): Verification {
  const verified = accessGrantReached(file, shares, target, level);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          expected_target: target.id,
          expected_channel: target.channel,
          expected_level: level,
          grants: extractAccessGrants(file, shares),
        },
      };
}

function verifyAccessRevoked(
  file: CanvasFile,
  shares: unknown,
  target: AccessTarget,
): Verification {
  const verified = !accessGrantReached(file, shares, target);
  return verified
    ? { verified }
    : {
        verified,
        note: {
          unexpected_target: target.id,
          unexpected_channel: target.channel,
          grants: extractAccessGrants(file, shares),
        },
      };
}

function verifyCover(
  file: CanvasFile,
  headerId: string,
  loadDataStrings: string[] = [],
): Verification {
  const actual = currentCoverId(file);
  const actualFromLoadData = coverIdFromStrings(loadDataStrings, [headerId]);
  const verified = actual === headerId || actualFromLoadData === headerId;
  return verified
    ? { verified }
    : {
        verified,
        note: {
          expected_cover_id: headerId,
          actual_cover_id: actual,
          load_data_matched_cover_id: actualFromLoadData,
        },
      };
}

function verifyCoverCleared(
  file: CanvasFile,
  loadDataStrings: string[] = [],
  headerIds: string[] = [],
): Verification {
  const actual = currentCoverId(file);
  const actualFromLoadData = coverIdFromStrings(loadDataStrings, headerIds);
  const verified = !actual && !actualFromLoadData;
  return verified
    ? { verified }
    : {
        verified,
        note: { unexpected_cover_id: actual, unexpected_load_data_cover_id: actualFromLoadData },
      };
}

function desiredWriteReached(
  model: CanvasModel,
  operation: "append" | "prepend" | "replace",
  markdown: string,
): boolean {
  const current = comparableCanvasText(model.markdown);
  const desired = comparableCanvasText(markdown);
  if (operation === "replace") {
    return current === desired;
  }
  if (!desired) {
    return true;
  }
  return (
    current.includes(desired) ||
    comparableCanvasParts(markdown).every((part) => current.includes(part))
  );
}

function tableRowsReached(model: CanvasModel, rows: string[][]): boolean {
  const desired = normalizeTableRowsForCompare(rows);
  return markdownTables(model.markdown).some((table) => tableHash(table) === tableHash(desired));
}

function tableReplacementDeleteSectionIds(model: CanvasModel, tableTarget: string): string[] {
  const groups = tableCellSectionIdGroupsFromHtml(model.html);
  const tableIndex = model.sections.findIndex(
    (section) => section.id === tableTarget && section.type === "table",
  );
  const cellIds =
    tableIndex >= 0 ? (groups[tableIndex] ?? []) : groups.length === 1 ? groups[0] : [];
  return [...new Set([tableTarget, ...cellIds.filter(Boolean)])];
}

function tableReplacementPosition(model: CanvasModel, tableTarget: string): string {
  const directIndex = model.sections.findIndex((section) => section.id === tableTarget);
  if (directIndex >= 0) {
    return estimatedSectionPosition(directIndex);
  }
  const firstCellId = tableCellSectionIdGroupsFromHtml(model.html).flat()[0];
  const cellIndex = firstCellId
    ? model.sections.findIndex((section) => section.id === firstCellId)
    : -1;
  return estimatedSectionPosition(Math.max(0, cellIndex));
}

function tableCellSectionIdGroupsFromHtml(html?: string): string[][] {
  if (!html) {
    return [];
  }
  return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((table) => {
    return [...(table[1] ?? "").matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
      .map((match) => match[1] ?? match[2] ?? "")
      .filter(Boolean);
  });
}

function dateInsertionReached(model: CanvasModel, timestamp: number, fallback: string): boolean {
  const current = comparableCanvasText(model.markdown);
  if (
    model.markdown.includes(fallback) ||
    model.markdown.includes(String(timestamp)) ||
    current.includes(comparableCanvasText(fallback).split(" ").slice(0, 2).join(" "))
  ) {
    return true;
  }
  const htmlInsertions = model.html ? extractSpecialInsertions(model.html) : [];
  return htmlInsertions.some(
    (entry) =>
      entry.text === fallback ||
      entry.value === String(timestamp) ||
      (entry.text && comparableCanvasText(entry.text) === comparableCanvasText(fallback)),
  );
}

function displayTitle(model: CanvasModel): string {
  const heading = model.sections.find(
    (section) => section.type === "h1" || /^#\s+/.test(section.text),
  )?.text;
  return normalizedMarkdown(heading ?? model.title);
}

function comparableCanvasText(markdown: string): string {
  return decodePrivateBodyText(markdown)
    .replace(/<@((?:U|W)[A-Z0-9]{8,})(?:\|[^>]+)?>/g, "@$1")
    .replace(/<#((?:C|G)[A-Z0-9]{8,})(?:\|[^>]+)?>/g, "#$1")
    .replace(/<!date\^\d+(?:\^[^|>]+)?\|([^>]+)>/g, "$1")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/!\[([^\]\n]*)]\(([^)\s]+)\)/g, "$1 $2")
    .replace(/\[([^\]\n]+)]\(([^)\s]+)\)/g, "$1 $2")
    .replace(/([*_~`]{1,3})([^*_~`\n]+)\1/g, "$2")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableCanvasParts(markdown: string): string[] {
  const withoutFences = markdown.replace(/```([\s\S]*?)```/g, "\n$1\n");
  return withoutFences
    .split(/\n{2,}/)
    .map(comparableCanvasText)
    .filter(Boolean);
}

function sectionText(model: CanvasModel, sectionId: string): string {
  return normalizedMarkdown(model.sections.find((section) => section.id === sectionId)?.text ?? "");
}

function sectionIdForAnnotationText(
  model: CanvasModel,
  text: string | undefined,
): string | undefined {
  if (!text) {
    return undefined;
  }
  return model.sections.find((section) => section.text.includes(text))?.id;
}

function attrValue(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`))?.[1];
}

function stripAnnotationText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionInsertionReached(
  model: CanvasModel,
  markdown: string,
  beforeId?: string,
  afterId?: string,
): boolean {
  const desired = comparableCanvasText(markdown);
  if (!desired) {
    return true;
  }
  const anchorId = beforeId ?? afterId;
  if (!anchorId) {
    return model.sections.some((section) => comparableCanvasText(section.text) === desired);
  }
  const anchorIndex = model.sections.findIndex((section) => section.id === anchorId);
  if (anchorIndex < 0) {
    return false;
  }
  const expectedIndex = beforeId ? anchorIndex - 1 : anchorIndex + 1;
  const lineParts = normalizedMarkdown(markdown)
    .split("\n")
    .map(comparableCanvasText)
    .filter(Boolean);
  const parts = lineParts.length > 1 ? lineParts : comparableCanvasParts(markdown);
  if (parts.length > 1) {
    const candidates = model.sections
      .slice(expectedIndex, expectedIndex + parts.length)
      .map((section) => comparableCanvasText(section.text));
    return parts.every((part, index) => candidates[index] === part);
  }
  const candidate = model.sections[expectedIndex];
  return Boolean(candidate && comparableCanvasText(candidate.text) === desired);
}

function markdownTables(markdown: string): string[][][] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const tables: string[][][] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (
      !/^\s*\|.*\|\s*$/.test(lines[i]) ||
      !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      continue;
    }
    const rows = [splitMarkdownTableRow(lines[i])];
    i += 2;
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
      rows.push(splitMarkdownTableRow(lines[i++]));
    }
    tables.push(normalizeTableRowsForCompare(rows));
  }
  return tables;
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => comparableCanvasText(cell.replace(/\\\|/g, "|")));
}

function normalizeTableRowsForCompare(rows: string[][]): string[][] {
  const width = rows.length ? Math.max(...rows.map((row) => row.length)) : 0;
  return rows.map((row) =>
    [...row, ...Array.from({ length: width - row.length }, () => "")].map(comparableCanvasText),
  );
}

function tableHash(rows: string[][]): string {
  return rows.map((row) => row.join("\u001f")).join("\u001e");
}

async function fetchCurrentCanvasStrings(
  workspace: CanvasWorkspace,
  model: CanvasModel,
): Promise<string[]> {
  return model.threadId
    ? await canvasDeps.fetchCanvasLoadDataStrings(workspace, {
        canvasId: model.canvasId,
        threadId: model.threadId,
        forceRefresh: true,
      })
    : [];
}

function embedReached(
  model: CanvasModel,
  embedValue: string,
  title?: string,
  strings: string[] = [],
): boolean {
  const payload = JSON.stringify([
    model.markdown,
    model.html,
    model.resources,
    model.sections,
    model.file,
    strings,
  ]);
  return payload.includes(embedValue) || Boolean(title && payload.includes(title));
}

function verifyEmbedRemoved(
  model: CanvasModel,
  embedValue: string,
  strings: string[] = [],
): Verification {
  const verified = !embedReached(model, embedValue, undefined, strings);
  return verified
    ? { verified }
    : { verified, note: { unexpected_embed: embedValue, resources: model.resources } };
}

function collectCanvasEmbeds(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  strings: string[] = [],
): CanvasResource[] {
  return dedupeCanvasResources([
    ...model.resources.map((resource) => enrichCanvasResource(workspace, resource)),
    ...resourcesFromCanvasStrings(workspace, strings),
    ...resourcesFromCanvasSections(workspace, model.sections),
  ]);
}

function resourcesFromCanvasStrings(
  workspace: CanvasWorkspace,
  strings: string[],
): CanvasResource[] {
  const resources: CanvasResource[] = [];
  for (let i = 0; i < strings.length; i++) {
    const value = strings[i];
    for (const canvasMatch of value.matchAll(/\bsd:(F[A-Z0-9]{8,})(?:\/[^\s"'<>]+)?\b/g)) {
      const canvasId = canvasMatch[1];
      if (!canvasId) {
        continue;
      }
      resources.push(
        enrichCanvasResource(workspace, {
          type: "slack_canvas",
          url: buildSlackCanvasUrl(workspace.workspace_url, canvasId, workspace.team_id),
          text: canvasId,
          section_id: nearestSectionId(strings, i),
          canvas_id: canvasId,
          id: canvasId,
        }),
      );
    }
    for (const messageMatch of value.matchAll(/\bsm:([CGD][A-Z0-9]+)\/([0-9]+(?:\.[0-9]+)?)\b/g)) {
      const channel = messageMatch[1];
      const rawTs = messageMatch[2];
      if (!channel || !rawTs) {
        continue;
      }
      const ts = normalizeMessageTs(rawTs);
      const url = buildSlackMessageUrl(workspace.workspace_url, channel, ts);
      resources.push(
        enrichCanvasResource(workspace, {
          type: "slack_message",
          url,
          text: url,
          section_id: nearestSectionId(strings, i),
          channel,
          message_ts: ts,
          id: url,
        }),
      );
    }
    for (const fileMatch of value.matchAll(
      /\bsf:(F[A-Z0-9]{8,})\b|\bdata-slack-file-id=("|')?(F[A-Z0-9]{8,})\2/g,
    )) {
      const fileId = fileMatch[1] ?? fileMatch[3];
      const html = strings.find((entry) => entry.includes(fileId) && /<a\b/i.test(entry));
      const url = htmlHref(html) ?? `slack-file://${fileId}`;
      const text = html ? stripTags(html).trim() || fileId : fileId;
      resources.push(
        enrichCanvasResource(workspace, {
          type: "slack_file",
          url,
          text,
          section_id: nearestSectionId(strings, i),
          file_id: fileId,
          id: fileId,
        }),
      );
    }
    for (const anchor of value.matchAll(
      /<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi,
    )) {
      const url = anchor[1] ?? anchor[2];
      const resource = resourceFromUrl(
        workspace,
        url,
        stripTags(anchor[3] ?? "").trim() || undefined,
        nearestSectionId(strings, i),
      );
      if (resource) {
        resources.push(resource);
      }
    }
    for (const link of value.matchAll(/\[([^\]\n]+)]\(([^)\s]+)\)/g)) {
      const resource = resourceFromUrl(workspace, link[2], link[1], nearestSectionId(strings, i));
      if (resource) {
        resources.push(resource);
      }
    }
    if (/^https:\/\/[^/\s]+\.slack\.com\/archives\/[CGD][A-Z0-9]+\/p\d+$/.test(value)) {
      const resource = resourceFromUrl(workspace, value, undefined, nearestSectionId(strings, i));
      if (resource) {
        resources.push(resource);
      }
    }
  }
  return dedupeCanvasResources(resources);
}

function resourcesFromCanvasSections(
  workspace: CanvasWorkspace,
  sections: CanvasSection[],
): CanvasResource[] {
  return dedupeCanvasResources(
    sections.flatMap((section) => resourcesFromSectionText(workspace, section)),
  );
}

function resourcesFromSectionText(
  workspace: CanvasWorkspace,
  section: CanvasSection,
): CanvasResource[] {
  const resources: CanvasResource[] = [];
  for (const link of section.text.matchAll(/\[([^\]\n]+)]\(([^)\s]+)\)/g)) {
    const resource = resourceFromUrl(workspace, link[2], link[1], section.id);
    if (resource) {
      resources.push(resource);
    }
  }
  for (const url of section.text.matchAll(
    /https:\/\/[^/\s]+\.slack\.com\/(?:archives\/[CGD][A-Z0-9]+\/p\d+|docs(?:\/[A-Z0-9]+)?\/F[A-Z0-9]{8,})/g,
  )) {
    const resource = resourceFromUrl(workspace, url[0], undefined, section.id);
    if (resource) {
      resources.push(resource);
    }
  }
  return resources;
}

function resourceFromUrl(
  workspace: CanvasWorkspace,
  rawUrl: string,
  text?: string,
  sectionId?: string,
): CanvasResource | undefined {
  const canvasId = canvasIdFromEmbedSource(rawUrl);
  if (canvasId) {
    const url =
      rawUrl === canvasId
        ? buildSlackCanvasUrl(workspace.workspace_url, canvasId, workspace.team_id)
        : rawUrl;
    return {
      type: "slack_canvas",
      kind: "canvas",
      url,
      text: text ?? canvasId,
      id: canvasId,
      canvas_id: canvasId,
      section_id: sectionId,
    };
  }
  const message = rawUrl.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d+)/);
  if (message) {
    return {
      type: "slack_message",
      kind: "message",
      url: rawUrl,
      text: text ?? rawUrl,
      id: rawUrl,
      channel: message[1],
      message_ts: messageTsFromPermalinkDigits(message[2]),
      section_id: sectionId,
    };
  }
  const fileId =
    rawUrl.match(/^slack-file:\/\/(F[A-Z0-9]{8,})$/)?.[1] ??
    rawUrl.match(/\/files\/[UW][A-Z0-9]+\/(F[A-Z0-9]+)/)?.[1] ??
    rawUrl.match(/files-pri\/[^/]+-(F[A-Z0-9]+)/)?.[1];
  if (fileId) {
    return {
      type: "slack_file",
      kind: "file",
      url: rawUrl,
      text: text ?? fileId,
      id: fileId,
      file_id: fileId,
      section_id: sectionId,
    };
  }
  if (/^https?:\/\//.test(rawUrl)) {
    return { type: "link", kind: "link", url: rawUrl, text, id: rawUrl, section_id: sectionId };
  }
  return undefined;
}

function enrichCanvasResource(
  workspace: CanvasWorkspace,
  resource: CanvasResource,
): CanvasResource {
  return (
    resourceFromUrl(workspace, resource.url, resource.text, resource.section_id) ?? {
      ...resource,
      kind: resource.type === "image" ? "image" : "link",
      id: resource.id ?? resource.url,
    }
  );
}

function dedupeCanvasResources(resources: CanvasResource[]): CanvasResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.type}\0${resource.id ?? resource.url}\0${resource.section_id ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sectionIdForEmbed(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  strings: string[],
  embed: string,
): string | undefined {
  if (model.sections.some((section) => section.id === embed)) {
    return embed;
  }
  const resource = collectCanvasEmbeds(workspace, model, strings).find((candidate) =>
    resourceMatchesEmbed(candidate, embed),
  );
  if (resource?.section_id) {
    return resource.section_id;
  }
  return (
    model.sections.find(
      (section) =>
        section.text.includes(embed) ||
        Boolean(
          canvasIdFromEmbedSource(embed) && section.text.includes(canvasIdFromEmbedSource(embed)!),
        ),
    )?.id ?? sectionIdFromCanvasStrings(strings, embed)
  );
}

function sectionIdFromCanvasStrings(strings: string[], embed: string): string | undefined {
  const canvasId = canvasIdFromEmbedSource(embed);
  for (let i = 0; i < strings.length; i++) {
    const value = strings[i];
    if (value.includes(embed) || Boolean(canvasId && value.includes(canvasId))) {
      return nearestSectionId(strings, i);
    }
  }
  return undefined;
}

function resourceMatchesEmbed(resource: CanvasResource, embed: string, title?: string): boolean {
  const canvasId = canvasIdFromEmbedSource(embed);
  return [
    resource.id,
    resource.file_id,
    resource.canvas_id,
    resource.url,
    resource.text,
    resource.section_id,
    title,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value === embed || Boolean(canvasId && value.includes(canvasId)));
}

function nearestSectionId(strings: string[], index: number): string | undefined {
  for (let i = index; i >= Math.max(0, index - 8); i--) {
    if (/^temp:C:[A-Za-z0-9]+$/.test(strings[i])) {
      return strings[i];
    }
  }
  return undefined;
}

function htmlHref(html: string | undefined): string | undefined {
  return html?.match(/\bhref='([^']+)'/)?.[1] ?? html?.match(/\bhref="([^"]+)"/)?.[1];
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
}

function messageTsFromPermalinkDigits(value: string): string {
  return value.length > 6 ? `${value.slice(0, -6)}.${value.slice(-6)}` : value;
}

function normalizeMessageTs(value: string): string {
  return value.includes(".") ? value : messageTsFromPermalinkDigits(value);
}

function buildSlackMessageUrl(workspaceUrl: string, channel: string, ts: string): string {
  return `${workspaceUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
}

function parseMessagePermalink(value: string): { channel: string; ts: string } | undefined {
  const match = value.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d+)/);
  return match ? { channel: match[1], ts: messageTsFromPermalinkDigits(match[2]) } : undefined;
}

function threadContainsText(messages: Record<string, unknown>[], text: string): boolean {
  const expected = text.trim();
  return (
    Boolean(expected) &&
    messages.some(
      (message) =>
        stringValue(message.text)?.trim() === expected ||
        JSON.stringify(message).includes(expected),
    )
  );
}

function parseTableRows(input: string): string[][] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("table input is empty");
  }
  if (trimmed.startsWith("[")) {
    const value = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(value)) {
      throw new Error("table JSON must be an array");
    }
    if (value.every(Array.isArray)) {
      return value.map((row) => row.map((cell) => String(cell ?? "")));
    }
    if (value.every(isRecord)) {
      const columns = [
        ...new Set(value.flatMap((row) => Object.keys(row as Record<string, unknown>))),
      ];
      return [
        columns,
        ...value.map((row) =>
          columns.map((column) => String((row as Record<string, unknown>)[column] ?? "")),
        ),
      ];
    }
    throw new Error("table JSON must be an array of arrays or objects");
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parseCsvLine);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function rowsToMarkdown(rows: string[][]): string {
  if (!rows.length) {
    return "";
  }
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  return [normalized[0], normalized[0].map(() => "---"), ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function positionFromPlacement(parsed: ParsedArgs, required: boolean): string | undefined {
  const flags = ["--before", "--after", "--at"]
    .map((flag) => ({ flag, value: value(parsed, flag) }))
    .filter((entry): entry is { flag: string; value: string } => Boolean(entry.value));
  if (required && flags.length !== 1) {
    throw new Error("insert requires exactly one placement flag");
  }
  if (!required && flags.length === 0) {
    return undefined;
  }
  if (flags.length !== 1) {
    throw new Error("pass only one placement flag");
  }
  return `${flags[0].flag.slice(2)}:${flags[0].value}`;
}

function positionForPlacementFromParsed(
  model: CanvasModel,
  parsed: ParsedArgs,
  required: boolean,
): string | undefined {
  const before = value(parsed, "--before");
  const after = value(parsed, "--after");
  const at = value(parsed, "--at");
  const count = (before ? 1 : 0) + (after ? 1 : 0) + (at ? 1 : 0);
  if (required && count !== 1) {
    throw new Error("insert requires exactly one placement flag");
  }
  if (!required && count === 0) {
    return undefined;
  }
  if (count !== 1) {
    throw new Error("pass only one placement flag");
  }
  if (before) {
    return positionForPlacement(model, { before });
  }
  if (after) {
    return positionForPlacement(model, { after });
  }
  return at === "start" ? "aaZ:temp" : undefined;
}

function positionForPlacement(
  model: CanvasModel,
  placement: { before?: string; after?: string },
): string {
  const anchorId = placement.before ?? placement.after;
  const index = model.sections.findIndex((section) => section.id === anchorId);
  if (index < 0) {
    throw new CanvasCommandError("section_not_found", `section not found: ${anchorId}`);
  }
  if (placement.before) {
    return index === 0
      ? "aaZ:temp"
      : midpointPosition(estimatedSectionPosition(index - 1), estimatedSectionPosition(index));
  }
  return index >= model.sections.length - 1
    ? estimatedSectionPosition(index + 1)
    : midpointPosition(estimatedSectionPosition(index), estimatedSectionPosition(index + 1));
}

function estimatedSectionPosition(index: number): string {
  if (index < 0) {
    return "aaZ:temp";
  }
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const first = Math.floor(index / alphabet.length);
  const second = index % alphabet.length;
  const prefix = first === 0 ? "aa" : `a${alphabet[Math.min(first, alphabet.length - 1)]}`;
  return `${prefix}${alphabet[second]}:temp`;
}

function midpointPosition(left: string, _right: string): string {
  return `${left.replace(/:temp$/, "")}m:temp`;
}

function parseDateFlag(input: string): number {
  const lower = input.toLowerCase();
  const now = new Date();
  if (lower === "today") {
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  }
  if (lower === "tomorrow") {
    return Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000,
    );
  }
  const date = /^\d+$/.test(input) ? new Date(Number(input) * 1000) : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --date value: ${input}`);
  }
  return Math.floor(date.getTime() / 1000);
}

function embedSource(parsed: ParsedArgs, embedType: string): { flag: string; value: string } {
  const sourceFlags = ["--file", "--url", "--canvas", "--message"]
    .map((flag) => ({ flag, value: value(parsed, flag) }))
    .filter((entry): entry is { flag: string; value: string } => Boolean(entry.value));
  if (sourceFlags.length !== 1) {
    throw new Error("embed add requires exactly one source flag");
  }
  const allowed: Record<string, string[]> = {
    image: ["--file", "--url"],
    file: ["--file"],
    link: ["--url"],
    canvas: ["--canvas"],
    message: ["--message"],
  };
  const allowedFlags = allowed[embedType];
  if (!allowedFlags) {
    throw new Error("--type must be image, file, link, canvas, or message");
  }
  if (!allowedFlags.includes(sourceFlags[0].flag)) {
    throw new Error(`${embedType} embed requires ${allowedFlags.join(" or ")}`);
  }
  return sourceFlags[0];
}

async function embedSourceIdentity(source: { flag: string; value: string }): Promise<string> {
  if (source.flag !== "--file") {
    return source.value;
  }
  const bytes = await readFile(source.value);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${basename(source.value)}:${hash}`;
}

function embedStoredValue(workspace: CanvasWorkspace, embedType: string, source: string): string {
  if (embedType === "canvas") {
    const canvasId = canvasIdFromEmbedSource(source);
    return canvasId
      ? buildSlackCanvasUrl(workspace.workspace_url, canvasId, workspace.team_id)
      : source;
  }
  return source;
}

function embedMarkdown(embedType: string, source: string, text?: string): string {
  if (embedType === "image") {
    return source.startsWith("F")
      ? `<file:${source}|${text ?? source}>`
      : `![${text ?? basename(source)}](${source})`;
  }
  if (embedType === "file") {
    return `<file:${source}|${text ?? source}>`;
  }
  if (embedType === "canvas") {
    return `[${text ?? "Canvas"}](${source})`;
  }
  if (embedType === "message") {
    return source;
  }
  return `[${text ?? source}](${source})`;
}

function canvasIdFromEmbedSource(source: string): string | undefined {
  if (isCanvasId(source)) {
    return source;
  }
  return source.match(/\/docs(?:\/[A-Z0-9]+)?\/(F[A-Z0-9]{8,})/)?.[1];
}

function positionForEmbedPlacementFromParsed(
  model: CanvasModel,
  parsed: ParsedArgs,
): string | undefined {
  const section = value(parsed, "--section");
  if (!section) {
    return positionForPlacementFromParsed(model, parsed, false);
  }
  const before = value(parsed, "--before");
  const after = value(parsed, "--after");
  const at = value(parsed, "--at");
  if (before || after || at) {
    throw new Error("pass only one placement flag");
  }
  return positionForPlacement(model, { after: section });
}

function embedAfterSection(parsed: ParsedArgs): string | undefined {
  return value(parsed, "--after") ?? value(parsed, "--section");
}

function slackFileUrl(
  workspace: CanvasWorkspace,
  model: CanvasModel,
  fileId: string,
  title: string,
): string {
  const user = stringValue(model.file.user) ?? model.editorUserId;
  const safeTitle = encodeURIComponent(title);
  return `${workspace.workspace_url.replace(/\/$/, "")}/files/${user}/${fileId}/${safeTitle}`;
}

async function resolveHeaderId(workspace: CanvasWorkspace, name: string): Promise<string> {
  const headers = await canvasHeaders(workspace);
  const lower = name.toLowerCase();
  const match = headers.find(
    (header) =>
      header.id === name ||
      header.name.toLowerCase() === lower ||
      header.title.toLowerCase() === lower,
  );
  if (!match) {
    throw new Error(`Unknown canvas header: ${name}`);
  }
  return match.id;
}

async function canvasHeaders(
  workspace: CanvasWorkspace,
): Promise<{ id: string; name: string; title: string }[]> {
  return normalizeHeaders(
    await canvasDeps.slackApi(workspace, "canvases.listHeaders", {
      _x_reason: "canvas-header-images",
    }),
  );
}

function normalizeHeaders(
  payload: Record<string, unknown>,
): { id: string; name: string; title: string }[] {
  const raw = arrayValue(payload.headers).length
    ? arrayValue(payload.headers)
    : arrayValue(payload.canvas_headers);
  return raw
    .map((entry) => {
      const record = isRecord(entry) ? entry : {};
      const id =
        stringValue(record.id) ?? stringValue(record.header_id) ?? stringValue(record.name) ?? "";
      const name = stringValue(record.name) ?? id;
      const title = stringValue(record.title) ?? stringValue(record.label) ?? name;
      return { id, name, title };
    })
    .filter((entry) => entry.id);
}

function currentCoverId(file: CanvasFile): string | undefined {
  const { cover } = file;
  if (typeof cover === "string") {
    return cover || undefined;
  }
  if (isRecord(cover)) {
    return stringValue(cover.header_id) ?? stringValue(cover.id) ?? stringValue(cover.name);
  }
  return stringValue(file.cover_header_id) ?? stringValue(file.header_id);
}

function coverIdFromStrings(strings: string[], headerIds: string[]): string | undefined {
  return headerIds.find((headerId) => strings.includes(headerId));
}

function titleSectionIdForCover(model: CanvasModel): string {
  return (
    titleBlockId(model.file) ??
    model.sections.find((section) => section.type === "h1")?.id ??
    `temp:C:${model.docId.slice(0, 3)}${randomUUID().replaceAll("-", "").slice(0, 25)}`
  );
}

function titleBlockId(file: CanvasFile): string | undefined {
  const blocks = arrayValue(file.title_blocks);
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    const id = stringValue(block.block_id);
    if (id) {
      return id;
    }
  }
  return undefined;
}

function currentAccessLevel(file: CanvasFile): "read" | "write" | "invitation" | undefined {
  if (file.is_restricted_sharing_enabled === true) {
    return "invitation";
  }
  const value =
    stringValue(file.workspace_access) ??
    stringValue(file.cross_workspace_access) ??
    stringValue(file.access_level) ??
    stringValue(file.org_or_workspace_access);
  if (value === "read" || value === "write" || value === "invitation") {
    return value;
  }
  if (value === "none" || value === "private" || value === "restricted") {
    return "invitation";
  }
  return undefined;
}

function teamIdFromFile(file: CanvasFile): string | undefined {
  return stringValue(file.user_team) ?? stringValue(file.team_id);
}

function hasComment(model: CanvasModel, span: SpanTarget, text: string): boolean {
  const needle = JSON.stringify({ anchor: span.anchorId, text }).toLowerCase();
  return (
    model.comments.some(
      (comment) =>
        JSON.stringify(comment).toLowerCase().includes(span.anchorId.toLowerCase()) &&
        JSON.stringify(comment).toLowerCase().includes(text.toLowerCase()),
    ) || JSON.stringify(model.file).toLowerCase().includes(needle)
  );
}

function threadResolved(model: CanvasModel, threadTs: string): boolean {
  const threads = JSON.stringify(model.file);
  return (
    threads.includes(threadTs) &&
    (/"resolved"\s*:\s*true/.test(threads) || /"is_archived"\s*:\s*true/.test(threads))
  );
}

function commentThreadArchived(messages: Record<string, unknown>[]): boolean {
  return messages.some(
    (message) =>
      isRecord(message.document_comment) && message.document_comment.is_archived === true,
  );
}

function sharePayloadContains(payload: unknown, channel: string): boolean {
  return JSON.stringify(payload).includes(channel);
}

function accessGrantReached(
  file: CanvasFile,
  shares: unknown,
  target: AccessTarget,
  level?: "read" | "write",
): boolean {
  return extractAccessGrants(file, shares).some((grant) => {
    const targetMatches =
      target.kind === "user"
        ? grant.target === target.id
        : grant.target === target.channel || grant.channel === target.channel;
    if (!targetMatches) {
      return false;
    }
    return !level || grant.level === level || (target.kind === "channel" && grant.level == null);
  });
}

function extractAccessGrants(
  file: CanvasFile,
  shares: unknown,
): { kind: string; target: string; channel?: string; level?: string }[] {
  const grants: { kind: string; target: string; channel?: string; level?: string }[] = [];
  const visit = (value: unknown, inheritedChannel?: string): void => {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, inheritedChannel);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const channel = stringValue(value.channel) ?? stringValue(value.channel_id) ?? inheritedChannel;
    const user =
      stringValue(value.user) ?? stringValue(value.user_id) ?? stringValue(value.slack_user_id);
    const target = user ?? channel ?? stringValue(value.target) ?? stringValue(value.entity_id);
    const level =
      stringValue(value.grant) ??
      stringValue(value.access_level) ??
      stringValue(value.level) ??
      stringValue(value.access);
    if (target) {
      grants.push({ kind: user ? "user" : "channel", target, channel, level });
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, /^[CDG][A-Z0-9]{8,}$/.test(key) ? key : channel);
    }
  };
  visit(file.shares);
  visit(shares);
  return dedupeGrants(grants);
}

function dedupeGrants(
  grants: { kind: string; target: string; channel?: string; level?: string }[],
): { kind: string; target: string; channel?: string; level?: string }[] {
  const seen = new Set<string>();
  return grants.filter((grant) => {
    const key = `${grant.kind}\0${grant.target}\0${grant.channel ?? ""}\0${grant.level ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isStarred(file: CanvasFile): boolean {
  return file.is_starred === true || file.starred === true;
}

async function resolveAccessTarget(
  workspace: CanvasWorkspace,
  parsed: ParsedArgs,
): Promise<AccessTarget> {
  const channel = value(parsed, "--channel");
  if (channel) {
    return { kind: "channel", id: channel, channel };
  }
  const user = value(parsed, "--user") ?? requiredPositional(parsed, 1, "user-or-channel");
  const resolved = userIdFromUserPayload(await resolveSlackUser(workspace, user));
  const payload = await canvasDeps.slackApi(workspace, "conversations.open", { users: resolved });
  if (
    payload.channel &&
    typeof payload.channel === "object" &&
    "id" in payload.channel &&
    typeof payload.channel.id === "string"
  ) {
    return { kind: "user", id: resolved, channel: payload.channel.id };
  }
  throw new Error(`Could not open direct message for ${user}`);
}

async function resolveSlackUser(
  workspace: CanvasWorkspace,
  input: string,
): Promise<Record<string, unknown>> {
  const normalized = input.replace(/^@/, "");
  if (/^(?:U|W)[A-Z0-9]{8,}$/.test(normalized)) {
    const payload = await canvasDeps.slackApi(workspace, "users.info", { user: normalized });
    return userIdFromUserPayloadMaybe(payload)
      ? payload
      : { ok: true, user: { id: normalized }, response: payload };
  }
  const listed = await canvasDeps.slackApi(workspace, "users.list", {
    limit: 1000,
    include_locale: true,
  });
  const members = recordArray(listed.members);
  const lower = normalized.toLowerCase();
  const member = members.find((candidate) => {
    const profile = isRecord(candidate.profile) ? candidate.profile : {};
    return [
      candidate.name,
      profile.display_name,
      profile.real_name,
      profile.display_name_normalized,
      profile.real_name_normalized,
    ]
      .map((value) => (typeof value === "string" ? value.replace(/^@/, "").toLowerCase() : ""))
      .includes(lower);
  });
  if (!member) {
    throw new CanvasCommandError("user_not_found", `user not found: ${input}`);
  }
  return { ok: true, user: member };
}

function userIdFromUserPayload(payload: Record<string, unknown>): string {
  const id = userIdFromUserPayloadMaybe(payload);
  if (!id) {
    throw new CanvasCommandError("user_not_found", "resolved user payload did not contain an id");
  }
  return id;
}

function userIdFromUserPayloadMaybe(payload: Record<string, unknown>): string | undefined {
  const user = isRecord(payload.user) ? payload.user : payload;
  return stringValue(user.id);
}

function accessLevel(raw: string, allowInvitation: false): "read" | "write";
function accessLevel(raw: string, allowInvitation: true): "read" | "write" | "invitation";
function accessLevel(raw: string, allowInvitation: boolean): "read" | "write" | "invitation" {
  const val = raw.toLowerCase();
  if (val === "viewer" || val === "view" || val === "read") {
    return "read";
  }
  if (val === "editor" || val === "edit" || val === "write") {
    return "write";
  }
  if (allowInvitation && (val === "invitation" || val === "private" || val === "restricted")) {
    return "invitation";
  }
  throw new Error(`Unknown access level: ${raw}`);
}

function countShareEntries(payload: unknown): number {
  if (!isRecord(payload)) {
    return 0;
  }
  const shares = isRecord(payload.shares) ? payload.shares : payload;
  let total = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      total += value.length;
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  visit(shares);
  return total;
}

async function mutationAlreadyRecorded(
  key: string,
  canvasId: string,
  file?: CanvasFile,
): Promise<boolean> {
  const memory = mutationMemory.get(key);
  if (memory && mutationEntryValid(memory, canvasId, file)) {
    return true;
  }
  if (outputSink) {
    return false;
  }
  const entries = await readMutationEntries();
  const entry = entries[key];
  if (!entry || !mutationEntryValid(entry, canvasId, file)) {
    return false;
  }
  mutationMemory.set(key, entry);
  return true;
}

async function recordMutation(key: string, canvasId: string, file?: CanvasFile): Promise<void> {
  const entry = {
    canvas_id: canvasId,
    file_updated: fileMutationVersion(file),
    expires_at: Date.now() + IDEMPOTENCY_CACHE_TTL_MS,
  };
  for (const [entryKey, value] of mutationMemory.entries()) {
    if (value.canvas_id === canvasId && entryKey !== key) {
      mutationMemory.delete(entryKey);
    }
  }
  mutationMemory.set(key, entry);
  if (outputSink) {
    return;
  }
  try {
    const entries = await readMutationEntries();
    const now = Date.now();
    for (const [entryKey, value] of Object.entries(entries)) {
      if (value.canvas_id === canvasId && entryKey !== key) {
        delete entries[entryKey];
      }
    }
    entries[key] = entry;
    for (const [entryKey, value] of Object.entries(entries)) {
      if (value.expires_at <= now) {
        delete entries[entryKey];
      }
    }
    await mkdir(IDEMPOTENCY_CACHE_DIR, { recursive: true });
    await writeFile(
      IDEMPOTENCY_CACHE_FILE,
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The Slack mutation already succeeded; cache persistence is only an idempotency hint.
  }
}

async function readMutationEntries(): Promise<Record<string, MutationEntry>> {
  try {
    const payload = JSON.parse(await readFile(IDEMPOTENCY_CACHE_FILE, "utf8")) as unknown;
    return isRecord(payload) && isRecord(payload.entries)
      ? (payload.entries as Record<string, MutationEntry>)
      : {};
  } catch {
    return {};
  }
}

function mutationEntryValid(entry: MutationEntry, canvasId: string, file?: CanvasFile): boolean {
  if (entry.canvas_id !== canvasId || entry.expires_at <= Date.now()) {
    return false;
  }
  const version = fileMutationVersion(file);
  if (version != null && entry.file_updated !== version) {
    return false;
  }
  return true;
}

function fileMutationVersion(file?: CanvasFile): number | undefined {
  return (
    numberValue(file?.updated) ?? numberValue(file?.edit_timestamp) ?? numberValue(file?.timestamp)
  );
}

function writeOutput(payload: unknown, options: CanvasOutputOptions = {}): void {
  const text = serializeCanvasOutput(payload, { ...activeGlobals, ...options });
  if (outputSink) {
    outputSink.push(text);
  } else {
    process.stdout.write(text);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let formatExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    let val = eq > 0 ? arg.slice(eq + 1) : undefined;
    if (val == null && args[i + 1] && !args[i + 1].startsWith("--")) {
      val = args[++i];
    }
    if (val == null) {
      val = "true";
    }
    if (key === "--format") {
      formatExplicit = true;
    }
    const list = flags.get(key) ?? [];
    list.push(val);
    flags.set(key, list);
  }
  return { positionals, flags, formatExplicit };
}

function globalsFrom(parsed: ParsedArgs): Globals {
  const format = value(parsed, "--format") as CanvasFormat | undefined;
  if (format && format !== "json" && format !== "toon") {
    throw new Error("--format must be json or toon");
  }
  const fields = value(parsed, "--fields")
    ?.split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const maxCharsRaw = value(parsed, "--max-chars");
  return {
    workspace: value(parsed, "--workspace"),
    format,
    formatExplicit: parsed.formatExplicit,
    fields,
    maxChars: maxCharsRaw ? clampInt(maxCharsRaw, 1, Number.MAX_SAFE_INTEGER) : undefined,
    full: bool(parsed, "--full"),
    idempotencyKey: value(parsed, "--idempotency-key"),
    debug: bool(parsed, "--debug"),
  };
}

function parsedWithPositionals(parsed: ParsedArgs, positionals: string[]): ParsedArgs {
  return { ...parsed, positionals };
}

function withFlag(parsed: ParsedArgs, flag: string, value: string): ParsedArgs {
  const flags = new Map(parsed.flags);
  flags.set(flag, [value]);
  return { ...parsed, flags };
}

function withStdinText(parsed: ParsedArgs, text: string): ParsedArgs {
  injectedStdinText = text;
  return parsed;
}

async function readTextArg(arg: string): Promise<string> {
  const injected = activeInjectedText();
  if (arg === "-" && injected != null) {
    return injected;
  }
  if (arg === "-") {
    return await readProcessStdin();
  }
  return await readFile(arg, "utf8");
}

async function readProcessStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

function activeInjectedText(): string | undefined {
  return injectedStdinText;
}

function targetFromArg(input: string): { canvasId: string; workspaceUrl?: string } {
  if (isCanvasId(input)) {
    return { canvasId: input };
  }
  const ref = parseSlackCanvasRef(input);
  return { canvasId: ref.canvasId, workspaceUrl: ref.workspaceUrl };
}

function idempotencyKey(
  command: string,
  canvasId?: string,
  content?: string,
  options?: Record<string, unknown>,
): string {
  return deriveCanvasIdempotencyKey({
    explicit: activeGlobals.idempotencyKey,
    workspace: activeGlobals.workspace,
    command,
    canvasId,
    content,
    options,
  });
}

function value(parsed: ParsedArgs, flag: string): string | undefined {
  return parsed.flags.get(flag)?.at(-1);
}

function requiredFlag(parsed: ParsedArgs, flag: string): string {
  const val = value(parsed, flag);
  if (!val || val === "true") {
    throw new Error(`Missing ${flag}`);
  }
  return val;
}

function bool(parsed: ParsedArgs, flag: string): boolean {
  const val = value(parsed, flag);
  return val === "true" || val === "1" || val === "yes";
}

function requiredPositional(parsed: ParsedArgs, index: number, label: string): string {
  const val = parsed.positionals[index];
  if (!val) {
    throw new Error(`Missing ${label}`);
  }
  return val;
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected integer, got ${raw}`);
  }
  return Math.min(Math.max(n, min), max);
}

function normalizedMarkdown(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function markdownWithLeadingTitle(title: string, markdown: string): string {
  const trimmed = markdown.replace(/^\s+/, "");
  if (!trimmed) {
    return `# ${title}`;
  }
  if (/^#\s+\S.*(?:\n|$)/.test(trimmed)) {
    return trimmed.replace(/^#\s+.*(?:\n|$)/, (match) =>
      match.endsWith("\n") ? `# ${title}\n` : `# ${title}`,
    );
  }
  return `# ${title}\n\n${trimmed}`;
}

function sectionsFromMarkdown(markdown: string): CanvasSection[] {
  const blocks = normalizedMarkdown(markdown)
    .split(/\n{2,}/)
    .filter(Boolean);
  return blocks.map((text, index) => ({
    id: `markdown:${index + 1}`,
    type: "markdown",
    text: decodePrivateBodyText(text).replace(/\s+/g, " ").trim(),
  }));
}

function fileChannelFromCanvasId(canvasId: string): string {
  return canvasId.startsWith("F") ? `C${canvasId.slice(1)}` : canvasId;
}

function stableSessionId(canvasId: string, docId: string): string {
  return createHash("sha1").update(`${canvasId}\0${docId}`).digest("hex").slice(0, 16);
}

function stableAnnotationId(sectionId: string, quote: string, occurrence: string): string {
  const prefix = sectionId.match(/^temp:C:([A-Za-z0-9]{3})/)?.[1] ?? "CaW";
  return `temp:C:${prefix}${createHash("sha1").update(`${sectionId}\0${quote}\0${occurrence}`).digest("hex").slice(0, 25)}`;
}

function threadTsForAnnotation(anchorId: string): string {
  const digest = createHash("sha1").update(anchorId).digest("hex");
  const seconds = 1_700_000_000 + (Number.parseInt(digest.slice(0, 6), 16) % 90_000_000);
  return `${seconds}.${digest.slice(6, 12).padEnd(6, "0")}`;
}

function nthOccurrenceIndex(text: string, quote: string, occurrence: number): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = text.indexOf(quote, offset);
    if (index < 0) {
      return -1;
    }
    count++;
    if (count === occurrence) {
      return index;
    }
    offset = index + quote.length;
  }
}

function canvasIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const candidates = [
    stringValue(payload.canvas_id),
    stringValue(payload.file_id),
    isRecord(payload.canvas) ? stringValue(payload.canvas.id) : undefined,
    isRecord(payload.file) ? stringValue(payload.file.id) : undefined,
  ];
  return candidates.find((candidate) => candidate && isCanvasId(candidate));
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  return stringValue(payload[field]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workspaceSummary(workspace: CanvasWorkspace): Record<string, unknown> {
  return {
    workspace_url: workspace.workspace_url,
    workspace_name: workspace.workspace_name,
    team_id: workspace.team_id,
    auth: "browser",
  };
}

function numberFromPaging(paging?: Record<string, unknown>): number | undefined {
  const total = paging?.total;
  return typeof total === "number" ? total : undefined;
}

function pagingHasMore(paging?: Record<string, unknown>): boolean | undefined {
  const page = typeof paging?.page === "number" ? paging.page : undefined;
  const pages = typeof paging?.pages === "number" ? paging.pages : undefined;
  return page != null && pages != null ? page < pages : undefined;
}

function detectShell(): "zsh" | "bash" {
  return process.env.SHELL?.includes("bash") ? "bash" : "zsh";
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripEmojiColons(input: string): string {
  return input.replace(/^:+|:+$/g, "");
}

export function __testParsePrivateMarkdownBlocks(markdown: string): Record<string, unknown>[] {
  return parsePrivateMarkdownBlocks(markdown).map((block) => {
    if (block.kind === "list") {
      return { kind: block.kind, style: block.style, items: block.items };
    }
    if (block.kind === "table") {
      return { kind: block.kind, rows: block.rows };
    }
    if (block.kind === "embed") {
      return { kind: block.kind, embed_type: block.embed_type, url: block.url, text: block.text };
    }
    return pruneEmpty({ kind: block.kind, type: block.type, style: block.style, text: block.text });
  });
}

export function __testEncodePrivateBodyText(input: string): string {
  return parsePrivateInlineBodyText(input);
}

export function __testDecodePrivateBodyText(input: string): string {
  return decodePrivateBodyText(input);
}

export function __testBuildPrivateMarkdownDocumentStrings(markdown: string): string[] {
  return buildPrivateMarkdownDocumentStrings({
    threadId: "ABC9DEFGHIJ",
    docId: "DOC12345678",
    markdown,
  });
}

export function __testBuildEditDocumentBody(
  model: Partial<CanvasModel>,
  data: Buffer,
): URLSearchParams {
  return buildEditDocumentBody(
    {
      canvasId: model.canvasId ?? "F0TESTCANVAS",
      file: model.file ?? { id: "F0TESTCANVAS", title: "Test", quip_thread_id: "THREAD1" },
      markdown: model.markdown ?? "",
      title: model.title ?? "Test",
      threadId: model.threadId ?? "THREAD1",
      docId: model.docId ?? "DOC1",
      sequence: model.sequence ?? 1,
      session: model.session ?? "SESSION1",
      editorUserId: model.editorUserId ?? "USER1",
      fileChannel: model.fileChannel ?? "C0TESTCANVAS",
      sections: model.sections ?? [],
      resources: model.resources ?? [],
      comments: model.comments ?? [],
      reactions: model.reactions ?? [],
    },
    data,
  );
}

function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => pruneEmpty(item)).filter((item) => item !== undefined) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = pruneEmpty(child);
    if (next === undefined || next === null) {
      continue;
    }
    if (Array.isArray(next) && next.length === 0) {
      continue;
    }
    if (
      next &&
      typeof next === "object" &&
      !Array.isArray(next) &&
      Object.keys(next).length === 0
    ) {
      continue;
    }
    out[key] = next;
  }
  return out as T;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify(buildErrorEnvelope(error, activeGlobals.debug ? { argv: process.argv.slice(2) } : undefined), null, 2)}\n`,
    );
    process.exit(1);
  });
}
