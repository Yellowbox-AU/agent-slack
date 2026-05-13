// @ts-nocheck
import { createHash, randomUUID } from "crypto";

import { PRIVATE_INLINE_LINK_RE, PRIVATE_SAFE_LINK_SCHEME_RE } from "./canvas-lib.ts";

export const CANVAS_PROTO_TAGS = {
  bodyField: 12,
  bodyTextField: 1,
  titleRichTextField: 14,
  titleTextField: 58,
  channelMentionType: 49,
  channelMentionBodyField: 42,
  userMentionType: 50,
  userMentionBodyField: 44,
  linkUnfurlCardType: 56,
  linkUnfurlCardStyle: 44,
  linkUnfurlCardBodyField: 50,
  linkUnfurlCardSlackUnfurlType: 3,
  linkUnfurlCardSlackDocumentType: 4,
  fileEmbedType: 58,
  fileEmbedBodyField: 52,
  dateType: 68,
  dateBodyField: 62,
} as const;

export type ProtoField = {
  no: number;
  wire: number;
  value: bigint | Buffer;
};

export type PrivateMarkdownBlock =
  | { kind: "text"; type?: number; style: number; text: string }
  | { kind: "list"; style: number; items: { text: string }[] }
  | { kind: "table"; rows: string[][] }
  | {
      kind: "embed";
      embed_type: "image" | "file" | "link" | "slack_message";
      url: string;
      text?: string;
    };

export type PrivateInsertSection = {
  id: string;
  sequence?: number;
  threadId?: string;
  docId?: string;
  position: string;
  type: number;
  style: number;
  text: string;
  deleted?: boolean;
  cell?: boolean;
  parentId?: string;
  parentStyle?: number;
  parentTopPosition?: string;
  traceId: string;
  control?: PrivateControl;
  table?: PrivateTable;
};

export type PrivateControl =
  | { kind: "user"; id: string; label?: string }
  | { kind: "channel"; id: string; label?: string }
  | { kind: "date"; timestamp: number; fallback?: string }
  | { kind: "file"; id: string; label?: string; url?: string }
  | { kind: "canvas"; id: string; url: string; label?: string }
  | { kind: "message"; channel: string; ts: string; url: string; label?: string }
  | { kind: "annotation"; id: string };

export type PrivateTable = {
  id: string;
  rowIds: string[];
  columnIds: string[];
  cells: Array<{ id: string; rowId: string; columnId: string; text: string; sectionId?: string }>[];
};

export type PrivateDocumentInput = {
  threadId: string;
  docId: string;
  title?: string;
  markdown: string;
  position?: string;
  sequence?: number;
  operation?: "append" | "prepend" | "replace";
};

type InlineContext = {
  docId: string;
  controls: { id: string; control: PrivateControl }[];
};

const PRIVATE_LIST_BULLET_STYLE = 5;
const PRIVATE_LIST_NUMBERED_STYLE = 6;
const PRIVATE_LIST_CHECKLIST_STYLE = 7;
const PRIVATE_INLINE_ANCHOR_RE =
  /<(lnk|a)\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/\1\s*>/gi;

export function parsePrivateMarkdownBlocks(markdown: string): PrivateMarkdownBlock[] {
  return parsePrivateMarkdownDocument(markdown, "DOC00000000").blocks;
}

export function parsePrivateMarkdownDocument(
  markdown: string,
  docId: string,
): { blocks: PrivateMarkdownBlock[]; controls: { id: string; control: PrivateControl }[] } {
  const context: InlineContext = { docId, controls: [] };
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: PrivateMarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const table = parsePrivateTableAt(lines, i, context);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      const language = trimmed.replace(/^```/, "").trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {body.push(lines[i++]);}
      if (i < lines.length) {i++;}
      const prefix = `\`\`\`${language ? escapePrivateBodyText(language) : ""}`;
      blocks.push({
        kind: "text",
        style: 4,
        text: `${prefix}<br>${body.map(escapePrivateBodyText).join("<br>")}`,
      });
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "text",
        style: heading[1].length,
        text: parsePrivateInlineBodyText(heading[2].trim(), context),
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "text", type: 16, style: 18, text: "" });
      i++;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim()))
        {body.push(lines[i++].trim().replace(/^>\s?/, ""));}
      blocks.push({
        kind: "text",
        style: 16,
        text: parsePrivateInlineBodyText(body.join("\n").trimEnd(), context),
      });
      continue;
    }
    const embed = parsePrivateEmbedLine(trimmed, context);
    if (embed) {
      blocks.push(embed);
      i++;
      continue;
    }
    const list = parsePrivateListAt(lines, i, context);
    if (list) {
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !isPrivateMarkdownBlockStart(lines[i]))
      {body.push(lines[i++].trimEnd());}
    blocks.push({
      kind: "text",
      style: 0,
      text: parsePrivateInlineBodyText(body.join("\n").trimEnd(), context),
    });
  }
  return {
    blocks: blocks.filter((block) => {
      if (block.kind === "list") {return block.items.length > 0;}
      if (block.kind === "table") {return block.rows.length > 0;}
      if (block.kind === "embed") {return block.url.length > 0;}
      return block.type === 16 || block.text.length > 0;
    }),
    controls: context.controls,
  };
}

