// @ts-nocheck
// Allowlist of URL forms that may appear inside an `<a href>` we emit on a
// Slack canvas. Anything outside this list (javascript:, data:, vbscript:,
// file:, about:, protocol-relative `//host/x`, in-page `#anchor` — Slack's
// server rejects fragment-only hrefs with `Invalid section content`, …) is
// rejected by the encoder so an attacker-controlled link can't smuggle a
// dangerous scheme through us into Slack's renderer, and so we don't try to
// write hrefs Slack will reject. The same regex is referenced by the
// validator so a caller using `canvas validate` learns about a dropped
// scheme up-front.
export const PRIVATE_SAFE_LINK_SCHEME_RE = /^(?:https?:|mailto:|tel:|slack:|\/(?!\/))/i;

// Markdown link / autolink shape, exported so the encoder and the validator
// agree on what counts as a candidate link.
export const PRIVATE_INLINE_LINK_RE =
  /(?<!!)\[([^\]\n]+)]\(\s*<?([^<>)\s]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|<((?:https?|mailto):[^>\s]+)>/gi;

export type CanvasRef = {
  canvasId: string;
  workspaceUrl?: string;
  raw: string;
};

export type CanvasChangeOperation =
  | "insert_after"
  | "insert_before"
  | "insert_at_start"
  | "insert_at_end"
  | "replace"
  | "delete";

export type CanvasChange = {
  operation: CanvasChangeOperation;
  section_id?: string;
  document_content?: {
    type: "markdown";
    markdown: string;
  };
};

export type SpecialInsertion = {
  type: "date" | "slack_date" | "today_text";
  text: string;
  value?: string;
};

export type CanvasResource = {
  type: "image" | "slack_file" | "slack_canvas" | "slack_message" | "link";
  url: string;
  text?: string;
  id?: string;
  kind?: "image" | "file" | "canvas" | "message" | "link";
  section_id?: string;
  file_id?: string;
  canvas_id?: string;
  channel?: string;
  message_ts?: string;
};

export type CanvasSection = {
  id: string;
  type: string;
  text: string;
};

export type CanvasMarkdownIssue = {
  line: number;
  code: string;
  feature: string;
  message: string;
};

export type CanvasMarkdownInspection = {
  features: string[];
  issues: CanvasMarkdownIssue[];
};

const CANVAS_ID_RE = /^F[A-Z0-9]{8,}$/;
const SECTION_ID_RE = /^temp:C:[A-Za-z0-9]+$/;

export function isCanvasId(value: string): boolean {
  return CANVAS_ID_RE.test(value.trim());
}

export function parseSlackCanvasRef(input: string): CanvasRef {
  const trimmed = input.trim();
  if (isCanvasId(trimmed)) {return { canvasId: trimmed, raw: input };}

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `Unsupported canvas input: ${input} (expected Slack canvas URL or id like F...)`,
    );
  }

  if (!/\.slack\.com$/i.test(url.hostname)) {
    throw new Error(`Not a Slack workspace URL: ${url.hostname}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "docs") {
    throw new Error(`Unsupported Slack canvas URL path: ${url.pathname}`);
  }
  const canvasId = parts.find(isCanvasId);
  if (!canvasId) {
    throw new Error(`Could not find canvas id in: ${url.pathname}`);
  }
  return {
    canvasId,
    workspaceUrl: `${url.protocol}//${url.host}`,
    raw: input,
  };
}

export function normalizeWorkspaceUrl(input: string): string {
  const url = new URL(input);
  return `${url.protocol}//${url.host}`;
}

export function buildSlackCanvasUrl(
  workspaceUrl: string,
  canvasId: string,
  teamId?: string,
): string {
  const teamPart = teamId ? `/${teamId}` : "";
  return `${workspaceUrl.replace(/\/$/, "")}/docs${teamPart}/${canvasId}`;
}

export function defaultCanvasWorkDir(canvasId: string): string {
  return `/tmp/agent-slack-canvas-${canvasId}`;
}

