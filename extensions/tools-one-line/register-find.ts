import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { absPath, compact, registerTool } from "./shared.ts";

export function registerFindTool(pi: ExtensionAPI): void {
  registerTool(pi, "find", (args, cwd, theme) =>
    `${theme.fg("muted", "Find")}  ${theme.fg("syntaxVariable", compact(args.pattern))}  ${theme.fg("dim", absPath(args.path, cwd))}`
  );
}