export function parsePrivateInlineBodyText(input: string, context?: InlineContext): string {
  let result = "";
  let last = 0;
  PRIVATE_INLINE_LINK_RE.lastIndex = 0;
  for (const match of input.matchAll(PRIVATE_INLINE_LINK_RE)) {
    const index = match.index ?? 0;
    result += encodePrivateInlineSegment(input.slice(last, index), context);
    const url = match[2] ?? match[3] ?? "";
    const label = unescapeMarkdownLinkLabel(match[1] ?? url);
    if (url && label && PRIVATE_SAFE_LINK_SCHEME_RE.test(url)) {
      result += `<a href="${escapePrivateBodyAttr(url)}">${encodePrivateInlineSegment(label, context)}</a>`;
    } else {
      result += encodePrivateInlineSegment(match[0], context);
    }
    last = index + match[0].length;
  }
  result += encodePrivateInlineSegment(input.slice(last), context);
  return result;
}

export function decodePrivateBodyText(text: string): string {
  const withMarkdownLinks = text.replace(
    PRIVATE_INLINE_ANCHOR_RE,
    (_match, _tag, doubleHref, singleHref, rawLabel) => {
      const url = decodePrivateHtmlEntities(doubleHref ?? singleHref ?? "");
      const visible = decodePrivateHtmlEntities(stripPrivateInlineHtml(rawLabel ?? ""));
      if (!url) {return visible;}
      if (visible === url || !visible) {return url;}
      return `[${visible}](${url})`;
    },
  );
  return decodePrivateHtmlEntities(withMarkdownLinks.replace(/<control\b[^>]*><\/control>/g, ""));
}

export function buildPrivateMarkdownDocumentData(input: PrivateDocumentInput): Buffer {
  const parsed = parsePrivateMarkdownDocument(input.markdown, input.docId);
  const sections = buildPrivateSections(input, parsed.blocks, parsed.controls);
  return buildPrivateDocumentData(sections, input.title);
}

export function buildPrivateTableDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & { rows: string[][] },
): Buffer {
  const rows = normalizeTableRows(input.rows);
  return buildPrivateDocumentData(
    nativeTableSections(
      input,
      privateTempSectionId(input.docId),
      input.position ?? "aaa:temp",
      rows,
      1,
    ),
    input.title,
  );
}

export function buildPrivateTableDocumentMutation(
  input: Omit<PrivateDocumentInput, "markdown"> & { rows: string[][] },
): { data: Buffer; fillData?: Buffer; tableId: string } {
  const rows = normalizeTableRows(input.rows);
  const position = input.position ?? "aaa:temp";
  const tableId = privateTempSectionId(input.docId);
  const sections = nativeTableSections(input, tableId, position, rows, 1);
  return {
    tableId,
    data: buildPrivateDocumentData(sections, input.title),
  };
}

export function buildPrivateFileEmbedDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & {
    fileId: string;
    title?: string;
    url?: string;
    position?: string;
  },
): Buffer {
  return buildPrivateDocumentData(
    [
      controlSection(
        { ...input, markdown: "" },
        privateTempSectionId(input.docId),
        input.position ?? "aaa:temp",
        { kind: "file", id: input.fileId, label: input.title, url: input.url },
        1,
      ),
    ],
    input.title,
  );
}

export function buildPrivateCanvasEmbedDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & {
    canvasId: string;
    url: string;
    label?: string;
    position?: string;
  },
): Buffer {
  return buildPrivateDocumentData(
    [
      controlSection(
        { ...input, markdown: "" },
        privateTempSectionId(input.docId),
        input.position ?? "aaa:temp",
        { kind: "canvas", id: input.canvasId, url: input.url, label: input.label },
        1,
      ),
    ],
    input.title,
  );
}

export function buildPrivateMessageEmbedDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & {
    channel: string;
    ts: string;
    url: string;
    label?: string;
    position?: string;
  },
): Buffer {
  return buildPrivateDocumentData(
    [
      controlSection(
        { ...input, markdown: "" },
        privateTempSectionId(input.docId),
        input.position ?? "aaa:temp",
        {
          kind: "message",
          channel: input.channel,
          ts: input.ts,
          url: input.url,
          label: input.label,
        },
        1,
      ),
    ],
    input.title,
  );
}

export function buildPrivateFileEmbedAfterSectionDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & {
    sectionId: string;
    sectionText: string;
    fileId: string;
    title?: string;
    url?: string;
    sectionPosition?: string;
    controlPosition?: string;
    position?: string;
  },
): Buffer {
  const controlId = privateTempSectionId(input.docId);
  const text = `${escapePrivateBodyText(input.sectionText)}<control id="${controlId}"></control>`;
  const sectionPosition = input.sectionPosition ?? input.position ?? "aaa:temp";
  const controlPosition = input.controlPosition ?? "aaaaaaa:temp";
  return buildPrivateDocumentData(
    [
      {
        id: input.sectionId,
        position: sectionPosition,
        type: 0,
        style: 0,
        text,
        traceId: `agent-slack-canvas-file-anchor-${Date.now()}`,
      },
      controlSection(
        { ...input, markdown: "" },
        controlId,
        controlPosition,
        { kind: "file", id: input.fileId, label: "file", url: input.url },
        1,
      ),
    ],
    input.title,
  );
}

export function buildPrivateAnnotationDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & {
    sectionId: string;
    annotationId: string;
    selectedText: string;
    sectionText: string;
    editorUserId: string;
    occurrence?: number;
    startOffset?: number;
  },
): Buffer {
  const offset = Math.max(0, input.startOffset ?? input.sectionText.indexOf(input.selectedText));
  const escapedSelected = escapePrivateBodyText(input.selectedText);
  const text = `${escapePrivateBodyText(input.sectionText.slice(0, offset))}<annotation id="${escapePrivateBodyAttr(input.annotationId)}">${escapedSelected}</annotation>${escapePrivateBodyText(input.sectionText.slice(offset + input.selectedText.length))}`;
  const traceId = `agent-slack-canvas-annotation-${Date.now()}`;
  return buildPrivateDocumentData(
    [
      {
        id: input.sectionId,
        position: input.position ?? "aaa:temp",
        type: 0,
        style: 0,
        text,
        traceId,
      },
      {
        id: input.annotationId,
        position: nextPrivatePositionAfter(input.position ?? "aaZaaa:temp"),
        type: 9,
        style: 0,
        text: "",
        traceId,
        control: { kind: "annotation", id: input.editorUserId },
      },
    ],
    input.title,
  );
}

export function buildPrivateCoverDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & {
    titleSectionId: string;
    headerId?: string;
    clear?: boolean;
  },
): Buffer {
  const title = input.title ?? "Untitled";
  const body = input.clear
    ? protoMessage(CANVAS_PROTO_TAGS.bodyField, [
        protoMessage(CANVAS_PROTO_TAGS.titleTextField, [protoString(1, title)]),
      ])
    : protoMessage(CANVAS_PROTO_TAGS.bodyField, [
        protoMessage(CANVAS_PROTO_TAGS.titleTextField, [
          protoString(1, title),
          protoMessage(2, [
            protoMessage(3, [protoString(8, input.headerId ?? "")]),
            protoString(7, input.headerId ?? ""),
          ]),
        ]),
      ]);
  if (input.titleSectionId.startsWith("temp:C:")) {
    const position = "aaa";
    return Buffer.concat([
      protoMessage(1, [
        protoString(1, input.titleSectionId),
        protoVarint(2, Math.max(1, input.sequence ?? 1) * 1000),
        protoVarint(3, 0),
        protoString(8, position),
        protoVarint(9, 64),
        protoVarint(10, 48),
        protoVarint(11, 0),
        body,
        protoMessage(13, []),
        protoMessage(16, [
          protoVarint(4, 0),
          protoVarint(13, 1),
          protoVarint(30, 5),
          protoVarint(34, 1),
        ]),
        protoVarint(19, 1),
        protoVarint(20, input.clear ? 2 : 3),
        protoString(21, position),
        protoVarint(29, 0),
        protoString(33, `agent-slack-cover-${Date.now()}`),
        protoVarint(35, 0),
      ]),
      buildPrivateTitleRichText(title),
    ]);
  }
  return Buffer.concat([
    protoMessage(1, [
      protoString(1, input.titleSectionId),
      protoVarint(2, Date.now() % 1000000),
      protoVarint(9, 64),
      body,
      protoMessage(13, []),
      protoVarint(19, 1),
      protoVarint(20, input.clear ? 2 : 1),
      protoString(33, `agent-slack-cover-${Date.now()}`),
    ]),
    buildPrivateTitleRichText(title),
  ]);
}

export function buildPrivateSectionDeleteDocumentData(
  input: Omit<PrivateDocumentInput, "markdown"> & { sectionId: string },
): Buffer {
  return buildPrivateDocumentData(
    [
      {
        id: input.sectionId,
        threadId: input.threadId,
        docId: input.docId,
        position: input.position ?? "aaa:temp",
        type: 0,
        style: 0,
        text: "",
        deleted: true,
        traceId: `agent-slack-canvas-delete-${Date.now()}`,
      },
    ],
    input.title,
  );
}