export function buildCanvasChange(input: {
  operation: CanvasChangeOperation;
  markdown?: string;
  sectionId?: string;
}): CanvasChange {
  const { operation, markdown, sectionId } = input;
  if ((operation === "insert_after" || operation === "insert_before") && !sectionId) {
    throw new Error(`${operation} requires --section-id`);
  }
  if ((operation === "delete") !== (markdown == null)) {
    throw new Error(
      operation === "delete"
        ? "delete does not accept markdown content"
        : `${operation} requires markdown content`,
    );
  }
  if (sectionId && !SECTION_ID_RE.test(sectionId)) {
    throw new Error(`Invalid section id: ${sectionId}`);
  }
  const change: CanvasChange = { operation };
  if (sectionId) {change.section_id = sectionId;}
  if (markdown != null) {
    change.document_content = { type: "markdown", markdown };
  }
  return change;
}

export function buildRenameChange(title: string): {
  operation: "rename";
  title_content: { type: "markdown"; markdown: string };
} {
  const markdown = title.trim();
  if (!markdown) {throw new Error("Canvas title cannot be empty");}
  return { operation: "rename", title_content: { type: "markdown", markdown } };
}

export function parsePositiveInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {throw new Error(`${label} must be a positive integer`);}
  return n;
}

export function extractSpecialInsertions(html: string): SpecialInsertion[] {
  const out: SpecialInsertion[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<time\b([^>]*)>(.*?)<\/time>/gis)) {
    const attrs = match[1] ?? "";
    const text = stripHtml(match[2] ?? "").trim();
    const datetime = attrValue(attrs, "datetime") ?? attrValue(attrs, "data-date") ?? undefined;
    pushUnique(out, seen, { type: "date", text, value: datetime });
  }
  for (const match of html.matchAll(
    /&lt;!date\^([^|&]+)(?:\|([^&]*))?&gt;|<!date\^([^|>]+)(?:\|([^>]*))?>/g,
  )) {
    const value = match[1] ?? match[3];
    const text = (match[2] ?? match[4] ?? "").trim();
    pushUnique(out, seen, { type: "slack_date", text, value });
  }
  for (const match of html.matchAll(/>([^<>]*(?:Today|Tomorrow|Yesterday)[^<>]*)</g)) {
    const text = stripHtml(match[1] ?? "").trim();
    if (/^(Today|Tomorrow|Yesterday)\b/i.test(text)) {
      pushUnique(out, seen, { type: "today_text", text });
    }
  }
  return out;
}

export function extractCanvasResources(html: string): CanvasResource[] {
  const out: CanvasResource[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const src = attrValue(attrs, "src");
    if (!src) {continue;}
    pushResource(out, seen, {
      type: classifyResource(src, true),
      url: decodeHtmlEntities(src),
      text: attrValue(attrs, "alt") ?? undefined,
    });
  }
  for (const match of html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gis)) {
    const attrs = match[1] ?? "";
    const href = attrValue(attrs, "href");
    if (!href) {continue;}
    pushResource(out, seen, {
      type: classifyResource(href, false),
      url: decodeHtmlEntities(href),
      text: stripHtml(match[2] ?? "").trim() || undefined,
    });
  }
  return out;
}

export function extractCanvasSections(html: string): CanvasSection[] {
  const out: CanvasSection[] = [];
  for (const match of html.matchAll(/<(h[1-6]|p|li|blockquote)\b([^>]*)>(.*?)<\/\1>/gis)) {
    const type = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    const id = attrValue(attrs, "id");
    if (!id) {continue;}
    const text = stripHtml(match[3] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ id, type, text });
  }
  return out;
}

export function hydrateCanvasHtmlControls(html: string, strings: string[]): string {
  if (!html.includes("<control") || strings.length === 0) {return html;}
  const labels = controlLabelsFromCanvasStrings([html, ...strings]);
  if (labels.size === 0) {return html;}
  return html.replace(/<control\b([^>]*)><\/control>/gi, (match, attrs) => {
    const id = attrValue(attrs ?? "", "id");
    const label = id ? labels.get(id) : undefined;
    return label ? escapeHtmlText(label) : match;
  });
}

