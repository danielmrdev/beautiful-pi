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
 * It also reports `pi.state` for herdr-app: `blocked` while `ask_user_question`
 * is open, and `working` while `@tintinweb/pi-subagents` are active, so
 * herdr-app/mods don't show the parent pane as idle during delegated work.
 *
 * Everything is fire-and-forget: Herdr is optional, so failures are silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_USER_BLOCKED_EVENT } from "../ask-user-question/events.ts";
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

function setPiState(state: "blocked" | "working" | undefined, pi: ExtensionAPI): void {
  const current = target();
  if (!current || current.kind !== "app") return;
  pi.exec("hc", ["label", current.id, `pi.state=${state ?? ""}`]).catch(() => {});
}

export default function herdrPaneSyncExtension(pi: ExtensionAPI): void {
  let askBlocked = false;
  const activeSubagents = new Set<string>();

  const syncDerivedState = (): void => {
    if (askBlocked) {
      setPiState("blocked", pi);
    } else if (activeSubagents.size > 0) {
      setPiState("working", pi);
    } else {
      setPiState(undefined, pi);
    }
  };

  const activateSubagent = (data: any): void => {
    const id = typeof data?.id === "string" ? data.id : typeof data?.agentId === "string" ? data.agentId : undefined;
    if (id) activeSubagents.add(id);
    else activeSubagents.add(`anon:${activeSubagents.size}:${Date.now()}`);
    syncDerivedState();
  };

  const deactivateSubagent = (data: any): void => {
    const id = typeof data?.id === "string" ? data.id : typeof data?.agentId === "string" ? data.agentId : undefined;
    if (id) activeSubagents.delete(id);
    else activeSubagents.clear();
    syncDerivedState();
  };

  // Bridge ask_user_question's blocked state to Herdr's attention indicator.
  // - Legacy herdr TUI: emit "herdr:blocked" for herdr-agent-state.ts.
  // - herdr-app: set/clear the `pi.state` terminal label so mods (bh-agents)
  //   can surface the agent under "Needs you".
  pi.events.on(ASK_USER_BLOCKED_EVENT, (data: any) => {
    askBlocked = data?.active === true;
    pi.events.emit("herdr:blocked", { active: askBlocked, label: "ask_user_question" });
    syncDerivedState();
  });

  // Reflect pi-subagents activity as "working" in herdr-app so a parent pane
  // isn't shown idle while delegated subagents are still running.
  for (const event of ["subagents:started", "subagents:created"]) {
    pi.events.on(event, activateSubagent);
  }
  for (const event of ["subagents:completed", "subagents:failed"]) {
    pi.events.on(event, deactivateSubagent);
  }

  if (!target()) return;

  pi.on("session_info_changed", (event: any) => {
    if (typeof event?.name === "string" && event.name) {
      syncSessionLabel(event.name, pi);
    }
  });

  pi.on("session_start", () => {
    activeSubagents.clear();
    askBlocked = false;
    syncDerivedState();
    const name = pi.getSessionName();
    syncSessionLabel(typeof name === "string" && name ? name : undefined, pi);
  });

  pi.on("session_shutdown", (event: any) => {
    activeSubagents.clear();
    askBlocked = false;
    syncDerivedState();
    if (event?.reason === "quit") {
      syncSessionLabel(undefined, pi);
    }
  });
}