export function buildPrivateMarkdownDocumentStrings(input: PrivateDocumentInput): string[] {
  return allProtoStrings(decodeProto(buildPrivateMarkdownDocumentData(input)));
}

export function buildPrivateDocumentData(sections: PrivateInsertSection[], title?: string): Buffer {
  const parts = sections.map((section) => protoMessage(1, [encodePrivateInsertSection(section)]));
  if (title) {parts.push(buildPrivateTitleRichText(title));}
  return Buffer.concat(parts);
}

export function encodePrivateInsertSection(section: PrivateInsertSection): Buffer {
  if (section.control?.kind === "file") {return encodePrivateFileControlSection(section);}
  const isLinkUnfurlCard =
    section.control?.kind === "canvas" || section.control?.kind === "message";
  const parts: Buffer[] = [
    protoString(1, section.id),
    protoVarint(2, section.sequence ?? 0),
    protoVarint(3, section.deleted ? 1 : 0),
    ...(section.threadId ? [protoString(6, section.threadId)] : []),
    ...(section.docId ? [protoString(7, section.docId)] : []),
    protoString(8, section.position),
    protoVarint(9, section.type),
    protoVarint(10, section.style),
    protoVarint(11, section.control && !isLinkUnfurlCard ? 1 : 0),
    encodePrivateSectionBody(section),
  ];
  parts.push(protoMessage(13, []));
  parts.push(
    section.type === 64
      ? protoMessage(16, [protoVarint(4, 0), protoVarint(30, 5)])
      : protoMessage(16, [protoVarint(4, 0)]),
    protoVarint(19, 1),
    protoVarint(20, section.cell ? 2 : 1),
    protoString(21, section.position),
    protoVarint(29, section.cell ? 1 : 0),
    protoString(33, section.traceId),
    ...(section.cell
      ? [
          protoMessage(38, [
            protoString(1, section.id),
            protoVarint(2, 0),
            protoVarint(3, section.sequence ?? 0),
          ]),
        ]
      : []),
    protoVarint(35, 0),
  );
  if (section.type !== 64) {parts.push(protoVarint(39, 0));}
  return Buffer.concat(parts);
}

function encodePrivateFileControlSection(section: PrivateInsertSection): Buffer {
  const id = section.control?.kind === "file" ? section.control.id : "";
  const label = section.control?.kind === "file" ? (section.control.label ?? "file") : "file";
  const url =
    section.control?.kind === "file"
      ? (section.control.url ?? `https://slack.com/files/${id}`)
      : `https://slack.com/files/${id}`;
  const html = `<a href='${escapePrivateBodyAttr(url)}' data-slack-file-id=${id} download='file'>${escapePrivateBodyText(label)}</a>`;
  return Buffer.concat([
    protoString(1, section.id),
    protoVarint(2, section.sequence ?? 610000),
    protoVarint(9, CANVAS_PROTO_TAGS.fileEmbedType),
    protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.fileEmbedBodyField, [protoString(2, `sf:${id}`)]),
    ]),
    protoString(14, html),
    protoVarint(19, 1),
    protoVarint(20, 2),
    protoString(21, section.position),
    protoString(33, section.traceId),
  ]);
}

export function protoVarint(fieldNo: number, value: number | bigint): Buffer {
  return Buffer.concat([encodeProtoVarint(BigInt(fieldNo << 3)), encodeProtoVarint(BigInt(value))]);
}

export function protoString(fieldNo: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([
    encodeProtoVarint(BigInt((fieldNo << 3) | 2)),
    encodeProtoVarint(bytes.length),
    bytes,
  ]);
}

export function protoMessage(fieldNo: number, parts: Buffer[]): Buffer {
  const bytes = Buffer.concat(parts);
  return Buffer.concat([
    encodeProtoVarint(BigInt((fieldNo << 3) | 2)),
    encodeProtoVarint(bytes.length),
    bytes,
  ]);
}

export function protoFixed64(fieldNo: number, value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value, 0);
  return Buffer.concat([encodeProtoVarint(BigInt((fieldNo << 3) | 1)), bytes]);
}

