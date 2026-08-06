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
  type MemberUnavailableReason,
  type SelectionContext,
} from "./rotation.ts";
import { resolvePoolById } from "./store.ts";

export interface ChainWalkResult {
  member: EligibleMember;
  /** Present when the member came from a pool target (persist its pointer). */
  pool?: CodexPool;
  /** Index of the chain target that produced the member. */
  targetIndex: number;
  /** Short status per skipped target (for inspection / warnings). */
  skipped: string[];
}

/**
 * How a pool target picks its member during a chain walk. The sync replay
 * picker is `nextEligibleMember`; `/codex chain use` injects the pool's own
 * strategy-aware selection (quota-first/scheduled/custom/round-robin).
 */
export type PoolMemberPicker = (
  pool: CodexPool,
  sel: SelectionContext,
) => EligibleMember | undefined | Promise<EligibleMember | undefined>;

/** Chain-layer reason: the shared ones plus cooldown. */
export type ChainMemberUnavailableReason = MemberUnavailableReason | "cooling down";

/**
 * Why a single credential cannot be used right now; undefined when usable.
 * Non-cooldown reasons come from the shared eligibility predicate; cooldown
 * is the chain layer's own addition (a cooling member is exhausted for now).
 */
export function memberUnavailableReason(
  credentialId: string,
  sel: SelectionContext,
): ChainMemberUnavailableReason | undefined {
  const reason = eligibilityReason(credentialId, sel);
  if (reason) return reason;
  if (isCooldownActive(sel.state, credentialId, sel.now)) return "cooling down";
  return undefined;
}

/** One-line eligibility status of a chain target. */
export function chainTargetStatus(target: ChainTarget, sel: SelectionContext): string {
  if (target.kind === "account") {
    const reason = memberUnavailableReason(target.credentialId, sel);
    return `account ${target.credentialId}${reason ? `: ${reason}` : ": eligible"}`;
  }
  const pool = resolvePoolById(sel.cfg, target.poolId);
  if (!pool) return `pool ${target.poolId}: not found`;
  if (!pool.enabled) return `pool ${pool.name}: disabled`;
  if (pool.credentialIds.length === 0) return `pool ${pool.name}: no members`;
  if (allEligibleMembers(pool, sel).length > 0) {
    // Quota-first pools live-check exhaustion at use time; the status line
    // cannot see the network, so it says so instead of claiming "eligible".
    const note =
      pool.strategy === "quota-first"
        ? " (strategy: quota-first — live quota check on use)"
        : "";
    return `pool ${pool.name}: eligible${note}`;
  }
  const reasons = pool.credentialIds
    .map((id) => memberUnavailableReason(id, sel))
    .filter((r): r is ChainMemberUnavailableReason => r !== undefined);
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

/**
 * Walk a chain from its last-used target (or the first target on a fresh
 * chain) and return the first eligible member, picking each pool target's
 * member through `pick`. Pool targets rotate past previously used/attempted
 * members before the walk moves to the next target, so retry replay keeps
 * chain progress and never revisits a failed target. Never mutates the
 * chain or the pools.
 */
export async function walkChain(
  chain: CodexChain,
  sel: SelectionContext,
  pick: PoolMemberPicker,
): Promise<ChainWalkResult | undefined> {
  if (!chain.enabled) return undefined;
  const targets = chain.targets;
  if (targets.length === 0) return undefined;
  const start = Math.min(Math.max(chain.lastUsedTargetIndex, 0), targets.length - 1);
  const skipped: string[] = [];
  for (let i = start; i < targets.length; i++) {
    const target = targets[i];
    if (target.kind === "pool") {
      const pool = resolvePoolById(sel.cfg, target.poolId);
      if (!pool || !pool.enabled || pool.credentialIds.length === 0) {
        skipped.push(chainTargetStatus(target, sel));
        continue;
      }
      const member = await pick(pool, sel);
      if (!member) {
        skipped.push(chainTargetStatus(target, sel));
        continue;
      }
      return { member, pool, targetIndex: i, skipped };
    }
    if (memberUnavailableReason(target.credentialId, sel)) {
      skipped.push(chainTargetStatus(target, sel));
      continue;
    }
    return { member: { credentialId: target.credentialId, index: -1 }, targetIndex: i, skipped };
  }
  return undefined;
}

/**
 * Failover replay walk: deterministic round-robin per pool target (fast,
 * latency-critical; the #5 decision that rate-limit failover stays
 * round-robin is preserved). The strategy-aware variant lives in commands.ts
 * and injects `selectForStrategy` as the picker.
 */
export function nextChainMember(
  chain: CodexChain,
  sel: SelectionContext,
): Promise<ChainWalkResult | undefined> {
  return walkChain(chain, sel, nextEligibleMember);
}
