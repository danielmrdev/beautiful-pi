/**
 * Codex rate-limit failover.
 *
 * pi gives no request-error hook, so the failover reads the settled run:
 * `agent_end` captures the run (user text, failing provider, error message)
 * and `agent_settled` decides whether the error is a Codex rate limit and, if
 * so, rotates to the pool's next eligible member, switches the model, and
 * re-sends the interrupted user text. Replay state (the attempted set) is
 * keyed by user text so consecutive retries never reuse an account for the
 * same request. Non-rate-limit errors are never touched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadGlobalAccountConfig } from "./store.ts";
import { notify } from "./commands.ts";
import {
  markCooldown,
  nextEligibleMember,
  beginOrContinueRequest,
  getSharedRotationState,
  resetSharedRotationState,
  type RotationContext,
  type RotationState,
} from "./rotation.ts";
import { rotationContextFrom } from "./context.ts";
import type { AccountConfig } from "./types.ts";

/** Structural slice of the extension context the failover needs. */
export interface FailoverContext {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  modelRegistry: {
    getAll(): { provider: string }[];
    getProviderAuthStatus(id: string): { configured: boolean } | undefined;
  };
}

// ── Error classification ─────────────────────────────────────────────────────
const RATE_LIMIT_RE = /\b429\b|rate[\s-]?limit|quota|too many requests/i;

export function isCodexRateLimitError(message: string): boolean {
  return RATE_LIMIT_RE.test(message);
}

// ── Run extraction ───────────────────────────────────────────────────────────

export interface FailoverRunInfo {
  lastUserText: string;
  lastProvider?: string;
  lastError?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text?: unknown } =>
        !!c && typeof c === "object" && (c as { type?: unknown }).type === "text")
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

/** Pull the request text and the final assistant failure from a run's messages. */
export function extractRunInfo(messages: readonly unknown[]): FailoverRunInfo {
  let lastUserText = "";
  let lastProvider: string | undefined;
  let lastError: string | undefined;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    if (msg.role === "user") {
      lastUserText = textOf(msg.content);
    } else if (msg.role === "assistant") {
      if (typeof msg.provider === "string") lastProvider = msg.provider;
      if (typeof msg.errorMessage === "string") lastError = msg.errorMessage;
    }
  }
  return { lastUserText, lastProvider, lastError };
}

// ── Decision ─────────────────────────────────────────────────────────────────

export type FailoverDecision =
  | {
      kind: "retry";
      fromCredentialId: string;
      toCredentialId: string;
      poolName: string;
      userText: string;
    }
  | { kind: "none" };

/**
 * Decide whether a settled run needs failover. Only Codex rate-limit errors
 * on a member of an enabled pool trigger rotation. The failed account is
 * recorded as attempted (replay guard, keyed by user text) and cooled down;
 * the next eligible member wins.
 */
export function decideFailover(
  run: FailoverRunInfo,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): FailoverDecision {  if (!run.lastError || !isCodexRateLimitError(run.lastError)) return { kind: "none" };
  if (!run.lastProvider) return { kind: "none" };
  const pool = (cfg.pools ?? []).find(
    (p) => p.enabled && p.credentialIds.includes(run.lastProvider!),
  );
  if (!pool) return { kind: "none" };
  beginOrContinueRequest(state, run.lastUserText);
  state.attempted.add(run.lastProvider);
  markCooldown(state, run.lastProvider, pool.cooldownSeconds, now);
  const member = nextEligibleMember(pool, cfg, ctx, state, now);
  if (!member) return { kind: "none" };
  return {
    kind: "retry",
    fromCredentialId: run.lastProvider,
    toCredentialId: member.credentialId,
    poolName: pool.name,
    userText: run.lastUserText,
  };
}

// ── Action ───────────────────────────────────────────────────────────────────

/**
 * Apply a retry decision: switch the active model to the target account's
 * first model and re-send the interrupted user text.
 */
export async function actOnFailover(
  pi: ExtensionAPI,
  ctx: FailoverContext,
  decision: FailoverDecision,
): Promise<void> {
  if (decision.kind !== "retry") return;
  const target = ctx.modelRegistry.getAll().find((m) => m.provider === decision.toCredentialId);
  if (!target) return;
  const switched = await pi.setModel(target as never);
  if (!switched) return;
  notify(
    ctx,
    `Codex rate limit on ${decision.fromCredentialId}; switched to ${decision.toCredentialId} (pool ${decision.poolName}), retrying`,
    "warning",
  );
  pi.sendUserMessage(decision.userText);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

let lastRun: FailoverRunInfo | null = null;

/** Reset module state (tests, /reload). */
export function resetFailoverState(): void {
  lastRun = null;
  resetSharedRotationState();
}

function rotationContextFor(ctx: FailoverContext): RotationContext {
  return rotationContextFrom(ctx);
}

/**
 * Register the failover event handlers: capture the run on `agent_end`, act on
 * `agent_settled` (only then is the run guaranteed settled — no automatic
 * retry/compaction pending).
 */
export function wireFailover(pi: ExtensionAPI): void {
  pi.on("agent_end", (event, ctx) => {
    lastRun = extractRunInfo((event as { messages: unknown[] }).messages ?? []);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const run = lastRun;
    if (!run || !run.lastError || !run.lastUserText) return;
    const cfg = loadGlobalAccountConfig();
    const decision = decideFailover(run, cfg, rotationContextFor(ctx), getSharedRotationState());
    if (decision.kind === "retry") void actOnFailover(pi, ctx, decision);
  });
}