export function decodeProto(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  const readVarint = (): bigint => {
    let shift = 0n;
    let value = 0n;
    for (;;) {
      const byte = buffer[offset++];
      if (byte == null) {throw new Error("Unexpected end of protobuf varint");}
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {return value;}
      shift += 7n;
    }
  };
  while (offset < buffer.length) {
    const key = readVarint();
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value: bigint | Buffer;
    if (wire === 0) {
      value = readVarint();
    } else if (wire === 1) {
      value = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else if (wire === 2) {
      const length = Number(readVarint());
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 5) {
      value = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
    fields.push({ no, wire, value });
  }
  return fields;
}

export function allProtoStrings(fields: ProtoField[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) {continue;}
    const text = field.value.toString("utf8");
    if (/^[\x09\x0a\x0d\x20-\x7e]{2,}$/.test(text)) {out.push(text);}
    try {
      out.push(...allProtoStrings(decodeProto(field.value)));
    } catch {
      // Length-delimited fields are not always nested protobuf messages.
    }
  }
  return out;
}

function buildPrivateSections(
  input: PrivateDocumentInput,
  blocks: PrivateMarkdownBlock[],
  controls: { id: string; control: PrivateControl }[],
): PrivateInsertSection[] {
  const sections: PrivateInsertSection[] = [];
  let cursor = input.position ?? (input.operation === "prepend" ? "aaZ:temp" : "aaa:temp");
  let index = 1;
  for (const block of blocks) {
    if (block.kind === "list") {
      const parentId = privateTempSectionId(input.docId);
      const parentPosition = cursor;
      sections.push(section(input, parentId, parentPosition, 8, block.style, "", index++));
      cursor = nextPrivatePositionAfter(cursor);
      for (const item of block.items) {
        sections.push({
          ...section(input, privateTempSectionId(input.docId), cursor, 0, 0, item.text, index++),
          parentId,
          parentStyle: block.style,
          parentTopPosition: parentPosition,
        });
        cursor = nextPrivatePositionAfter(cursor);
      }
      continue;
    }
    if (block.kind === "table") {
      sections.push(
        tableSection(
          input,
          privateTempSectionId(input.docId),
          cursor,
          normalizeTableRows(block.rows),
          index++,
        ),
      );
      cursor = nextPrivatePositionAfter(cursor);
      continue;
    }
    if (block.kind === "embed") {
      const fileId = block.url.match(/^slack-file:\/\/(F[A-Z0-9]{8,})$/)?.[1];
      if (fileId) {
        sections.push(
          controlSection(
            input,
            privateTempSectionId(input.docId),
            cursor,
            { kind: "file", id: fileId, label: block.text },
            index++,
          ),
        );
        cursor = nextPrivatePositionAfter(cursor);
        continue;
      }
      const text =
        block.embed_type === "slack_message"
          ? parsePrivateInlineBodyText(`[${block.text ?? block.url}](${block.url})`)
          : parsePrivateInlineBodyText(
              block.text ? `[${block.text}](${block.url})` : `<${block.url}>`,
            );
      sections.push(section(input, privateTempSectionId(input.docId), cursor, 0, 0, text, index++));
      cursor = nextPrivatePositionAfter(cursor);
      continue;
    }
    sections.push(
      section(
        input,
        privateTempSectionId(input.docId),
        cursor,
        block.type ?? 0,
        block.style,
        block.text,
        index++,
      ),
    );
    cursor = nextPrivatePositionAfter(cursor);
  }
  for (const entry of controls) {
    sections.push(controlSection(input, entry.id, cursor, entry.control, index++));
    cursor = nextPrivatePositionAfter(cursor);
  }
  return sections;
}

function section(
  input: Omit<PrivateDocumentInput, "markdown">,
  id: string,
  position: string,
  type: number,
  style: number,
  text: string,
  index: number,
): PrivateInsertSection {
  return {
    id,
    threadId: input.threadId,
    docId: input.docId,
    position,
    type,
    style,
    text,
    traceId: `agent-slack-canvas-${Date.now()}-${index}`,
  };
}

function controlSection(
  input: PrivateDocumentInput,
  id: string,
  position: string,
  control: PrivateControl,
  index: number,
): PrivateInsertSection {
  const type =
    control.kind === "channel"
      ? CANVAS_PROTO_TAGS.channelMentionType
      : control.kind === "user"
        ? CANVAS_PROTO_TAGS.userMentionType
        : control.kind === "date"
          ? CANVAS_PROTO_TAGS.dateType
          : control.kind === "canvas" || control.kind === "message"
            ? CANVAS_PROTO_TAGS.linkUnfurlCardType
            : CANVAS_PROTO_TAGS.fileEmbedType;
  return {
    id,
    threadId: input.threadId,
    docId: input.docId,
    position,
    type,
    style:
      control.kind === "canvas" || control.kind === "message"
        ? CANVAS_PROTO_TAGS.linkUnfurlCardStyle
        : 0,
    text:
      control.kind === "date"
        ? (control.fallback ?? "")
        : control.kind === "annotation"
          ? control.id
          : control.kind === "message"
            ? (control.label ?? control.url)
            : (control.label ?? control.id),
    control,
    traceId: `agent-slack-canvas-control-${Date.now()}-${index}`,
  };
}

function tableSection(
  input: Omit<PrivateDocumentInput, "markdown">,
  id: string,
  position: string,
  rows: string[][],
  index: number,
): PrivateInsertSection {
  const width = rows.length ? Math.max(...rows.map((row) => row.length)) : 0;
  const rowIds = rows.map((_row, rowIndex) => stableTableScopedId(input.docId, "row", rowIndex));
  const columnIds = Array.from({ length: width }, (_unused, columnIndex) =>
    stableTableScopedId(input.docId, "col", columnIndex),
  );
  const tableId = stableTableScopedId(input.docId, "table", rows.length, width);
  const cells = rows.map((row, rowIndex) =>
    columnIds.map((columnId, columnIndex) => {
      const text = parsePrivateInlineBodyText(row[columnIndex] ?? "");
      return {
        id: stableTableScopedId(input.docId, "cell", rowIndex, columnIndex, text),
        rowId: rowIds[rowIndex],
        columnId,
        text,
      };
    }),
  );
  return {
    id,
    threadId: input.threadId,
    docId: input.docId,
    position,
    type: 11,
    style: 0,
    text: "",
    table: { id: tableId, rowIds, columnIds, cells },
    traceId: `agent-slack-canvas-table-${Date.now()}-${index}`,
  };
}

function nativeTableSections(
  input: Omit<PrivateDocumentInput, "markdown">,
  id: string,
  position: string,
  rows: string[][],
  index: number,
): PrivateInsertSection[] {
  const width = rows.length ? Math.max(...rows.map((row) => row.length)) : 0;
  const rowIds = rows.map((_row, rowIndex) => stableTableScopedId(input.docId, "row", rowIndex));
  const columnIds = Array.from({ length: width }, (_unused, columnIndex) =>
    stableTableScopedId(input.docId, "col", columnIndex),
  );
  const cells = rows.map((row, rowIndex) =>
    columnIds.map((columnId, columnIndex) => {
      const text = parsePrivateInlineBodyText(row[columnIndex] ?? "");
      return {
        id: stableTableScopedId(input.docId, "cell", rowIndex, columnIndex),
        rowId: rowIds[rowIndex],
        columnId,
        text,
        sectionId: privateTempSectionId(input.docId),
      };
    }),
  );
  const tableSection: PrivateInsertSection = {
    id,
    threadId: input.threadId,
    docId: input.docId,
    position,
    type: 33,
    style: 28,
    text: "",
    table: { id, rowIds, columnIds, cells },
    traceId: `agent-slack-canvas-table-${Date.now()}-${index}`,
  };
  const cellSections = cells.flat().map((cell, cellIndex) => ({
    ...section(
      input,
      cell.sectionId!,
      advancePrivatePosition(position, cellIndex + 1),
      0,
      0,
      cell.text,
      index + cellIndex + 1,
    ),
    cell: true,
  }));
  return [tableSection, ...cellSections];
}

function encodePrivateSectionBody(section: PrivateInsertSection): Buffer {
  if (section.type === 64)
    {return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.titleTextField, [protoString(1, section.text)]),
    ]);}
  if (section.table)
    {return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      section.type === 33 ? encodeNativeTable(section.table) : encodePrivateTable(section.table),
    ]);}
  if (!section.control)
    {return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.bodyTextField, [protoString(1, section.text)]),
    ]);}
  const {control} = section;
  if (control.kind === "channel") {
    return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.channelMentionBodyField, [protoString(1, `sc:${control.id}`)]),
    ]);
  }
  if (control.kind === "user") {
    return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.userMentionBodyField, [protoString(1, `su:${control.id}`)]),
    ]);
  }
  if (control.kind === "file") {
    return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.fileEmbedBodyField, [protoString(1, `sf:${control.id}`)]),
    ]);
  }
  if (control.kind === "canvas") {
    return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.linkUnfurlCardBodyField, [
        protoString(1, control.url),
        protoVarint(2, CANVAS_PROTO_TAGS.linkUnfurlCardSlackDocumentType),
        protoMessage(3, [protoMessage(4, [protoString(1, `sd:${control.id}`)])]),
        protoVarint(8, 0),
      ]),
    ]);
  }
  if (control.kind === "message") {
    return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(CANVAS_PROTO_TAGS.linkUnfurlCardBodyField, [
        protoString(1, control.url),
        protoVarint(2, CANVAS_PROTO_TAGS.linkUnfurlCardSlackUnfurlType),
        protoMessage(3, [protoMessage(3, [protoString(1, `sm:${control.channel}/${control.ts}`)])]),
        protoVarint(8, 0),
      ]),
    ]);
  }
  if (control.kind === "annotation") {
    return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
      protoMessage(7, [
        protoString(1, control.id),
        protoVarint(4, 0),
        protoVarint(5, 0),
        protoVarint(9, 2),
        protoString(10, ""),
        protoString(11, ""),
        protoVarint(13, 0),
      ]),
    ]);
  }
  return protoMessage(CANVAS_PROTO_TAGS.bodyField, [
    protoMessage(CANVAS_PROTO_TAGS.dateBodyField, [
      protoVarint(1, canvasDateTimestampMs(control.timestamp)),
      protoString(2, control.fallback ?? ""),
    ]),
  ]);
}

