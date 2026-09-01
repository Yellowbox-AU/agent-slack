import type { SlackApiClient, SlackAuth } from "./client.ts";
import type { CompactSlackMessage, SlackFileSummary, SlackMessageSummary } from "./messages.ts";
import { fetchMessage, toCompactMessage } from "./messages.ts";
import { resolveChannelId } from "./channels.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import { type DownloadResult, tryDownloadSlackFile, writeDownloadErrorFile } from "./files.ts";
import { renderSlackMessageContent } from "./render.ts";
import { parseSlackMessageUrl } from "./url.ts";
import { inferExt } from "./search-file-ext.ts";
import { dateToUnixSeconds, resolveUserId } from "./search-query.ts";
import { asArray, getNumber, getString, isRecord } from "../lib/object-type-guards.ts";
import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";
import { collectReferencedUserIds, resolveUsersById, toReferencedUsers } from "./user-cache.ts";
import type { CompactSlackUser } from "./users.ts";

export type ContentType = "any" | "text" | "image" | "snippet" | "file";
export type SearchMessageResult = {
  messages: SearchCompactMessage[];
  referenced_users?: Record<string, CompactSlackUser>;
};

export async function searchMessagesViaSearchApi(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    workspace_url?: string;
    slack_query: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
    rawMatches: Record<string, unknown>[];
    resolveUsers?: boolean;
    refreshUsers?: boolean;
  },
): Promise<SearchMessageResult> {
  const matches = input.rawMatches;
  if (matches.length === 0) {
    return { messages: [] };
  }

  const messageRefs: {
    channel_id: string;
    message_ts: string;
    permalink?: string;
    match: Record<string, unknown>;
  }[] = [];
  for (const m of matches) {
    const ts = getString(m.ts)?.trim() ?? "";
    if (!ts) {
      continue;
    }
    const channelValue = isRecord(m.channel) ? m.channel : null;
    const channelId =
      channelValue && getString(channelValue.id)
        ? getString(channelValue.id)!
        : channelValue && getString(channelValue.name)
          ? await resolveChannelId(client, `#${getString(channelValue.name)}`)
          : "";
    if (!channelId) {
      continue;
    }
    messageRefs.push({
      channel_id: channelId,
      message_ts: ts,
      permalink: getString(m.permalink),
      match: m,
    });
    if (messageRefs.length >= input.limit) {
      break;
    }
  }

  const downloadedPaths: Record<string, DownloadResult> = {};
  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const resolvedMessages: SlackMessageSummary[] = [];
  const out: SearchCompactMessage[] = [];

  for (const ref of messageRefs) {
    // The search.messages match already carries everything the search output
    // needs (text, blocks, files, user, permalink), so build the summary from
    // it directly instead of re-fetching every hit via conversations.history —
    // that per-hit round trip made large searches take ~0.4s per result. The
    // fetch remains only as a catch-clause fallback for a malformed match.
    let full = summaryFromSearchMatch(ref.match, ref.channel_id, ref.message_ts);
    if (!full) {
      try {
        const parsed =
          ref.permalink && typeof ref.permalink === "string"
            ? (() => {
                try {
                  return parseSlackMessageUrl(ref.permalink);
                } catch {
                  return null;
                }
              })()
            : null;

        full = await fetchMessage(client, {
          ref: {
            workspace_url: parsed?.workspace_url ?? input.workspace_url ?? "",
            channel_id: ref.channel_id,
            message_ts: ref.message_ts,
            thread_ts_hint: parsed?.thread_ts_hint,
            raw: parsed?.raw ?? ref.permalink ?? `${ref.channel_id}:${ref.message_ts}`,
          },
        });
      } catch {
        continue;
      }
    }

    // Filter on the message's own files BEFORE downloading, so a text-only
    // search never downloads attachments it is about to discard.
    if (!summaryPassesContentTypeFilter(full, input.contentType)) {
      continue;
    }

    if (downloadsDir) {
      await downloadFilesForMessage({
        auth: input.auth,
        downloadsDir,
        message: full,
        downloadedPaths,
      });
    }

    const compact = toCompactMessage(full, {
      maxBodyChars: input.maxContentChars,
      downloadedPaths,
    });
    resolvedMessages.push(full);
    out.push(toSearchCompactMessage(compact, ref.permalink));
    if (out.length >= input.limit) {
      break;
    }
  }

  const referencedUserIds = collectReferencedUserIds(resolvedMessages, {
    includeReactions: false,
  });
  const shouldResolveUsers = input.resolveUsers || input.refreshUsers;
  const usersById = shouldResolveUsers
    ? await resolveUsersById({
        client,
        workspaceUrl: input.workspace_url ?? "",
        userIds: referencedUserIds,
        forceRefresh: Boolean(input.refreshUsers),
      })
    : new Map();
  return {
    messages: out,
    referenced_users: toReferencedUsers(referencedUserIds, usersById),
  };
}

