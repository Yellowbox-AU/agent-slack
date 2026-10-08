import type { SlackApiClient } from "./client.ts";
import type { SlackFileSummary } from "./messages.ts";
import { getNumber, getString, isRecord } from "../lib/object-type-guards.ts";

export function toSlackFileSummary(value: unknown): SlackFileSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: getString(value.name),
    title: getString(value.title),
    mimetype: getString(value.mimetype),
    filetype: getString(value.filetype),
    mode: getString(value.mode),
    permalink: getString(value.permalink),
    url_private: getString(value.url_private),
    url_private_download: getString(value.url_private_download),
    size: getNumber(value.size),
  };
}

// Matches the users.info batching in user-cache.ts. The cap limits requests in
// flight, not requests per minute.
const FILES_INFO_CONCURRENCY = 5;

async function enrichFile(client: SlackApiClient, f: SlackFileSummary): Promise<SlackFileSummary> {
  // A file with a download URL needs no lookup: downloads use that URL, and
  // no output reads the snippet content files.info would add.
  if (f.url_private_download) {
    return f;
  }
  try {
    const info = await client.api("files.info", { file: f.id });
    const file = isRecord(info.file) ? info.file : null;
    return {
      ...f,
      name: f.name ?? getString(file?.name),
      title: f.title ?? getString(file?.title),
      mimetype: f.mimetype ?? getString(file?.mimetype),
      filetype: f.filetype ?? getString(file?.filetype),
      mode: f.mode ?? getString(file?.mode),
      permalink: f.permalink ?? getString(file?.permalink),
      url_private: f.url_private ?? getString(file?.url_private),
      url_private_download: f.url_private_download ?? getString(file?.url_private_download),
      snippet: {
        content: getString(file?.content),
        language: getString(file?.filetype),
      },
    };
  } catch {
    // ignore and fall back to summary
    return f;
  }
}

export async function enrichFiles(
  client: SlackApiClient,
  files: SlackFileSummary[],
): Promise<SlackFileSummary[]> {
  const out = [...files];
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      const i = next++;
      out[i] = await enrichFile(client, out[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILES_INFO_CONCURRENCY, out.length) }, worker));
  return out;
}

/** Enriches every message's files in one capped parallel batch, in place. */
export async function enrichMessageFiles(
  client: SlackApiClient,
  messages: { files?: SlackFileSummary[] }[],
): Promise<void> {
  const enriched = await enrichFiles(
    client,
    messages.flatMap((m) => m.files ?? []),
  );
  let i = 0;
  for (const m of messages) {
    if (m.files) {
      const count = m.files.length;
      m.files = enriched.slice(i, i + count);
      i += count;
    }
  }
}