export function canvasHtmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  for (const match of html.matchAll(
    /<(h[1-6]|p|blockquote|pre|ul|ol|table)\b([^>]*)>(.*?)<\/\1>/gis,
  )) {
    const tag = match[1]?.toLowerCase();
    const attrs = match[2] ?? "";
    const body = match[3] ?? "";
    if (!tag) {continue;}
    if (/^h[1-6]$/.test(tag)) {
      const text = markdownTextFromHtml(body).replace(/\s+/g, " ").trim();
      if (text) {blocks.push(`${"#".repeat(Number(tag.slice(1)))} ${text}`);}
      continue;
    }
    if (tag === "blockquote") {
      const text = markdownTextFromHtml(body).replace(/\s+/g, " ").trim();
      if (text)
        {blocks.push(
          text
            .split(/\n+/)
            .map((line) => `> ${line}`)
            .join("\n"),
        );}
      continue;
    }
    if (tag === "pre") {
      const text = stripHtml(body).trim();
      if (text) {blocks.push(["```", text, "```"].join("\n"));}
      continue;
    }
    if (tag === "p" && /\bprettyprint\b/i.test(attrs)) {
      const text = markdownTextFromHtml(body)
        .replace(/^\s*```\s*\n?/, "")
        .trim();
      if (text) {
        const language = text.match(/^([A-Za-z][A-Za-z0-9_+-]{0,24})\n([\s\S]+)/);
        blocks.push(
          language
            ? [`\`\`\`${language[1]}`, language[2], "```"].join("\n")
            : ["```", text, "```"].join("\n"),
        );
      }
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      const items = [...body.matchAll(/<li\b[^>]*>(.*?)<\/li>/gis)]
        .map((li) =>
          markdownTextFromHtml(li[1] ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean);
      if (items.length) {
        blocks.push(
          items
            .map((item, index) => (tag === "ol" ? `${index + 1}. ${item}` : `- ${item}`))
            .join("\n"),
        );
      }
      continue;
    }
    if (tag === "table") {
      const table = htmlTableToMarkdown(body);
      if (table) {blocks.push(table);}
      continue;
    }
    const text = markdownTextFromHtml(body).replace(/\s+/g, " ").trim();
    if (text) {blocks.push(text);}
  }
  return blocks.join("\n\n");
}

