/**
 * codex-accounts-pool foundation — entry point.
 *
 * Registers the `/codex` command surface, re-registers managed account
 * providers on session start (so pi's `/login` can authenticate them even
 * after `/reload`), and auto-migrates legacy multi-pass configuration.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexCommand } from "./commands.ts";
import { registerAllAccountProviders } from "./provider.ts";
import { runMigration } from "./migration.ts";
import { agentDirPath, loadGlobalAccountConfig } from "./store.ts";

export default function codexAccountsExtension(pi: ExtensionAPI): void {
  registerCodexCommand(pi);

  pi.on("session_start", (event, ctx: ExtensionContext) => {
    // Re-register suffixed account providers (idempotent) so `/login` and
    // account switching work after reloads.
    const cfg = loadGlobalAccountConfig();
    registerAllAccountProviders(ctx.modelRegistry, cfg.accounts);
    // Auto-migrate legacy config; project part only when the project is trusted.
    runMigration(agentDirPath(), ctx.cwd, { trusted: ctx.isProjectTrusted() });
  });
}
