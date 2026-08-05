/**
 * Herdr pane label sync — mirrors the pi session name onto the current herdr
 * pane label (`herdr pane rename`), and clears it when pi exits.
 *
 * Source of truth: pi's `session_info_changed` event, emitted by
 * `setSessionName()`. One hook covers every rename source — LLM title,
 * `/name`, RPC. On `session_start` the label is also synced when a session
 * already has a name (resume/reload/fork), where no rename event fires.
 *
 * Everything is fire-and-forget: herdr is optional, so failures are silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../shared/settings.ts";

// Env is read lazily so the module is testable and never captures a stale
// environment; herdr sets these at process launch and they never change.

function paneId(): string | undefined {
  const id = process.env.HERDR_PANE_ID;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function enabled(): boolean {
  return process.env.HERDR_ENV === "1" && paneId() !== undefined;
}

function renamePane(label: string, pi: ExtensionAPI): void {
  if (!loadSettings().syncHerdrPaneLabel) return;
  const id = paneId();
  if (!id) return;
  pi.exec("herdr", ["pane", "rename", id, label]).catch(() => {});
}

function clearPaneLabel(pi: ExtensionAPI): void {
  if (!loadSettings().syncHerdrPaneLabel) return;
  const id = paneId();
  if (!id) return;
  pi.exec("herdr", ["pane", "rename", id, "--clear"]).catch(() => {});
}

export default function herdrPaneSyncExtension(pi: ExtensionAPI): void {
  if (!enabled()) return;

  pi.on("session_info_changed", (event: any) => {
    if (typeof event?.name === "string" && event.name) {
      renamePane(event.name, pi);
    }
  });

  pi.on("session_start", () => {
    const name = pi.getSessionName();
    if (typeof name === "string" && name) {
      renamePane(name, pi);
    }
  });

  pi.on("session_shutdown", (event: any) => {
    if (event?.reason === "quit") {
      clearPaneLabel(pi);
    }
  });
}
