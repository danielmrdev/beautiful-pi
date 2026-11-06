/**
 * Herdr pane label sync — mirrors the Pi session name onto the current Herdr
 * terminal's `pi.session` label (`hc label`) for herdr-app layouts, and falls
 * back to `herdr pane rename` for legacy Herdr sessions.
 *
 * Source of truth: Pi's `session_info_changed` event, emitted by
 * `setSessionName()`. One hook covers every rename source — LLM title,
 * `/name`, RPC. On `session_start`, sync the loaded name (or clear a stale
 * label) for startup, resume, reload and fork.
 *
 * Everything is fire-and-forget: Herdr is optional, so failures are silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../shared/settings.ts";

// Env is read lazily so the module is testable and never captures stale
// identifiers. herdr-app supplies HC_TERMINAL_ID; old Herdr supplies the
// HERDR_ENV/HERDR_PANE_ID pair.

type HerdrTarget =
  | { kind: "app"; id: string }
  | { kind: "legacy"; id: string };

function target(): HerdrTarget | undefined {
  const terminalId = process.env.HC_TERMINAL_ID;
  if (typeof terminalId === "string" && terminalId.length > 0) {
    return { kind: "app", id: terminalId };
  }

  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV === "1" && typeof paneId === "string" && paneId.length > 0) {
    return { kind: "legacy", id: paneId };
  }
}

function syncSessionLabel(label: string | undefined, pi: ExtensionAPI): void {
  if (!loadSettings().syncHerdrPaneLabel) return;
  const current = target();
  if (!current) return;

  const args = current.kind === "app"
    ? ["label", current.id, `pi.session=${label ?? ""}`]
    : label
      ? ["pane", "rename", current.id, label]
      : ["pane", "rename", current.id, "--clear"];
  pi.exec(current.kind === "app" ? "hc" : "herdr", args).catch(() => {});
}

export default function herdrPaneSyncExtension(pi: ExtensionAPI): void {
  if (!target()) return;

  pi.on("session_info_changed", (event: any) => {
    if (typeof event?.name === "string" && event.name) {
      syncSessionLabel(event.name, pi);
    }
  });

  pi.on("session_start", () => {
    const name = pi.getSessionName();
    syncSessionLabel(typeof name === "string" && name ? name : undefined, pi);
  });

  pi.on("session_shutdown", (event: any) => {
    if (event?.reason === "quit") {
      syncSessionLabel(undefined, pi);
    }
  });
}