export async function searchMessagesInChannelsFallback(
  client: SlackApiClient,
  input: {
    auth: SlackAuth;
    workspace_url?: string;
    query: string;
    channels: string[];
    user?: string;
    after?: string;
    before?: string;
    limit: number;
    maxContentChars: number;
    contentType: ContentType;
    download: boolean;
    resolveUsers?: boolean;
    refreshUsers?: boolean;
  },
): Promise<SearchMessageResult> {
  const channelIds = await Promise.all(input.channels.map((c) => resolveChannelId(client, c)));
  const queryLower = input.query.trim().toLowerCase();

  const userId = input.user ? await resolveUserId(client, input.user) : undefined;

  const afterSec = input.after ? dateToUnixSeconds(input.after, "start") : null;
  const beforeSec = input.before ? dateToUnixSeconds(input.before, "end") : null;

  const downloadsDir = input.download ? await ensureDownloadsDir() : null;
  const downloadedPaths: Record<string, DownloadResult> = {};
  const matchedSummaries: SlackMessageSummary[] = [];

  const results: SearchCompactMessage[] = [];

  for (const channelId of channelIds) {
    let cursorLatest: string | undefined;
    for (;;) {
      const resp = await client.api("conversations.history", {
        channel: channelId,
        limit: 200,
        latest: cursorLatest,
      });
      const messages = isRecord(resp) ? asArray(resp.messages).filter(isRecord) : [];
      if (messages.length === 0) {
        break;
      }

      for (const m of messages) {
        const summary = messageSummaryFromApiMessage(channelId, m);

        const tsNum = Number.parseFloat(summary.ts);
        if (Number.isFinite(tsNum)) {
          if (beforeSec !== null && tsNum > beforeSec) {
            continue;
          }
          if (afterSec !== null && tsNum < afterSec) {
            cursorLatest = undefined;
            break;
          }
        }

        if (userId && summary.user !== userId) {
          continue;
        }

        const content = renderSlackMessageContent(summary);
        if (queryLower && !content.toLowerCase().includes(queryLower)) {
          continue;
        }

        if (downloadsDir) {
          await downloadFilesForMessage({
            auth: input.auth,
            downloadsDir,
            message: summary,
            downloadedPaths,
          });
        }

        const compact = toCompactMessage(summary, {
          maxBodyChars: input.maxContentChars,
          downloadedPaths,
        });
        if (!passesContentTypeFilter(compact, input.contentType)) {
          continue;
        }

        matchedSummaries.push(summary);
        results.push(toSearchCompactMessage(compact));
        if (results.length >= input.limit) {
          const referencedUserIds = collectReferencedUserIds(matchedSummaries, {
            includeReactions: false,
          });
          const usersById = await resolveUsersById({
            client,
            workspaceUrl: input.workspace_url ?? "",
            userIds: referencedUserIds,
            forceRefresh: Boolean(input.refreshUsers),
          });
          return {
            messages: results,
            referenced_users: toReferencedUsers(referencedUserIds, usersById),
          };
        }
      }

      if (!cursorLatest) {
        break;
      }

      const last = messages.at(-1);
      cursorLatest = last ? getString(last.ts) : undefined;
      if (!cursorLatest) {
        break;
      }
    }
  }

  const referencedUserIds = collectReferencedUserIds(matchedSummaries, {
    includeReactions: false,
  });
  const shouldResolveUsers = input.resolveUsers || input.refreshUsers;
  const usersById = shouldResolveUsers
    ? await resolveUsersById({
        client,
        workspaceUrl: input.workspace_url ?? "",
        userIds: referencedUserIds,
        forceRefresh: Boolean(input.refreshUsers),
      })
    : new Map();
  return {
    messages: results,
    referenced_users: toReferencedUsers(referencedUserIds, usersById),
  };
}

