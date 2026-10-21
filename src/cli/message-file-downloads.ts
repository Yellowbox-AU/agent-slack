import type { SlackAuth } from "../slack/client.ts";
import type { SlackMessageSummary } from "../slack/messages.ts";
import { ensureDownloadsDir } from "../lib/tmp-paths.ts";
import {
  type DownloadResult,
  downloadSlackFileOrCanvas,
  writeDownloadErrorFile,
} from "../slack/files.ts";

export async function downloadMessageFiles(input: {
  auth: SlackAuth;
  messages: SlackMessageSummary[];
}): Promise<Record<string, DownloadResult>> {
  const downloadedPaths: Record<string, DownloadResult> = {};
  const downloadsDir = await ensureDownloadsDir();

  for (const message of input.messages) {
    for (const file of message.files ?? []) {
      if (downloadedPaths[file.id]) {
        continue;
      }
      const result = await downloadSlackFileOrCanvas({
        auth: input.auth,
        destDir: downloadsDir,
        file,
      });
      if (!result) {
        continue;
      }
      if (!result.ok) {
        downloadedPaths[file.id] = {
          ...result,
          path: await writeDownloadErrorFile({
            destDir: downloadsDir,
            fileId: file.id,
            error: result.error,
          }),
        };
        console.error(`Warning: skipping file ${file.id}: ${result.error}`);
      } else {
        downloadedPaths[file.id] = result;
      }
    }
  }

  return downloadedPaths;
}
