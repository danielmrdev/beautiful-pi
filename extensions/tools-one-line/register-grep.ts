import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { absPath, compact, registerTool } from "./shared.ts";

export function registerGrepTool(pi: ExtensionAPI): void {
  registerTool(pi, "grep", (args, cwd, theme) =>
    `${theme.fg("muted", "Grep")}  ${theme.fg("syntaxNumber", compact(args.pattern))}  ${theme.fg("dim", absPath(args.path, cwd))}${args.glob ? theme.fg("dim", `  (${args.glob})`) : ""}`
  );
}
