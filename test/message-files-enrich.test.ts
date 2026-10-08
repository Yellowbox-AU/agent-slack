import { describe, expect, test } from "bun:test";
import { fetchChannelHistory } from "../src/slack/messages.ts";

describe("fetchChannelHistory file enrichment", () => {
  test("looks up only files without a download URL, in parallel, capped, on the right message", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const filesInfo: string[] = [];
    const url = "https://files.example/x";
    const messages = Array.from({ length: 12 }, (_, i) => ({
      ts: `${i + 1}.000001`,
      text: `m${i}`,
      files: [
        { id: `FBARE${i}A`, mode: "snippet" },
        { id: `FSNIP${i}B`, mode: "snippet", url_private_download: url },
      ],
    }));
    const client = {
      api: async (method: string, params: Record<string, unknown>) => {
        if (method === "conversations.history") {
          return { messages };
        }
        filesInfo.push(String(params.file));
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (params.file === "FBARE3A") {
          throw new Error("file_not_found");
        }
        return { file: { url_private_download: `${url}/${params.file}` } };
      },
    };

    const out = await fetchChannelHistory(client as never, { channelId: "D12345678" });

    expect(filesInfo.sort()).toEqual(messages.map((_, i) => `FBARE${i}A`).sort());
    expect(maxInFlight).toBe(5);
    for (const [i, m] of out.entries()) {
      const [bare, snip] = m.files!;
      expect(bare!.id).toBe(`FBARE${i}A`);
      expect(bare!.url_private_download).toBe(i === 3 ? undefined : `${url}/FBARE${i}A`);
      expect(snip!.id).toBe(`FSNIP${i}B`);
      expect(snip!.url_private_download).toBe(url);
      expect(snip!.snippet).toBeUndefined();
    }
  });
});