export function inspectCanvasMarkdown(markdown: string): CanvasMarkdownInspection {
  const issues: CanvasMarkdownIssue[] = [];
  const features = new Set<string>();
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceStart = 0;

  const addFeature = (feature: string) => features.add(feature);
  const addIssue = (line: number, code: string, feature: string, message: string) => {
    addFeature(feature);
    if (issues.some((issue) => issue.line === line && issue.code === code)) {return;}
    issues.push({ line, code, feature, message });
  };

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (inFence) {
      if (trimmed.startsWith('```')) {
        inFence = false;
      }
      continue;
    }

    if (!trimmed) {continue;}

    if (trimmed.startsWith('```')) {
      inFence = true;
      fenceStart = lineNumber;
      addFeature("code_block");
      continue;
    }

    if (/^#{1,3}\s+\S/.test(trimmed)) {
      addFeature(`h${trimmed.match(/^#+/)![0].length}`);
    } else if (/^#{4,6}\s+\S/.test(trimmed)) {
      addIssue(
        lineNumber,
        "heading_level",
        "heading",
        "Slack Canvas API markdown only supports headings H1-H3.",
      );
    } else if (/^\s*[-*+]\s+\[[ xX]\]\s+\S/.test(line)) {
      addFeature("checklist");
    } else if (/^\s*[-*+]\s+\S/.test(line)) {
      addFeature("bullet_list");
    } else if (/^\s*\d+[.)]\s+\S/.test(line)) {
      addFeature("ordered_list");
    } else if (/^>\s?/.test(trimmed)) {
      addFeature("quote");
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      addFeature("divider");
    } else {
      addFeature("paragraph");
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      addFeature("table");
    }
    if (/!\[[^\]]*]\([^)]+\)/.test(line)) {
      addFeature("embed");
    }
    // Inline links register as a feature, but markdown links whose URL
    // scheme isn't in the encoder's allowlist surface a `link_scheme_dropped`
    // warning so the caller knows their link will render as plain text.
    const linkMatches = Array.from(line.matchAll(new RegExp(PRIVATE_INLINE_LINK_RE.source, "gi")));
    for (const match of linkMatches) {
      addFeature("inline_link");
      const url = match[2] ?? match[3] ?? "";
      if (url && !PRIVATE_SAFE_LINK_SCHEME_RE.test(url)) {
        addIssue(
          lineNumber,
          "link_scheme_dropped",
          "inline_link",
          `URL scheme not in encoder allowlist; will render as plain text: ${url}`,
        );
      }
    }
    if (/(^|[^!])!\[]\((@|#)[^)]+\)|<[@#][^>]+>/.test(line)) {
      addFeature("mention");
    }
    if (/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|(^|[^*])\*[^*\s][^*]*\*)/.test(line)) {
      addFeature("inline_formatting");
    }
    if (/<!date\^/.test(line) || /\{\{\s*(today|date|now)\s*}}/i.test(line)) {
      addFeature("date_variable");
    }
    if (/^:::+/.test(trimmed) || /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(trimmed)) {
      addIssue(
        lineNumber,
        "callout",
        "callout",
        "Callout syntax is not part of Slack Canvas markdown and will be written as plain text.",
      );
    }
    if (
      /<\/?(table|thead|tbody|tr|td|th|ul|ol|li|input|blockquote|pre|code|img|video|iframe|hr|br|div|section|aside)\b/i.test(
        line,
      )
    ) {
      addIssue(
        lineNumber,
        "html",
        "html",
        "Raw HTML is not accepted as Canvas markdown; use markdown or a native Canvas command.",
      );
    }
  }

  if (inFence)
    {addIssue(fenceStart, "code_block_unclosed", "code_block", "Code block is not closed.");}
  return { features: [...features].sort(), issues };
}

export function validatePrivateCanvasMarkdown(
  markdown: string,
  operation: CanvasChangeOperation,
): CanvasMarkdownInspection & { ok: boolean } {
  const inspection = inspectCanvasMarkdown(markdown);
  const issues = [...inspection.issues];
  if (operation === "replace") {inspection.features.push("whole_canvas_replace");}
  if (operation === "insert_after" || operation === "insert_before")
    {inspection.features.push("section_edit");}
  return { features: inspection.features, issues, ok: issues.length === 0 };
}

export function buildAttachmentMarkdown(url: string, alt?: string): string {
  const trimmed = url.trim();
  if (!trimmed) {throw new Error("Attachment URL cannot be empty");}
  const label = (alt || basenameFromUrl(trimmed) || "attachment").replaceAll("]", "\\]");
  if (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(trimmed)) {
    return `![${label}](${trimmed})`;
  }
  return `[${label}](${trimmed})`;
}

function pushUnique(out: SpecialInsertion[], seen: Set<string>, item: SpecialInsertion): void {
  const key = `${item.type}\0${item.text}\0${item.value ?? ""}`;
  if (seen.has(key)) {return;}
  seen.add(key);
  out.push(item);
}

function pushResource(out: CanvasResource[], seen: Set<string>, item: CanvasResource): void {
  const key = `${item.type}\0${item.url}`;
  if (seen.has(key)) {return;}
  seen.add(key);
  out.push(item);
}

function classifyResource(url: string, image: boolean): CanvasResource["type"] {
  if (image) {return "image";}
  if (/\/docs\/[^/]+\/F[A-Z0-9]{8,}/.test(url) || /\/docs\/F[A-Z0-9]{8,}/.test(url))
    {return "slack_canvas";}
  if (/\/archives\/[CGD][A-Z0-9]+\/p\d+/.test(url)) {return "slack_message";}
  if (/\/files\/[UW][A-Z0-9]+\/F[A-Z0-9]+/.test(url) || /files-pri\/[^/]+-F[A-Z0-9]+/.test(url))
    {return "slack_file";}
  return "link";
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = attrs.match(re);
  if (!match) {return null;}
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

function controlLabelsFromCanvasStrings(strings: string[]): Map<string, string> {
  const ids = new Set<string>();
  for (const value of strings) {
    for (const match of value.matchAll(
      /<control\b[^>]*\bid=(?:"([^"]+)"|'([^']*)'|([^\s>]+))[^>]*><\/control>/gi,
    )) {
      const id = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
      if (id) {ids.add(id);}
    }
  }
  const labels = new Map<string, string>();
  for (const id of ids) {
    const label = controlLabelForId(strings, id);
    if (label) {labels.set(id, label);}
  }
  return labels;
}

