import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { absPath, registerTool } from "./shared.ts";

export function registerEditTool(pi: ExtensionAPI): void {
  registerTool(pi, "edit", (args, cwd, theme) =>
    `${theme.fg("muted", "Edit")}  ${theme.fg("syntaxFunction", absPath(args.path, cwd))}`
  );
}