// Build a message summary straight from a search.messages match. Returns null
// when the match carries no renderable content at all, in which case the caller
// falls back to fetching the message individually.
function summaryFromSearchMatch(
  m: Record<string, unknown>,
  channelId: string,
  ts: string,
): SlackMessageSummary | null {
  const text = getString(m.text);
  const blocks = Array.isArray(m.blocks) ? (m.blocks as unknown[]) : undefined;
  const files = asArray(m.files)
    .map((f) => toSlackFileSummary(f))
    .filter((f): f is SlackFileSummary => f !== null);
  if (text === undefined && !blocks && files.length === 0) {
    return null;
  }
  return {
    channel_id: channelId,
    ts,
    thread_ts: getString(m.thread_ts),
    reply_count: getNumber(m.reply_count),
    user: getString(m.user),
    bot_id: getString(m.bot_id),
    text: text ?? "",
    markdown: slackMrkdwnToMarkdown(text ?? ""),
    blocks,
    attachments: Array.isArray(m.attachments) ? (m.attachments as unknown[]) : undefined,
    files: files.length > 0 ? files : undefined,
  };
}

// Content-type filtering on the message's own file list. The compact-message
// variant below filters on downloaded paths, which only works after downloads
// have run; this one is download-independent so it can run first.
function summaryPassesContentTypeFilter(
  msg: SlackMessageSummary,
  contentType: ContentType,
): boolean {
  if (contentType === "any") {
    return true;
  }
  const files = msg.files ?? [];
  const hasFiles = files.length > 0;
  if (contentType === "text") {
    return !hasFiles;
  }
  if (!hasFiles) {
    return false;
  }
  if (contentType === "file") {
    return true;
  }
  if (contentType === "snippet") {
    return files.some((f) => f.mode === "snippet");
  }
  if (contentType === "image") {
    return files.some((f) => String(f.mimetype ?? "").startsWith("image/"));
  }
  return true;
}

export function passesContentTypeFilter(m: CompactSlackMessage, contentType: ContentType): boolean {
  if (contentType === "any") {
    return true;
  }
  const hasFiles = Boolean(m.files && m.files.length > 0);
  if (contentType === "text") {
    return !hasFiles;
  }
  if (!hasFiles) {
    return false;
  }

  if (contentType === "file") {
    return true;
  }
  if (contentType === "snippet") {
    return (m.files ?? []).some((f) => f.mode === "snippet");
  }
  if (contentType === "image") {
    return (m.files ?? []).some((f) => String(f.mimetype ?? "").startsWith("image/"));
  }
  return true;
}

export type SearchCompactMessage = Omit<CompactSlackMessage, "thread_ts"> & {
  permalink?: string;
};

function toSearchCompactMessage(m: CompactSlackMessage, permalink?: string): SearchCompactMessage {
  const { thread_ts: _threadTs, ...rest } = m;
  return permalink ? { ...rest, permalink } : rest;
}

async function downloadFilesForMessage(input: {
  auth: SlackAuth;
  downloadsDir: string;
  message: SlackMessageSummary;
  downloadedPaths: Record<string, DownloadResult>;
}): Promise<void> {
  for (const f of input.message.files ?? []) {
    if (input.downloadedPaths[f.id]) {
      continue;
    }
    const url = f.url_private_download || f.url_private;
    if (!url) {
      continue;
    }
    const ext = inferExt(f);
    const result = await tryDownloadSlackFile({
      auth: input.auth,
      url,
      destDir: input.downloadsDir,
      preferredName: `${f.id}${ext ? `.${ext}` : ""}`,
    });
    if (!result.ok) {
      input.downloadedPaths[f.id] = {
        ...result,
        path: await writeDownloadErrorFile({
          destDir: input.downloadsDir,
          fileId: f.id,
          error: result.error,
        }),
      };
      console.warn(`Warning: file ${f.id}: ${result.error}`);
    } else {
      input.downloadedPaths[f.id] = result;
    }
  }
}

function messageSummaryFromApiMessage(
  channelId: string,
  msg: Record<string, unknown>,
): SlackMessageSummary {
  const text = getString(msg.text) ?? "";
  const files = asArray(msg.files)
    .map((f) => toSlackFileSummary(f))
    .filter((f): f is SlackFileSummary => f !== null);

  return {
    channel_id: channelId,
    ts: getString(msg.ts) ?? "",
    thread_ts: getString(msg.thread_ts),
    reply_count: getNumber(msg.reply_count),
    user: getString(msg.user),
    bot_id: getString(msg.bot_id),
    text,
    markdown: slackMrkdwnToMarkdown(text),
    blocks: Array.isArray(msg.blocks) ? (msg.blocks as unknown[]) : undefined,
    attachments: Array.isArray(msg.attachments) ? (msg.attachments as unknown[]) : undefined,
    files: files.length > 0 ? files : undefined,
    reactions: Array.isArray(msg.reactions) ? (msg.reactions as unknown[]) : undefined,
  };
}

function toSlackFileSummary(value: unknown): SlackFileSummary | null {
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
