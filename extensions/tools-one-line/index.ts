import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadSettings } from "../shared/settings.ts";
import { registerBashTool }  from "./register-bash.ts";
import { registerReadTool }  from "./register-read.ts";
import { registerWriteTool } from "./register-write.ts";
import { registerEditTool }  from "./register-edit.ts";
import { registerGrepTool }  from "./register-grep.ts";
import { registerFindTool }  from "./register-find.ts";
import { registerLsTool }    from "./register-ls.ts";
import { setAgentActive }    from "./shared.ts";
import { patchGenericToolRenderer } from "./register-generic.ts";

export default function toolsOneLineExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  if (!settings.toolsOneLine) return;

  // Track whether the agent is currently running so renderLine can distinguish
  // live tools (show spinner) from zombie tools on resume (show as done).
  pi.on("session_start", () => setAgentActive(false));
  pi.on("agent_start",   () => setAgentActive(true));
  pi.on("agent_end",     () => setAgentActive(false));

  registerBashTool(pi);
  registerReadTool(pi);
  registerWriteTool(pi);
  registerEditTool(pi);
  registerGrepTool(pi);
  registerFindTool(pi);
  registerLsTool(pi);

  // Intercept any tool not explicitly handled above.
  // Runs once at load; /reload re-applies idempotently.
  patchGenericToolRenderer();
}
