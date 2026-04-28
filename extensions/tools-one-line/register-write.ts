import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { absPath, registerTool } from "./shared.ts";

export function registerWriteTool(pi: ExtensionAPI): void {
  registerTool(pi, "write", (args, cwd, theme) =>
    `${theme.fg("muted", "Write")}  ${theme.fg("syntaxFunction", absPath(args.path, cwd))}`
  );
}
