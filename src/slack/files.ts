import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SlackAuth } from "./client.ts";
import { existsSync } from "node:fs";
import { getUserAgent } from "../lib/version.ts";
import { htmlToMarkdown } from "./html-to-md.ts";
import { inferExt } from "./search-file-ext.ts";

export class SlackDownloadError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SlackDownloadError";
  }
}

export type DownloadResult =
  | { ok: true; path: string }
  | { ok: false; error: string; httpStatus?: number; path?: string };

export async function downloadSlackFile(input: {
  auth: SlackAuth;
  url: string;
  destDir: string;
  preferredName?: string;
  options?: { allowHtml?: boolean };
}): Promise<string> {
  const { auth, url, destDir, preferredName, options } = input;
  const absDir = resolve(destDir);
  await mkdir(absDir, { recursive: true });
  const name = sanitizeFilename(preferredName || basename(new URL(url).pathname) || "file");
  const path = join(absDir, name);

  if (existsSync(path)) {
    return path;
  }

  const headers: Record<string, string> = {};
  if (auth.auth_type === "standard") {
    headers.Authorization = `Bearer ${auth.token}`;
  } else {
    headers.Authorization = `Bearer ${auth.xoxc_token}`;
    headers.Cookie = `d=${encodeURIComponent(auth.xoxd_cookie)}`;
    headers.Referer = "https://app.slack.com/";
    headers["User-Agent"] = getUserAgent();
  }

  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch (err) {
    throw new SlackDownloadError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!resp.ok) {
    throw new SlackDownloadError(`Failed to download file (${resp.status})`, resp.status);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!options?.allowHtml && contentType.includes("text/html")) {
    let text: string;
    try {
      text = await resp.text();
    } catch (err) {
      throw new SlackDownloadError(
        `Failed to read download response body: ${err instanceof Error ? err.message : String(err)}`,
        resp.status,
      );
    }
    throw new SlackDownloadError(
      `Downloaded HTML instead of file (auth likely failed). First bytes: ${JSON.stringify(
        text.slice(0, 120),
      )}`,
      resp.status,
    );
  }
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await resp.arrayBuffer();
  } catch (err) {
    throw new SlackDownloadError(
      `Failed to read download response body: ${err instanceof Error ? err.message : String(err)}`,
      resp.status,
    );
  }
  const buf = Buffer.from(arrayBuffer);
  await writeFile(path, buf);
  return path;
}

export async function tryDownloadSlackFile(
  input: Parameters<typeof downloadSlackFile>[0],
): Promise<DownloadResult> {
  try {
    const path = await downloadSlackFile(input);
    return { ok: true, path };
  } catch (err) {
    if (err instanceof SlackDownloadError) {
      return { ok: false, error: err.message, httpStatus: err.httpStatus };
    }
    throw err;
  }
}

export async function writeDownloadErrorFile(input: {
  destDir: string;
  fileId: string;
  error: string;
}): Promise<string> {
  const absDir = resolve(input.destDir);
  await mkdir(absDir, { recursive: true });
  const path = join(absDir, sanitizeFilename(`${input.fileId}.download-error.txt`));
  await writeFile(path, `${input.error}\n`, "utf8");
  return path;
}

const CANVAS_MODES = new Set(["canvas", "quip", "docs"]);

function looksLikeAuthPage(html: string): boolean {
  return /<form[^>]+signin|data-qa="signin|<title>[^<]*Sign\s*in/i.test(html);
}

// Canvases download as HTML, which downloadSlackFile would otherwise report as
// an auth failure; convert them to markdown instead.
async function downloadCanvasAsMarkdown(input: {
  auth: SlackAuth;
  fileId: string;
  url: string;
  destDir: string;
}): Promise<string> {
  const htmlPath = await downloadSlackFile({
    auth: input.auth,
    url: input.url,
    destDir: input.destDir,
    preferredName: `${input.fileId}.html`,
    options: { allowHtml: true },
  });
  const html = await readFile(htmlPath, "utf8");
  if (looksLikeAuthPage(html)) {
    throw new SlackDownloadError(
      "Downloaded auth/login page instead of canvas content (token may be expired)",
    );
  }
  const markdownPath = join(resolve(input.destDir), sanitizeFilename(`${input.fileId}.md`));
  await writeFile(markdownPath, htmlToMarkdown(html).trim(), "utf8");
  return markdownPath;
}

/**
 * Download one Slack file into destDir: a canvas as markdown, anything else as
 * is. Returns null when the file has no download URL.
 */
export async function downloadSlackFileOrCanvas(input: {
  auth: SlackAuth;
  destDir: string;
  file: {
    id: string;
    mode?: string;
    mimetype?: string;
    filetype?: string;
    name?: string;
    title?: string;
    url_private?: string;
    url_private_download?: string;
  };
}): Promise<DownloadResult | null> {
  const { auth, destDir, file } = input;
  const isCanvas = file.mode != null && CANVAS_MODES.has(file.mode);
  const url = isCanvas
    ? file.url_private || file.url_private_download
    : file.url_private_download || file.url_private;
  if (!url) {
    return null;
  }
  if (!isCanvas) {
    const ext = inferExt(file);
    return tryDownloadSlackFile({
      auth,
      url,
      destDir,
      preferredName: `${file.id}${ext ? `.${ext}` : ""}`,
    });
  }
  try {
    const path = await downloadCanvasAsMarkdown({ auth, fileId: file.id, url, destDir });
    return { ok: true, path };
  } catch (err) {
    if (err instanceof SlackDownloadError) {
      return { ok: false, error: err.message, httpStatus: err.httpStatus };
    }
    throw err;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/<>:"|?*]/g, "_");
}
