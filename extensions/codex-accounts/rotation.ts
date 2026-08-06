/**
 * Pool rotation state and selection.
 *
 * Pure logic with injectable state: cooldowns and the per-request attempted
 * set live in a RotationState instance (module memory, not persisted). A
 * shared singleton (cooldowns survive across commands and failovers) is also
 * exposed; the replay/attempted part is request-scoped and cleared by
 * `beginOrContinueRequest`.
 */
import type { AccountConfig, CodexPool } from "./types.ts";

export interface RotationState {
  /** credentialId -> timestamp until which the account is skipped. */
  cooldownUntil: Map<string, number>;
  /** credentialIds already attempted for the current request (replay guard). */
  attempted: Set<string>;
  /** User text the attempted set belongs to; a different text starts fresh. */
  replayText?: string;
}

export function createRotationState(): RotationState {
  return { cooldownUntil: new Map(), attempted: new Set() };
}

/**
 * Continue the replay chain when the same user text fails again; reset the
 * attempted set when a new request starts.
 */
export function beginOrContinueRequest(state: RotationState, userText: string): void {
  if (state.replayText === userText) return;
  state.replayText = userText;
  state.attempted.clear();
}

/** Start a fresh request: drop the attempted set and any replay key. */
export function beginNewRequest(state: RotationState): void {
  state.replayText = undefined;
  state.attempted.clear();
}

// Shared singleton: cooldowns persist across commands and failovers; the
// attempted set is reset per request via beginOrContinueRequest/beginNewRequest.

let sharedState: RotationState = createRotationState();

export function getSharedRotationState(): RotationState {
  return sharedState;
}

export function markCooldown(state: RotationState, credentialId: string, seconds: number, now: number = Date.now()): void {
  if (seconds <= 0) return;
  state.cooldownUntil.set(credentialId, now + seconds * 1000);
}

export function isCooldownActive(state: RotationState, credentialId: string, now: number = Date.now()): boolean {
  const until = state.cooldownUntil.get(credentialId);
  return until !== undefined && until > now;
}

/** Eligibility checks supplied by the caller (auth status, project rules). */
export interface RotationContext {
  authConfigured(credentialId: string): boolean;
  allowed(credentialId: string): boolean;
}

/**
 * Everything a member-selection decision needs, bundled so the
 * `(cfg, ctx, state, now)` tuple is threaded as one value instead of a data
 * clump through rotation, strategies, chains, and the commands.
 */
export interface SelectionContext {
  /** Effective account config (global, or merged with trusted project overrides). */
  cfg: AccountConfig;
  /** Eligibility predicates (auth status, project restriction). */
  ctx: RotationContext;
  /** Rotation state (cooldowns + per-request attempted set). */
  state: RotationState;
  /** Evaluation time as ms epoch — cooldown expiry and schedule windows. */
  now: number;
}

/** Bundle the selection inputs into one context value. */
export function createSelectionContext(
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): SelectionContext {
  return { cfg, ctx, state, now };
}

export interface EligibleMember {
  credentialId: string;
  /** Index into the pool's credentialIds (the new round-robin pointer). */
  index: number;
}

/**
 * Why a credential fails the shared eligibility predicate. The chain layer
 * adds its own "cooling down" on top of this set.
 */
export type MemberUnavailableReason =
  | "no account entry"
  | "already attempted"
  | "not authenticated"
  | "restricted in this project";

/**
 * The first reason a credential cannot be routed to right now, or undefined
 * when it is eligible: missing account entry, already attempted for this
 * request, unauthenticated, or project-restricted. Cooldown is deliberately
 * excluded (callers fold it in where they need it).
 */
export function eligibilityReason(
  credentialId: string,
  sel: SelectionContext,
): MemberUnavailableReason | undefined {
  if (!sel.cfg.accounts.some((a) => a.credentialId === credentialId)) return "no account entry";
  if (sel.state.attempted.has(credentialId)) return "already attempted";
  if (!sel.ctx.authConfigured(credentialId)) return "not authenticated";
  if (!sel.ctx.allowed(credentialId)) return "restricted in this project";
  return undefined;
}

/**
 * Core member eligibility shared by the round-robin scan and the advanced
 * strategies: has an account entry, not attempted for this request, is
 * authenticated, and passes the project restriction. Cooldown and pool
 * membership are checked by the callers (membership is implied by the scan;
 * cooldown lives next to the call sites).
 */
export function isEligibleMember(credentialId: string, sel: SelectionContext): boolean {
  return eligibilityReason(credentialId, sel) === undefined;
}

/**
 * All eligible members of an enabled pool, in rotation order starting after
 * the pool's last-used index (wrapping once). Never mutates the pool.
 */
export function allEligibleMembers(pool: CodexPool, sel: SelectionContext): EligibleMember[] {
  if (!pool.enabled || pool.credentialIds.length === 0) return [];
  const members = pool.credentialIds;
  const n = members.length;
  const start = Math.min(Math.max(pool.lastUsedIndex, -1), n - 1);
  const result: EligibleMember[] = [];
  for (let step = 1; step <= n; step++) {
    const index = (start + step) % n;
    const credentialId = members[index];
    if (sel.state.attempted.has(credentialId)) continue;
    if (isCooldownActive(sel.state, credentialId, sel.now)) continue;
    if (!isEligibleMember(credentialId, sel)) continue;
    result.push({ credentialId, index });
  }
  return result;
}

/**
 * Pick the next eligible member of an enabled pool, scanning forward from the
 * pool's last-used index (wrapping once). The pool's `lastUsedIndex` is NOT
 * mutated — the caller persists the returned index.
 */
export function nextEligibleMember(pool: CodexPool, sel: SelectionContext): EligibleMember | undefined {
  return allEligibleMembers(pool, sel)[0];
}
