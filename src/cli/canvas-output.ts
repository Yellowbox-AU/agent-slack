// @ts-nocheck
export type CanvasFormat = "json" | "toon";

export type CanvasOutputOptions = {
  format?: CanvasFormat;
  formatExplicit?: boolean;
  fields?: string[];
  maxChars?: number;
  full?: boolean;
  collection?: boolean;
};

export type CanvasErrorEnvelope = {
  ok: false;
  error_code: string;
  error_text: string;
  debug?: Record<string, unknown>;
};

export type CanvasPaginationMeta = {
  total: number;
  returned: number;
  page: number;
  next_page: number | null;
  has_more: boolean;
};

export function buildErrorEnvelope(
  error: unknown,
  debug?: Record<string, unknown>,
): CanvasErrorEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  const explicitCode =
    isRecord(error) && typeof error.error_code === "string" ? error.error_code : undefined;
  return {
    ok: false,
    error_code: explicitCode ?? errorCodeFromMessage(message),
    error_text: message,
    ...(debug ? { debug } : {}),
  };
}

export function serializeCanvasOutput(payload: unknown, options: CanvasOutputOptions = {}): string {
  const prepared = preparePayload(payload, options);
  const format = options.format ?? (options.collection ? "toon" : "json");
  return format === "toon"
    ? `${serializeToon(prepared)}\n`
    : `${JSON.stringify(prepared, null, 2)}\n`;
}

export function serializeToon(value: unknown): string {
  return toonValue(value, 0).replace(/\n+$/, "");
}

export function buildPaginationMeta(input: {
  total: number;
  returned: number;
  page: number;
  perPage: number;
  hasMore?: boolean;
}): CanvasPaginationMeta {
  const hasMore = input.hasMore ?? input.page * input.perPage < input.total;
  return {
    total: input.total,
    returned: input.returned,
    page: input.page,
    next_page: hasMore ? input.page + 1 : null,
    has_more: hasMore,
  };
}

function preparePayload(payload: unknown, options: CanvasOutputOptions): unknown {
  let out = options.fields?.length ? selectFields(payload, options.fields) : payload;
  if (!options.full && Number.isFinite(options.maxChars) && (options.maxChars ?? 0) > 0) {
    out = truncateStrings(out, options.maxChars!);
  }
  return out;
}

function selectFields(payload: unknown, fields: string[]): unknown {
  if (!isRecord(payload)) {return payload;}
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const path = field
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);
    if (path.length === 0) {continue;}
    const value = getPath(payload, path);
    if (value !== undefined) {setPath(out, path, value);}
  }
  return out;
}

function getPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const part of path) {
    if (!isRecord(cursor) || !(part in cursor)) {return undefined;}
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!isRecord(cursor[key])) {cursor[key] = {};}
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path.at(-1)] = value;
}

function truncateStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === "string")
    {return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;}
  if (Array.isArray(value)) {return value.map((item) => truncateStrings(item, maxChars));}
  if (!isRecord(value)) {return value;}
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {out[key] = truncateStrings(child, maxChars);}
  return out;
}

function toonValue(value: unknown, indent: number, key?: string): string {
  const pad = "  ".repeat(indent);
  const prefix = key == null ? "" : `${pad}${key}: `;
  if (value == null || typeof value === "number" || typeof value === "boolean")
    {return `${prefix}${String(value)}\n`;}
  if (typeof value === "string") {return `${prefix}${quoteToonScalar(value)}\n`;}
  if (Array.isArray(value)) {
    if (value.length === 0) {return `${prefix}[]\n`;}
    let out = key == null ? "" : `${pad}${key}[${value.length}]:\n`;
    for (const item of value) {
      if (isRecord(item)) {
        out += `${pad}-\n`;
        for (const [childKey, childValue] of Object.entries(item))
          {out += toonValue(childValue, indent + 1, childKey);}
      } else {
        out += `${pad}- ${scalarLine(item)}\n`;
      }
    }
    return out;
  }
  if (isRecord(value)) {
    let out = key == null ? "" : `${pad}${key}:\n`;
    for (const [childKey, childValue] of Object.entries(value))
      {out += toonValue(childValue, key == null ? indent : indent + 1, childKey);}
    return out;
  }
  return `${prefix}${quoteToonScalar(String(value))}\n`;
}

function scalarLine(value: unknown): string {
  if (value == null || typeof value === "number" || typeof value === "boolean")
    {return String(value);}
  return quoteToonScalar(String(value));
}

function quoteToonScalar(value: string): string {
  if (value === "") {return '""';}
  if (/[\n\r:#,[\]{}]|^\s|\s$/.test(value)) {return JSON.stringify(value);}
  return value;
}

function errorCodeFromMessage(message: string): string {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, 64) || "canvas_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
