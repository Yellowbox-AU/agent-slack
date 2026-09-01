import { describe, expect, test } from "bun:test";
import { searchMessagesViaSearchApi } from "../src/slack/search-messages.ts";
import type { SlackApiClient, SlackAuth } from "../src/slack/client.ts";

// Search results are built straight from search.messages matches with no
// per-hit re-fetch, so any client API call during these tests is a regression.
const clientThatMustNotBeCalled = {
  api: async (method: string) => {
    throw new Error(`unexpected Slack API call: ${method}`);
  },
} as unknown as SlackApiClient;

const auth: SlackAuth = { auth_type: "standard", token: "xoxb-test" };

function run(
  rawMatches: Record<string, unknown>[],
  overrides?: { contentType?: "any" | "text" | "image" | "snippet" | "file"; limit?: number },
) {
  return searchMessagesViaSearchApi(clientThatMustNotBeCalled, {
    auth,
    slack_query: "test",
    limit: overrides?.limit ?? 20,
    maxContentChars: 8000,
    contentType: overrides?.contentType ?? "any",
    download: false,
    rawMatches,
  });
}

describe("searchMessagesViaSearchApi (summary built from raw match)", () => {
  test("full match maps text, author, files, permalink and forwarded threads without any API call", async () => {
    const result = await run([
      {
        ts: "1756000000.000100",
        channel: { id: "C11111111" },
        user: "U11111111",
        text: "shipped the fix",
        permalink: "https://yb.slack.com/archives/C11111111/p1756000000000100",
        files: [{ id: "F1", name: "diff.png", mimetype: "image/png", mode: "hosted" }],
        attachments: [
          {
            from_url:
              "https://yb.slack.com/archives/C22222222/p1755000000000200?thread_ts=1755000000.000200&cid=C22222222",
            reply_count: 4,
          },
        ],
      },
    ]);

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.channel_id).toBe("C11111111");
    expect(msg.ts).toBe("1756000000.000100");
    expect(msg.author).toEqual({ user_id: "U11111111", bot_id: undefined });
    expect(msg.content).toContain("shipped the fix");
    expect(msg.permalink).toBe("https://yb.slack.com/archives/C11111111/p1756000000000100");
    expect(msg.forwarded_threads).toEqual([
      {
        url: "https://yb.slack.com/archives/C22222222/p1755000000000200?thread_ts=1755000000.000200&cid=C22222222",
        thread_ts: "1755000000.000200",
        channel_id: "C22222222",
        reply_count: 4,
      },
    ]);
  });

  test("textless match renders with empty content instead of triggering a fallback fetch", async () => {
    const result = await run([
      {
        ts: "1756000001.000100",
        channel: { id: "C11111111" },
        user: "U11111111",
        files: [{ id: "F2", name: "report.pdf", mimetype: "application/pdf", mode: "hosted" }],
      },
    ]);

    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.content).toBeUndefined();
    expect(msg.author).toEqual({ user_id: "U11111111", bot_id: undefined });
    // download=false means files carry no local paths, but the message itself
    // must survive rather than be dropped or re-fetched.
    expect(msg.ts).toBe("1756000001.000100");
  });

  test("bot message with missing user maps bot_id into author", async () => {
    const result = await run([
      {
        ts: "1756000002.000100",
        channel: { id: "C11111111" },
        bot_id: "B99999999",
        text: "deploy finished",
      },
    ]);

    expect(result.messages[0]!.author).toEqual({ user_id: undefined, bot_id: "B99999999" });
  });

  test("incomplete file objects (no id) are dropped without dropping the message", async () => {
    const result = await run([
      {
        ts: "1756000003.000100",
        channel: { id: "C11111111" },
        user: "U11111111",
        text: "two files, one broken",
        files: [{ name: "orphan.txt" }, "not-an-object", null],
      },
    ]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toContain("two files, one broken");
  });

  test("content-type filter runs on the match's own files before any download", async () => {
    const fileMatch = {
      ts: "1756000004.000100",
      channel: { id: "C11111111" },
      user: "U11111111",
      text: "with attachment",
      files: [{ id: "F3", name: "pic.jpg", mimetype: "image/jpeg", mode: "hosted" }],
    };
    const textMatch = {
      ts: "1756000005.000100",
      channel: { id: "C11111111" },
      user: "U11111111",
      text: "plain text",
    };

    const textOnly = await run([fileMatch, textMatch], { contentType: "text" });
    expect(textOnly.messages.map((m) => m.ts)).toEqual(["1756000005.000100"]);

    const imagesOnly = await run([fileMatch, textMatch], { contentType: "image" });
    expect(imagesOnly.messages.map((m) => m.ts)).toEqual(["1756000004.000100"]);
  });

  test("matches without ts or channel id are skipped and the limit still applies", async () => {
    const good = (n: number) => ({
      ts: `175600001${n}.000100`,
      channel: { id: "C11111111" },
      user: "U11111111",
      text: `msg ${n}`,
    });
    const result = await run(
      [
        { channel: { id: "C11111111" }, text: "no ts" },
        { ts: "1756000009.000100", text: "no channel" },
        good(0),
        good(1),
        good(2),
      ],
      { limit: 2 },
    );

    expect(result.messages.map((m) => m.content)).toEqual(["msg 0", "msg 1"]);
  });
});
