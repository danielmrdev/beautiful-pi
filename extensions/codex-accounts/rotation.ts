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

// Shared singleton: cooldowns persist across commands and failovers; the
// attempted set is reset per request via beginOrContinueRequest.

let sharedState: RotationState = createRotationState();

export function getSharedRotationState(): RotationState {
  return sharedState;
}

export function resetSharedRotationState(): void {
  sharedState = createRotationState();
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

export interface EligibleMember {
  credentialId: string;
  /** Index into the pool's credentialIds (the new round-robin pointer). */
  index: number;
}

/**
 * Pick the next eligible member of an enabled pool, scanning forward from the
 * pool's last-used index (wrapping once). A member is eligible when it has an
 * account entry, is not already attempted for this request, is not cooling
 * down, is authenticated, and passes the project restriction. The pool's
 * `lastUsedIndex` is NOT mutated — the caller persists the returned index.
 */
export function nextEligibleMember(
  pool: CodexPool,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): EligibleMember | undefined {
  if (!pool.enabled || pool.credentialIds.length === 0) return undefined;
  const members = pool.credentialIds;
  const n = members.length;
  const start = Math.min(Math.max(pool.lastUsedIndex, -1), n - 1);
  for (let step = 1; step <= n; step++) {
    const index = (start + step) % n;
    const credentialId = members[index];
    if (state.attempted.has(credentialId)) continue;
    if (isCooldownActive(state, credentialId, now)) continue;
    if (!cfg.accounts.some((a) => a.credentialId === credentialId)) continue;
    if (!ctx.authConfigured(credentialId)) continue;
    if (!ctx.allowed(credentialId)) continue;
    return { credentialId, index };
  }
  return undefined;
}
