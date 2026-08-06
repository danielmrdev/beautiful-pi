/**
 * Advanced pool member selection: quota-first, scheduled, and custom.
 *
 * Pure logic with injectable state, mirroring rotation.ts. Every selector
 * degrades to deterministic round-robin (`nextEligibleMember`) when the
 * specialized data it needs is unavailable, so routing never breaks on a
 * missing credential, network failure, malformed response, or bad schedule.
 *
 * `eligibleMembers` is the shared primitive: all pool members that pass the
 * rotation eligibility checks (account entry, not attempted, not cooling
 * down, authenticated, project-allowed), scanned in rotation order starting
 * after the pool's last-used index.
 */
import type { CodexPool, PoolSchedule } from "./types.ts";
import {
  allEligibleMembers,
  isCooldownActive,
  isEligibleMember,
  nextEligibleMember,
  type EligibleMember,
  type SelectionContext,
} from "./rotation.ts";
import { WEEKDAYS, WEEKEND, isScheduleActive, memberRoleOf } from "./schedule.ts";
import type { AccountQuota } from "./quota.ts";

// Re-export the shared schedule logic so the CLI and tests keep one import
// site (the canonical definitions live in schedule.ts).
export { WEEKDAYS, WEEKEND, isScheduleActive, memberRoleOf };

/**
 * All eligible pool members in rotation order (shared scan from rotation.ts;
 * the advanced selectors consume the full list, round-robin takes the first).
 */
const eligibleMembers = allEligibleMembers;
export { eligibleMembers };

// ── quota-first ──────────────────────────────────────────────────────────────

/**
 * Pick the healthiest eligible account (most remaining headroom across its
 * usage windows, tie-broken by rotation order). Exhausted members are not
 * selectable while any other data-bearing member exists. When no usable quota
 * data remains, falls back to round-robin — but known-exhausted members are
 * deprioritized below members whose headroom is unknown, so the fallback never
 * serves a known-exhausted account while an alternative exists.
 *
 * `members` may be precomputed by the caller (e.g. the command layer that
 * already scanned for the quota fetches); it defaults to a fresh scan so the
 * selector stays usable standalone.
 */
export function selectQuotaFirst(
  pool: CodexPool,
  sel: SelectionContext,
  quotaOf: (credentialId: string) => AccountQuota | undefined,
  members: EligibleMember[] = eligibleMembers(pool, sel),
): EligibleMember | undefined {
  if (members.length === 0) return undefined;
  const candidates = members
    .map((m) => ({ m, quota: quotaOf(m.credentialId) }))
    .filter((x): x is { m: EligibleMember; quota: AccountQuota } =>
      x.quota !== undefined && x.quota.status !== "exhausted"
    );
  if (candidates.length > 0) {
    let best = candidates[0];
    for (const candidate of candidates) {
      const score = candidate.quota.health ?? -1;
      const bestScore = best.quota.health ?? -1;
      // Strictly-better score replaces; ties keep the earlier rotation-order
      // candidate (candidates are already in rotation order).
      if (score > bestScore) best = candidate;
    }
    return best.m;
  }
  // No non-exhausted data-bearing member: prefer members whose headroom is
  // unknown over known-exhausted ones, then plain round-robin.
  const unknownHeadroom = members.find((m) => quotaOf(m.credentialId) === undefined);
  if (unknownHeadroom) return unknownHeadroom;
  return nextEligibleMember(pool, sel);
}

// ── scheduled ────────────────────────────────────────────────────────────────

/**
 * Scheduled selection: when the schedule is active, prefer eligible primary
 * members (rotation order), then eligible backups; round-robin otherwise
 * (inactive schedule or no roles configured). Every member has a role
 * (unlisted members default to primary), so one of the two role filters is
 * always non-empty once eligibility passed.
 */
export function selectScheduled(
  pool: CodexPool,
  sel: SelectionContext,
  schedule: PoolSchedule | undefined,
  members?: EligibleMember[],
): EligibleMember | undefined {
  const now = new Date(sel.now);
  if (!isScheduleActive(schedule, now)) {
    return (members ?? eligibleMembers(pool, sel))[0];
  }
  const list = members ?? eligibleMembers(pool, sel);
  if (list.length === 0) return undefined;
  const primaries = list.filter((m) => memberRoleOf(schedule, m.credentialId) === "primary");
  if (primaries.length > 0) return primaries[0];
  return list.find((m) => memberRoleOf(schedule, m.credentialId) === "backup");
}

// ── custom ───────────────────────────────────────────────────────────────────

/**
 * Validate a custom selector's output ref against the pool. The ref may be an
 * account id, credential id, or label. Returns the eligible member, or
 * undefined when the ref is empty, unknown, not a pool member, or fails the
 * rotation eligibility checks — the caller then falls back to round-robin.
 */
export function resolveCustomSelection(
  pool: CodexPool,
  sel: SelectionContext,
  ref: string | undefined,
): EligibleMember | undefined {
  if (!ref) return undefined;
  const account = sel.cfg.accounts.find(
    (a) => a.id === ref.trim() || a.credentialId === ref.trim() || a.label === ref.trim(),
  );
  if (!account) return undefined;
  const index = pool.credentialIds.indexOf(account.credentialId);
  if (index < 0) return undefined;
  if (isCooldownActive(sel.state, account.credentialId, sel.now)) return undefined;
  if (!isEligibleMember(account.credentialId, sel)) return undefined;
  return { credentialId: account.credentialId, index };
}
