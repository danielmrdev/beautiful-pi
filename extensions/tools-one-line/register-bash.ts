import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { compact, registerTool } from "./shared.ts";

export function registerBashTool(pi: ExtensionAPI): void {
  registerTool(pi, "bash", (args, _cwd, theme) =>
    theme.fg("bashMode", compact(args.command).slice(0, 160))
  );
}
