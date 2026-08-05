/**
 * Ordered fallback chain traversal.
 *
 * Pure logic with injectable state, mirroring rotation.ts: chains walk their
 * targets in order, pool targets rotate round-robin through the pool's own
 * members (the attempted set + cooldowns guarantee a failed member is never
 * revisited), and account targets are used directly. Disabled, missing,
 * unauthenticated, restricted, and exhausted entries are skipped with a
 * status reason — the walk never breaks on one bad target.
 */
import type { AccountConfig, ChainTarget, CodexChain, CodexPool } from "./types.ts";
import {
  allEligibleMembers,
  eligibilityReason,
  isCooldownActive,
  nextEligibleMember,
  type EligibleMember,
  type RotationContext,
  type RotationState,
} from "./rotation.ts";

export interface ChainWalkResult {
  member: EligibleMember;
  /** Present when the member came from a pool target (persist its pointer). */
  pool?: CodexPool;
  /** Index of the chain target that produced the member. */
  targetIndex: number;
  /** Short status per skipped target (for inspection / warnings). */
  skipped: string[];
}

function poolById(cfg: AccountConfig, poolId: string): CodexPool | undefined {
  return (cfg.pools ?? []).find((p) => p.id === poolId);
}

/**
 * Why a single credential cannot be used right now; undefined when usable.
 * Non-cooldown reasons come from the shared eligibility predicate; cooldown
 * is the chain layer's own addition (a cooling member is exhausted for now).
 */
export function memberUnavailableReason(
  credentialId: string,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): string | undefined {
  const reason = eligibilityReason(credentialId, cfg, ctx, state);
  if (reason) return reason;
  if (isCooldownActive(state, credentialId, now)) return "cooling down";
  return undefined;
}

/** One-line eligibility status of a chain target. */
export function chainTargetStatus(
  target: ChainTarget,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): string {
  if (target.kind === "account") {
    const reason = memberUnavailableReason(target.credentialId, cfg, ctx, state, now);
    return `account ${target.credentialId}${reason ? `: ${reason}` : ": eligible"}`;
  }
  const pool = poolById(cfg, target.poolId);
  if (!pool) return `pool ${target.poolId}: not found`;
  if (!pool.enabled) return `pool ${pool.name}: disabled`;
  if (pool.credentialIds.length === 0) return `pool ${pool.name}: no members`;
  if (allEligibleMembers(pool, cfg, ctx, state, now).length > 0) return `pool ${pool.name}: eligible`;
  const reasons = pool.credentialIds
    .map((id) => memberUnavailableReason(id, cfg, ctx, state, now))
    .filter((r): r is string => r !== undefined);
  const summary = [...new Set(reasons)].join(", ");
  return `pool ${pool.name}: no eligible member${summary ? ` (${summary})` : ""}`;
}

/**
 * The first enabled chain (config order) whose targets reference the given
 * credential — either directly as an account target or via a pool target.
 */
export function chainContainingCredential(
  cfg: AccountConfig,
  credentialId: string,
): CodexChain | undefined {
  return (cfg.chains ?? []).find((c) =>
    c.enabled &&
    c.targets.some((t) =>
      t.kind === "account"
        ? t.credentialId === credentialId
        : (cfg.pools ?? []).some((p) => p.id === t.poolId && p.credentialIds.includes(credentialId))
    )
  );
}

/** The pool target of the chain that contains the credential (for cooldown). */
export function chainPoolForCredential(
  cfg: AccountConfig,
  chain: CodexChain,
  credentialId: string,
): CodexPool | undefined {
  return (cfg.pools ?? []).find(
    (p) =>
      p.credentialIds.includes(credentialId) &&
      chain.targets.some((t) => t.kind === "pool" && t.poolId === p.id),
  );
}

/** Walk a chain from its last-used target (or the first target on a fresh
 * chain) and return the first eligible member. A pool target rotates
 * round-robin past previously used/attempted members before the walk moves to
 * the next target, so retry replay keeps chain progress and never revisits a
 * failed target. Never mutates the chain or the pools.
 */
export function nextChainMember(
  chain: CodexChain,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  now: number = Date.now(),
): ChainWalkResult | undefined {
  if (!chain.enabled) return undefined;
  const targets = chain.targets;
  if (targets.length === 0) return undefined;
  const start = Math.min(Math.max(chain.lastUsedTargetIndex, 0), targets.length - 1);
  const skipped: string[] = [];
  for (let i = start; i < targets.length; i++) {
    const target = targets[i];
    if (target.kind === "pool") {
      const pool = poolById(cfg, target.poolId);
      if (!pool || !pool.enabled || pool.credentialIds.length === 0) {
        skipped.push(chainTargetStatus(target, cfg, ctx, state, now));
        continue;
      }
      const member = nextEligibleMember(pool, cfg, ctx, state, now);
      if (!member) {
        skipped.push(chainTargetStatus(target, cfg, ctx, state, now));
        continue;
      }
      return { member, pool, targetIndex: i, skipped };
    }
    if (memberUnavailableReason(target.credentialId, cfg, ctx, state, now)) {
      skipped.push(chainTargetStatus(target, cfg, ctx, state, now));
      continue;
    }
    return { member: { credentialId: target.credentialId, index: -1 }, targetIndex: i, skipped };
  }
  return undefined;
}
