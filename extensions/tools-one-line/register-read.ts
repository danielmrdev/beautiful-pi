import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { absPath, readRange, registerTool } from "./shared.ts";

export function registerReadTool(pi: ExtensionAPI): void {
  registerTool(pi, "read", (args, cwd, theme) =>
    `${theme.fg("muted", "Read")}  ${theme.fg("syntaxFunction", absPath(args.path, cwd))}${theme.fg("dim", readRange(args.offset, args.limit))}`
  );
}
