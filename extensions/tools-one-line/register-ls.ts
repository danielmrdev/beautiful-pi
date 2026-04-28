import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { absPath, registerTool } from "./shared.ts";

export function registerLsTool(pi: ExtensionAPI): void {
  registerTool(pi, "ls", (args, cwd, theme) =>
    `${theme.fg("muted", "List")}  ${theme.fg("syntaxFunction", absPath(args.path, cwd))}`
  );
}
