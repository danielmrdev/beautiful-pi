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
import type { Model } from "@earendil-works/pi-ai";
import { activateAccountModel } from "./provider.ts";
import {
  markCooldown,
  nextEligibleMember,
  beginOrContinueRequest,
  getSharedRotationState,
  type RotationContext,
  type RotationState,
} from "./rotation.ts";
import { nextChainMember, chainContainingCredential, chainPoolForCredential } from "./chain.ts";
import { rotationContextFrom } from "./context.ts";
import { loadGlobalAccountConfig, loadProjectAccountConfig, resolveEffectiveConfig, saveGlobalAccountConfig } from "./store.ts";
import type { AccountConfig, CodexChain } from "./types.ts";

/** Structural slice of the extension context the failover needs. */
export interface FailoverContext {
  cwd: string;
  hasUI?: boolean;
  isProjectTrusted?(): boolean;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  modelRegistry: {
    getAll(): Model<any>[];
    getProviderAuthStatus(id: string): { configured: boolean } | undefined;
    registerProvider(provider: unknown): void;
    hasConfiguredAuth(model: Model<any>): boolean;
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
      /** Index of the target member in the pool — persisted as the pointer. */
      toIndex: number;
      /** Pool that produced the target member; absent for direct account targets. */
      poolId?: string;
      /** Chain the retry advanced through; absent for plain pool rotation. */
      chainId?: string;
      /** Chain target index that produced the member (replay progress). */
      toTargetIndex?: number;
      userText: string;
    }
  | { kind: "none" };

/**
 * Decide whether a settled run needs failover. Only Codex rate-limit errors
 * on a member of an enabled pool (directly, or via a chain target) trigger
 * rotation. The failed account is recorded as attempted (replay guard, keyed
 * by user text) and cooled down; the next eligible member wins.
 *
 * When the failed provider belongs to a chain, retry replay advances the
 * chain from the failed target (round-robin past the failed member first), so
 * chain progress is preserved and failed targets are never revisited. Plain
 * pools keep the existing within-pool rotation.
 */
export function decideFailover(
  run: FailoverRunInfo,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): FailoverDecision {
  if (!run.lastError || !isCodexRateLimitError(run.lastError)) return { kind: "none" };
  if (!run.lastProvider) return { kind: "none" };
  const chain = chainContainingCredential(cfg, run.lastProvider);
  if (!chain) {
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
      toIndex: member.index,
      poolId: pool.id,
      userText: run.lastUserText,
    };
  }
  beginOrContinueRequest(state, run.lastUserText);
  state.attempted.add(run.lastProvider);
  const owningPool = chainPoolForCredential(cfg, chain, run.lastProvider);
  markCooldown(state, run.lastProvider, owningPool?.cooldownSeconds ?? 60, now);
  const walk = nextChainMember(chain, cfg, ctx, state, now);
  if (!walk) return { kind: "none" };
  return {
    kind: "retry",
    fromCredentialId: run.lastProvider,
    toCredentialId: walk.member.credentialId,
    poolName: walk.pool?.name ?? chain.name,
    toIndex: walk.member.index,
    ...(walk.pool ? { poolId: walk.pool.id } : {}),
    chainId: chain.id,
    toTargetIndex: walk.targetIndex,
    userText: run.lastUserText,
  };
}

// ── Action ───────────────────────────────────────────────────────────────────

/**
 * Apply a retry decision: switch the active model to the target account and
 * re-send the interrupted user text. The pool's rotation pointer (and, for
 * chain replay, the chain's target progress) is advanced to the target so
 * the next retry continues from here.
 */
export async function actOnFailover(
  pi: ExtensionAPI,
  ctx: FailoverContext,
  decision: FailoverDecision,
): Promise<void> {
  if (decision.kind !== "retry") return;
  const cfg = loadGlobalAccountConfig();
  const account = cfg.accounts.find((a) => a.credentialId === decision.toCredentialId);
  const switched = account
    ? await activateAccountModel(pi, ctx.modelRegistry as never, account)
    : undefined;
  if (!switched) return;
  if (ctx.hasUI) {
    ctx.ui?.notify(
      `Codex rate limit on ${decision.fromCredentialId}; switched to ${decision.toCredentialId} (pool ${decision.poolName}), retrying`,
      "warning",
    );
  }
  // Persist the advanced rotation pointer (best-effort; no-op without config).
  let pools = cfg.pools ?? [];
  if (decision.poolId) {
    pools = pools.map((p) =>
      p.id === decision.poolId ? { ...p, lastUsedIndex: decision.toIndex } : p
    );
  }
  let chains = cfg.chains ?? [];
  const toTarget = decision.chainId ? decision.toTargetIndex : undefined;
  if (decision.chainId && toTarget !== undefined) {
    const chainId = decision.chainId;
    chains = chains.map((c) =>
      c.id === chainId ? { ...c, lastUsedTargetIndex: toTarget } : c
    );
  }
  saveGlobalAccountConfig({ ...cfg, pools, chains });
  pi.sendUserMessage(decision.userText);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

let lastRun: FailoverRunInfo | null = null;
/** Key of the run already failover'd — guards against re-settled events. */
let actedOn: string | null = null;

function runKey(run: FailoverRunInfo): string {
  return `${run.lastUserText}\u0000${run.lastProvider}\u0000${run.lastError}`;
}

/**
 * Register the failover event handlers: capture the run on `agent_end`, act on
 * `agent_settled` (only then is the run guaranteed settled — no automatic
 * retry/compaction pending). A new `agent_end` resets the acted-on guard so a
 * retry run's own failure can fail over again; a duplicated `agent_settled`
 * for the same run is ignored.
 */
export function wireFailover(pi: ExtensionAPI): void {
  const key = Symbol.for("beautiful-pi:codex-failover-wired");
  if ((globalThis as Record<symbol, unknown>)[key]) return;
  (globalThis as Record<symbol, unknown>)[key] = true;

  pi.on("agent_end", (event, ctx) => {
    lastRun = extractRunInfo((event as { messages: unknown[] }).messages ?? []);
    actedOn = null;
  });
  pi.on("agent_settled", (_event, ctx) => {
    const run = lastRun;
    if (!run || !run.lastError || !run.lastUserText) return;
    if (runKey(run) === actedOn) return;
    // Replay runs against the effective config (trusted project overrides
    // applied) so a retry never fails over to a member a project override
    // excluded.
    const global = loadGlobalAccountConfig();
    const project = ctx.isProjectTrusted?.() ? loadProjectAccountConfig(ctx.cwd) : null;
    const cfg = project ? resolveEffectiveConfig(global, project) : global;
    const decision = decideFailover(run, cfg, rotationContextFrom(ctx), getSharedRotationState());
    if (decision.kind === "retry") {
      actedOn = runKey(run);
      return actOnFailover(pi, ctx, decision);
    }
  });
}