function canvasDateTimestampMs(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function encodeNativeTable(table: PrivateTable): Buffer {
  const flatCells = table.cells.flat();
  return protoMessage(30, [
    ...table.rowIds.map((rowId, index) =>
      protoMessage(1, [
        protoString(1, rowId),
        protoString(2, advancePrivatePosition("aaa:temp", index)),
      ]),
    ),
    ...table.columnIds.map((columnId, index) =>
      protoMessage(2, [
        protoString(1, columnId),
        protoString(2, advancePrivatePosition("aaa:temp", index)),
        protoFixed64(3, 312),
      ]),
    ),
    ...flatCells.map((cell) =>
      protoMessage(3, [
        protoString(1, cell.id),
        protoString(2, cell.rowId),
        protoString(3, cell.columnId),
        protoString(4, cell.sectionId ?? cell.id),
      ]),
    ),
  ]);
}

function encodePrivateTable(table: PrivateTable): Buffer {
  return protoMessage(70, [
    protoString(1, "table"),
    protoString(2, table.id),
    ...table.rowIds.map((rowId, index) =>
      protoMessage(3, [protoString(1, rowId), protoVarint(2, index)]),
    ),
    ...table.columnIds.map((columnId, index) =>
      protoMessage(4, [protoString(1, columnId), protoVarint(2, index)]),
    ),
    ...table.cells.flatMap((row) =>
      row.map((cell) =>
        protoMessage(5, [
          protoString(1, cell.id),
          protoString(2, cell.rowId),
          protoString(3, cell.columnId),
          protoMessage(4, [protoString(1, cell.text)]),
        ]),
      ),
    ),
  ]);
}

function buildPrivateTitleRichText(title: string): Buffer {
  return protoMessage(CANVAS_PROTO_TAGS.titleRichTextField, [
    protoString(1, "rich_text"),
    protoMessage(2, [
      protoString(1, "rich_text_section"),
      protoMessage(2, [protoString(1, "text"), protoString(2, title)]),
    ]),
  ]);
}

function encodePrivateInlineSegment(input: string, context?: InlineContext): string {
  const tokens = findControlTokens(input, context);
  if (tokens.length === 0) {return formatEscapedMarkdown(escapePrivateBodyText(input));}
  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) {continue;}
    out += formatEscapedMarkdown(escapePrivateBodyText(input.slice(cursor, token.start)));
    out += token.html;
    cursor = token.end;
  }
  out += formatEscapedMarkdown(escapePrivateBodyText(input.slice(cursor)));
  return out;
}

