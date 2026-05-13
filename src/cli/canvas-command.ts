import type { Command } from "commander";
import { buildErrorEnvelope, serializeCanvasOutput } from "./canvas-output.ts";
import { main as runCanvasCommand } from "./canvas-command-impl.ts";

export function registerCanvasCommand(input: { program: Command; ctx?: unknown }): void {
  input.program
    .command("canvas")
    .description("Work with Slack canvases")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[args...]", "Canvas command arguments")
    .action(async (args: string[]) => {
      try {
        await runCanvasCommand(args);
      } catch (err: unknown) {
        process.stdout.write(serializeCanvasOutput(buildErrorEnvelope(err)));
        process.exitCode = 1;
      }
    });
}