function controlLabelForId(strings: string[], id: string): string | undefined {
  for (let i = 0; i < strings.length; i++) {
    if (strings[i] !== id) {continue;}
    for (let j = i + 1; j < Math.min(strings.length, i + 12); j++) {
      const label = normalizeControlLabel(strings[j]);
      if (label) {return label;}
    }
  }
  return undefined;
}

function normalizeControlLabel(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {return undefined;}
  const user = trimmed.match(/^su:((?:U|W)[A-Z0-9]{8,})$/);
  if (user) {return `@${user[1]}`;}
  const channel = trimmed.match(/^sc:([CDG][A-Z0-9]{8,})$/);
  if (channel) {return `<#${channel[1]}>`;}
  const file = trimmed.match(/^sf:(F[A-Z0-9]{8,})$/);
  if (file) {return `slack-file://${file[1]}`;}
  const canvas = trimmed.match(/^sd:(F[A-Z0-9]{8,})$/);
  if (canvas) {return canvas[1];}
  if (isInternalCanvasString(trimmed)) {return undefined;}
  return trimmed;
}

function isInternalCanvasString(value: string): boolean {
  return (
    /^temp:C:[A-Za-z0-9]+$/.test(value) ||
    value.startsWith('agent-slack-') ||
    /^(?:a[a-z]{1,7}|z[a-z]{1,7}|[a-z]+-orphaned-m)$/.test(value) ||
    /^(?:U|W|T)[A-Z0-9]{8,}$/.test(value) ||
    /^(?:CaW|BdO)[A-Za-z0-9]{6,}$/.test(value) ||
    /^O[A-Za-z0-9]{8,}$/.test(value) ||
    value === "rich_text"
  );
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(input.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
}

function escapeHtmlText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownTextFromHtml(input: string): string {
  const formatted = input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_match, _tag, body) => `**${markdownTextFromHtml(body)}**`,
    )
    .replace(
      /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_match, _tag, body) => `*${markdownTextFromHtml(body)}*`,
    )
    .replace(
      /<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_match, _tag, body) => `~~${markdownTextFromHtml(body)}~~`,
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, body) => `\`${stripHtml(body)}\``);
  const anchorRe = /<(a|lnk)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let out = "";
  let last = 0;
  for (const match of formatted.matchAll(anchorRe)) {
    const index = match.index ?? 0;
    out += stripHtml(formatted.slice(last, index));
    const href = attrValue(match[2] ?? "", "href");
    const label = stripHtml(match[3] ?? "").trim();
    out +=
      href && label && href !== label
        ? `[${escapeMarkdownLinkLabel(label)}](${href})`
        : label || href || "";
    last = index + match[0].length;
  }
  out += stripHtml(formatted.slice(last));
  return out;
}

function escapeMarkdownLinkLabel(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basenameFromUrl(input: string): string {
  try {
    const url = new URL(input);
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "";
  } catch {
    const last = input.split("/").filter(Boolean).pop();
    return last ?? "";
  }
}

function htmlTableToMarkdown(input: string): string {
  const rows = [...input.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gis)]
    .map((row) =>
      [...(row[1] ?? "").matchAll(/<(th|td)\b[^>]*>(.*?)<\/\1>/gis)].map((cell) =>
        stripHtml(cell[2] ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    )
    .filter((row) => row.length > 0);
  if (!rows.length) {return "";}
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
  const header = normalized[0];
  const separator = header.map(() => "---");
  return [header, separator, ...normalized.slice(1)]
    .map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`)
    .join("\n");
}
