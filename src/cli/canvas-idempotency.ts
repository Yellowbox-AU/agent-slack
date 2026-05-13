// @ts-nocheck
import { createHash } from "crypto";

export type CanvasIdempotencyInput = {
  workspace?: string;
  command: string;
  canvasId?: string;
  sectionId?: string;
  targetId?: string;
  content?: string;
  options?: Record<string, unknown>;
  explicit?: string;
};

export function deriveCanvasIdempotencyKey(input: CanvasIdempotencyInput): string {
  if (input.explicit?.trim()) {
    return input.explicit.trim();
  }
  const natural = {
    workspace: normalize(input.workspace),
    command: input.command.trim().toLowerCase(),
    canvas_id: normalize(input.canvasId),
    section_id: normalize(input.sectionId),
    target_id: normalize(input.targetId),
    content: normalizeMultiline(input.content),
    options: stableJson(input.options ?? {}),
  };
  const hash = createHash("sha256").update(stableJson(natural)).digest("hex").slice(0, 24);
  return `canvas-${natural.command.replace(/[^a-z0-9]+/g, "-")}-${hash}`;
}

function normalize(value?: string): string {
  return value?.trim().toLowerCase().replace(/\/+$/, "") ?? "";
}

function normalizeMultiline(value?: string): string {
  return value?.replace(/\r\n/g, "\n").trim() ?? "";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
