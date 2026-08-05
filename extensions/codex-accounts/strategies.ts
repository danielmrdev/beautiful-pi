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
import type { AccountConfig, CodexPool, PoolSchedule } from "./types.ts";
import {
  allEligibleMembers,
  isCooldownActive,
  isEligibleMember,
  nextEligibleMember,
  type EligibleMember,
  type RotationContext,
  type RotationState,
} from "./rotation.ts";
import type { AccountQuota } from "./quota.ts";

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
 */
export function selectQuotaFirst(
  pool: CodexPool,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  quotaOf: (credentialId: string) => AccountQuota | undefined,
  now: number = Date.now(),
): EligibleMember | undefined {
  const members = eligibleMembers(pool, cfg, ctx, state, now);
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
  return nextEligibleMember(pool, cfg, ctx, state, now);
}

// ── scheduled ────────────────────────────────────────────────────────────────

/** Day-of-week constants for schedule parsing (0=Sunday..6=Saturday). */
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [0, 6];

function parseTime(hhmm: string): number | undefined {
  // Strict zero-padded HH:MM, matching the stored schedule schema (store.ts).
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * True when the schedule's constraints hold for `now` (empty/absent = active).
 * Date range is inclusive; an overnight time window (start > end) wraps past
 * midnight.
 */
export function isScheduleActive(schedule: PoolSchedule | undefined, now: Date): boolean {
  if (!schedule) return false;
  const { dateRange, days, timeWindows } = schedule;
  const nowMs = now.getTime();
  if (dateRange?.start) {
    const startMs = Date.parse(`${dateRange.start}T00:00:00`);
    if (!Number.isNaN(startMs) && nowMs < startMs) return false;
  }
  if (dateRange?.end) {
    // end date is inclusive: compare against end-of-day
    const endMs = Date.parse(`${dateRange.end}T23:59:59.999`);
    if (!Number.isNaN(endMs) && nowMs > endMs) return false;
  }
  if (days && days.length > 0 && !days.includes(now.getDay())) return false;
  if (timeWindows && timeWindows.length > 0) {
    const t = now.getHours() * 60 + now.getMinutes();
    const hit = timeWindows.some((w) => {
      const start = parseTime(w.start);
      const end = parseTime(w.end);
      if (start === undefined || end === undefined) return false;
      if (start <= end) return t >= start && t <= end;
      return t >= start || t <= end;
    });
    if (!hit) return false;
  }
  return true;
}

/** Role of a member: members not listed in `memberRoles` act as primary. */
export function memberRoleOf(
  schedule: PoolSchedule | undefined,
  credentialId: string,
): "primary" | "backup" {
  return schedule?.memberRoles?.[credentialId] ?? "primary";
}

/**
 * Scheduled selection: when the schedule is active, prefer eligible primary
 * members (rotation order), then eligible backups; round-robin otherwise
 * (inactive schedule or no roles configured).
 */
export function selectScheduled(
  pool: CodexPool,
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  schedule: PoolSchedule | undefined,
  now: Date,
): EligibleMember | undefined {
  if (!isScheduleActive(schedule, now)) return nextEligibleMember(pool, cfg, ctx, state, now.getTime());
  const members = eligibleMembers(pool, cfg, ctx, state, now.getTime());
  if (members.length === 0) return undefined;
  const primaries = members.filter((m) => memberRoleOf(schedule, m.credentialId) === "primary");
  if (primaries.length > 0) return primaries[0];
  const backups = members.filter((m) => memberRoleOf(schedule, m.credentialId) === "backup");
  if (backups.length > 0) return backups[0];
  return nextEligibleMember(pool, cfg, ctx, state, now.getTime());
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
  cfg: AccountConfig,
  ctx: RotationContext,
  state: RotationState,
  ref: string | undefined,
  now: number = Date.now(),
): EligibleMember | undefined {
  if (!ref) return undefined;
  const account = cfg.accounts.find(
    (a) => a.id === ref.trim() || a.credentialId === ref.trim() || a.label === ref.trim(),
  );
  if (!account) return undefined;
  const index = pool.credentialIds.indexOf(account.credentialId);
  if (index < 0) return undefined;
  if (isCooldownActive(state, account.credentialId, now)) return undefined;
  if (!isEligibleMember(account.credentialId, cfg, ctx, state)) return undefined;
  return { credentialId: account.credentialId, index };
}