function findControlTokens(
  input: string,
  context?: InlineContext,
): { start: number; end: number; html: string }[] {
  if (!context) {return [];}
  const tokens: { start: number; end: number; html: string }[] = [];
  for (const match of input.matchAll(/<@((?:U|W)[A-Z0-9]{8,})(?:\|([^>]+))?>/g)) {
    tokens.push(
      controlToken(context, match.index ?? 0, match[0], {
        kind: "user",
        id: match[1],
        label: match[2],
      }),
    );
  }
  for (const match of input.matchAll(/<#((?:C|G)[A-Z0-9]{8,})(?:\|([^>]+))?>/g)) {
    tokens.push(
      controlToken(context, match.index ?? 0, match[0], {
        kind: "channel",
        id: match[1],
        label: match[2],
      }),
    );
  }
  for (const match of input.matchAll(/<!date\^(\d+)(?:\^[^|>]+)?(?:\|([^>]+))?>/g)) {
    tokens.push(
      controlToken(context, match.index ?? 0, match[0], {
        kind: "date",
        timestamp: Number(match[1]),
        fallback: match[2],
      }),
    );
  }
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  return tokens;
}

function controlToken(
  context: InlineContext,
  start: number,
  raw: string,
  control: PrivateControl,
): { start: number; end: number; html: string } {
  const id = privateTempSectionId(context.docId);
  context.controls.push({ id, control });
  return { start, end: start + raw.length, html: `<control id="${id}"></control>` };
}

function formatEscapedMarkdown(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<i>$2</i>");
}

function parsePrivateListAt(
  lines: string[],
  start: number,
  context: InlineContext,
): { block: Extract<PrivateMarkdownBlock, { kind: "list" }>; next: number } | undefined {
  const first = classifyPrivateListLine(lines[start]);
  if (!first) {return undefined;}
  const items: { text: string }[] = [];
  let i = start;
  while (i < lines.length) {
    const current = classifyPrivateListLine(lines[i]);
    if (!current || current.style !== first.style) {break;}
    items.push({ text: parsePrivateInlineBodyText(current.text, context) });
    i++;
  }
  return { block: { kind: "list", style: first.style, items }, next: i };
}

function parsePrivateTableAt(
  lines: string[],
  start: number,
  context: InlineContext,
): { block: Extract<PrivateMarkdownBlock, { kind: "table" }>; next: number } | undefined {
  if (
    !/^\s*\|.*\|\s*$/.test(lines[start] ?? "") ||
    !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[start + 1] ?? "")
  )
    {return undefined;}
  const rows: string[][] = [
    splitTableRow(lines[start]).map((cell) =>
      decodePrivateBodyText(parsePrivateInlineBodyText(cell, context)),
    ),
  ];
  let i = start + 2;
  while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
    rows.push(
      splitTableRow(lines[i]).map((cell) =>
        decodePrivateBodyText(parsePrivateInlineBodyText(cell, context)),
      ),
    );
    i++;
  }
  return { block: { kind: "table", rows }, next: i };
}

function parsePrivateEmbedLine(
  line: string,
  context: InlineContext,
): Extract<PrivateMarkdownBlock, { kind: "embed" }> | undefined {
  const image = line.match(/^!\[([^\]\n]*)]\(([^)\s]+)\)$/);
  if (image) {return { kind: "embed", embed_type: "image", text: image[1], url: image[2] };}
  const file = line.match(/^<file:((?:F)[A-Z0-9]{8,})(?:\|([^>]+))?>$/);
  if (file) {
    return { kind: "embed", embed_type: "file", text: file[2], url: `slack-file://${file[1]}` };
  }
  const message = line.match(/^https:\/\/[^/\s]+\.slack\.com\/archives\/[CGD][A-Z0-9]+\/p\d+$/);
  if (message) {return { kind: "embed", embed_type: "slack_message", url: line };}
  return undefined;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function classifyPrivateListLine(line: string): { style: number; text: string } | undefined {
  let match = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
  if (match) {return { style: PRIVATE_LIST_CHECKLIST_STYLE, text: match[1].trim() };}
  match = line.match(/^\s*[-*+]\s+(.+)$/);
  if (match) {return { style: PRIVATE_LIST_BULLET_STYLE, text: match[1].trim() };}
  match = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (match) {return { style: PRIVATE_LIST_NUMBERED_STYLE, text: match[1].trim() };}
  return undefined;
}

function isPrivateMarkdownBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('```') ||
    /^#{1,6}\s+\S/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    /^\s*\|.*\|\s*$/.test(line) ||
    classifyPrivateListLine(line) != null ||
    parsePrivateEmbedLine(trimmed, { docId: "DOC00000000", controls: [] }) != null
  );
}

function unescapeMarkdownLinkLabel(label: string): string {
  return label.replace(/\\([][\\])/g, "$1");
}

function escapePrivateBodyText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapePrivateBodyAttr(value: string): string {
  return escapePrivateBodyText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function stripPrivateInlineHtml(text: string): string {
  return text.replace(/<\/?[^>]+>/g, "");
}

function decodePrivateHtmlEntities(text: string): string {
  const placeholder = "\u0000__AMP__\u0000";
  let out = text.replace(/&amp;/g, placeholder);
  out = out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)));
  return out.replace(new RegExp(placeholder, "g"), "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {return "";}
  if (code >= 0xd800 && code <= 0xdfff) {return "";}
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function privateTempSectionId(docId: string): string {
  return `temp:C:${docId.slice(0, 3)}${randomUUID().replaceAll("-", "").slice(0, 25)}`;
}

function stableTableScopedId(
  docId: string,
  kind: "table" | "row" | "col" | "cell",
  ...parts: (string | number)[]
): string {
  const digest = createHash("sha1")
    .update([docId, kind, ...parts].join("\0"))
    .digest("hex")
    .slice(0, 25);
  return `${kind}:${digest}`;
}

function normalizeTableRows(rows: string[][]): string[][] {
  const filtered = rows
    .map((row) => row.map((cell) => String(cell ?? "")))
    .filter((row) => row.length > 0);
  if (filtered.length === 0) {throw new Error("table input must contain at least one row");}
  const width = Math.max(...filtered.map((row) => row.length));
  return filtered.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
}

function nextPrivatePositionAfter(position: string): string {
  const clean = position.replace(/:temp$/, "");
  const match = clean.match(/^(.*?)([a-y])$/);
  if (match) {return `${match[1]}${String.fromCharCode(match[2].charCodeAt(0) + 1)}:temp`;}
  return `${clean}a:temp`;
}

function advancePrivatePosition(position: string, steps: number): string {
  let cursor = position;
  for (let i = 0; i < steps; i++) {cursor = nextPrivatePositionAfter(cursor);}
  return cursor;
}

function encodeProtoVarint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  const out: number[] = [];
  while (remaining >= 0x80n) {
    out.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  out.push(Number(remaining));
  return Buffer.from(out);
}
