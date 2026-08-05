/**
 * Unit tests for advanced pool strategies: eligible-member scan, quota-first
 * (healthiest + round-robin fallback), scheduled (roles, windows, days, date
 * ranges), and custom selector ref validation.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  eligibleMembers,
  isScheduleActive,
  memberRoleOf,
  resolveCustomSelection,
  selectQuotaFirst,
  selectScheduled,
  WEEKDAYS,
  WEEKEND,
} from "./strategies.ts";
import { createRotationState, markCooldown, nextEligibleMember } from "./rotation.ts";
import type { AccountQuota } from "./quota.ts";
import type { AccountConfig, CodexAccount, CodexPool, PoolSchedule } from "./types.ts";

const NOW = Date.parse("2026-08-15T10:00:00Z");

function account(id: string): CodexAccount {
  return {
    id: `id-${id}`,
    provider: "openai-codex",
    credentialId: id,
    label: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function cfgWith(ids: string[]): AccountConfig {
  return { version: 1, accounts: ids.map(account) };
}

function pool(credentialIds: string[], extra: Partial<CodexPool> = {}): CodexPool {
  return {
    id: "pool-1",
    name: "prod",
    credentialIds,
    enabled: true,
    cooldownSeconds: 60,
    lastUsedIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function ctx(overrides: { auth?: Set<string>; allowed?: (id: string) => boolean } = {}) {
  const auth = overrides.auth;
  return {
    authConfigured: (id: string) => auth === undefined || auth.has(id),
    allowed: overrides.allowed ?? (() => true),
  };
}

function quota(health: number, status: AccountQuota["status"] = "healthy"): AccountQuota {
  return { status, health };
}

function quotaMap(entries: Array<[string, AccountQuota | undefined]>): (id: string) => AccountQuota | undefined {
  return (id) => entries.find(([k]) => k === id)?.[1];
}

const ids = ["openai-codex", "openai-codex-2", "openai-codex-3"];

describe("eligibleMembers", () => {
  test("returns all eligible members in rotation order after lastUsedIndex", () => {
    const members = eligibleMembers(pool(ids), cfgWith(ids), ctx(), createRotationState(), NOW);
    assert.deepEqual(members.map((m) => m.credentialId), ["openai-codex-2", "openai-codex-3", "openai-codex"]);
    assert.deepEqual(members.map((m) => m.index), [1, 2, 0]);
  });

  test("a fresh pool scans from the first member", () => {
    const members = eligibleMembers(pool(ids, { lastUsedIndex: -1 }), cfgWith(ids), ctx(), createRotationState(), NOW);
    assert.deepEqual(members.map((m) => m.credentialId), ids);
  });

  test("skips attempted, cooling, unauthenticated, restricted, and missing members", () => {
    const five = ["openai-codex", "openai-codex-2", "openai-codex-3", "openai-codex-4", "openai-codex-5"];
    const state = createRotationState();
    state.attempted.add("openai-codex-2");
    markCooldown(state, "openai-codex-3", 60, NOW);
    const members = eligibleMembers(
      pool([...five, "ghost"]),
      cfgWith(five),
      // authenticated set excludes -4; project restriction blocks -5
      ctx({ auth: new Set(five.filter((id) => id !== "openai-codex-4")), allowed: (id) => id !== "openai-codex-5" }),
      state,
      NOW,
    );
    assert.deepEqual(members.map((m) => m.credentialId), ["openai-codex"], "only the one eligible member remains");
  });

  test("disabled or empty pools yield nothing", () => {
    assert.deepEqual(eligibleMembers(pool(ids, { enabled: false }), cfgWith(ids), ctx(), createRotationState(), NOW), []);
    assert.deepEqual(eligibleMembers(pool([]), cfgWith(ids), ctx(), createRotationState(), NOW), []);
  });
});

describe("selectQuotaFirst", () => {
  test("picks the healthiest eligible account", () => {
    const pick = selectQuotaFirst(
      pool(ids),
      cfgWith(ids),
      ctx(),
      createRotationState(),
      quotaMap([["openai-codex", quota(20)], ["openai-codex-2", quota(80)], ["openai-codex-3", quota(50)]]),
      NOW,
    );
    assert.equal(pick?.credentialId, "openai-codex-2", "most headroom wins");
  });

  test("tie-breaks by rotation order", () => {
    const pick = selectQuotaFirst(
      pool(ids),
      cfgWith(ids),
      ctx(),
      createRotationState(),
      quotaMap([["openai-codex", quota(50)], ["openai-codex-2", quota(50)], ["openai-codex-3", quota(50)]]),
      NOW,
    );
    assert.equal(pick?.credentialId, "openai-codex-2", "first in rotation order among equals");
  });

  test("skips exhausted members while any data-bearing member exists", () => {
    const pick = selectQuotaFirst(
      pool(ids),
      cfgWith(ids),
      ctx(),
      createRotationState(),
      quotaMap([["openai-codex", quota(0, "exhausted")], ["openai-codex-2", quota(10)], ["openai-codex-3", undefined]]),
      NOW,
    );
    assert.equal(pick?.credentialId, "openai-codex-2");
  });

  test("falls back to round-robin when no member has quota data", () => {
    const state = createRotationState();
    const pick = selectQuotaFirst(pool(ids), cfgWith(ids), ctx(), state, () => undefined, NOW);
    const rr = nextEligibleMember(pool(ids), cfgWith(ids), ctx(), state, NOW);
    assert.deepEqual(pick, rr, "identical to the deterministic round-robin pick");
    assert.equal(pick?.credentialId, "openai-codex-2");
  });

  test("all-exhausted members fall back to round-robin", () => {
    const pick = selectQuotaFirst(
      pool(ids),
      cfgWith(ids),
      ctx(),
      createRotationState(),
      quotaMap(ids.map((id) => [id, quota(0, "exhausted")])),
      NOW,
    );
    assert.equal(pick?.credentialId, "openai-codex-2", "round-robin fallback still routes");
  });

  test("fallback prefers unknown-headroom members over known-exhausted ones", () => {
    const pick = selectQuotaFirst(
      pool(ids, { lastUsedIndex: -1 }),
      cfgWith(ids),
      ctx(),
      createRotationState(),
      quotaMap([["openai-codex", quota(0, "exhausted")], ["openai-codex-2", undefined], ["openai-codex-3", quota(0, "exhausted")]]),
      NOW,
    );
    assert.equal(
      pick?.credentialId,
      "openai-codex-2",
      "a member with unknown headroom beats an exhausted member earlier in rotation",
    );
  });

  test("respects project restrictions via the eligible set", () => {
    const pick = selectQuotaFirst(
      pool(ids),
      cfgWith(ids),
      ctx({ allowed: (id) => id !== "openai-codex-2" }),
      createRotationState(),
      quotaMap([["openai-codex", quota(90)], ["openai-codex-2", quota(10)], ["openai-codex-3", quota(50)]]),
      NOW,
    );
    assert.equal(pick?.credentialId, "openai-codex", "restricted healthiest member is never selected");
  });

  test("returns undefined when nothing is eligible", () => {
    const state = createRotationState();
    ids.forEach((id) => state.attempted.add(id));
    const pick = selectQuotaFirst(pool(ids), cfgWith(ids), ctx(), state, () => undefined, NOW);
    assert.equal(pick, undefined);
  });
});

describe("isScheduleActive", () => {
  const thursday = new Date(NOW); // 2026-08-15 is a Saturday; use a Thursday
  const thu = new Date(2026, 7, 13, 10, 0); // 2026-08-13 10:00, Thursday (day 4)

  test("undefined schedule is inactive", () => {
    assert.equal(isScheduleActive(undefined, thu), false);
  });

  test("empty schedule is active", () => {
    assert.equal(isScheduleActive({}, thu), true);
  });

  test("time window gates activity", () => {
    const schedule: PoolSchedule = { timeWindows: [{ start: "09:00", end: "17:00" }] };
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 10, 0)), true);
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 8, 59)), false);
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 17, 0)), true, "end inclusive");
  });

  test("overnight windows wrap past midnight", () => {
    const schedule: PoolSchedule = { timeWindows: [{ start: "22:00", end: "02:00" }] };
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 23, 30)), true);
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 14, 1, 0)), true);
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 12, 0)), false);
  });

  test("day filter gates activity", () => {
    const schedule: PoolSchedule = { days: WEEKDAYS };
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 10, 0)), true, "Thursday is a weekday");
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 15, 10, 0)), false, "Saturday is not");
    const weekendOnly: PoolSchedule = { days: WEEKEND };
    assert.equal(isScheduleActive(weekendOnly, new Date(2026, 7, 15, 10, 0)), true);
  });

  test("date range gates activity, end inclusive", () => {
    const schedule: PoolSchedule = { dateRange: { start: "2026-08-01", end: "2026-08-31" } };
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 10, 0)), true);
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 31, 23, 0)), true, "end date inclusive");
    assert.equal(isScheduleActive(schedule, new Date(2026, 8, 1, 0, 0)), false);
    assert.equal(isScheduleActive(schedule, new Date(2026, 6, 31, 23, 0)), false);
  });

  test("combined constraints all must hold", () => {
    const schedule: PoolSchedule = {
      days: WEEKDAYS,
      timeWindows: [{ start: "09:00", end: "17:00" }],
      dateRange: { start: "2026-08-01", end: "2026-08-31" },
    };
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 10, 0)), true);
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 13, 20, 0)), false, "outside window");
    assert.equal(isScheduleActive(schedule, new Date(2026, 7, 15, 10, 0)), false, "weekend");
  });
});

describe("selectScheduled", () => {
  const activeThu = new Date(2026, 7, 13, 10, 0); // Thursday
  const activeSchedule: PoolSchedule = { timeWindows: [{ start: "09:00", end: "17:00" }], days: WEEKDAYS };

  test("prefers eligible primary members over backups regardless of rotation order", () => {
    const schedule: PoolSchedule = {
      ...activeSchedule,
      memberRoles: { "openai-codex": "backup", "openai-codex-2": "backup", "openai-codex-3": "primary" },
    };
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), createRotationState(), schedule, activeThu);
    assert.equal(pick?.credentialId, "openai-codex-3", "backups first in rotation are skipped for the primary");
  });

  test("picks the first eligible primary in rotation order", () => {
    const schedule: PoolSchedule = { ...activeSchedule, memberRoles: { "openai-codex-3": "backup" } };
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), createRotationState(), schedule, activeThu);
    assert.equal(pick?.credentialId, "openai-codex-2", "first primary after lastUsedIndex");
  });

  test("falls back to backups when no primary is eligible", () => {
    const schedule: PoolSchedule = {
      ...activeSchedule,
      memberRoles: { "openai-codex": "primary", "openai-codex-2": "backup", "openai-codex-3": "backup" },
    };
    const state = createRotationState();
    state.attempted.add("openai-codex");
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), state, schedule, activeThu);
    assert.equal(pick?.credentialId, "openai-codex-2", "first eligible backup");
  });

  test("inactive schedule degrades to round-robin", () => {
    const saturday = new Date(2026, 7, 15, 10, 0); // Saturday, outside WEEKDAYS
    const state = createRotationState();
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), state, activeSchedule, saturday);
    const rr = nextEligibleMember(pool(ids), cfgWith(ids), ctx(), state, saturday.getTime());
    assert.deepEqual(pick, rr);
  });

  test("no roles configured degrades to round-robin order", () => {
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), createRotationState(), activeSchedule, activeThu);
    assert.equal(pick?.credentialId, "openai-codex-2");
  });

  test("no schedule means round-robin", () => {
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), createRotationState(), undefined, activeThu);
    assert.equal(pick?.credentialId, "openai-codex-2");
  });

  test("returns undefined when nothing is eligible", () => {
    const state = createRotationState();
    ids.forEach((id) => state.attempted.add(id));
    const pick = selectScheduled(pool(ids), cfgWith(ids), ctx(), state, activeSchedule, activeThu);
    assert.equal(pick, undefined);
  });
});

describe("memberRoleOf", () => {
  test("unlisted members are primary by default", () => {
    assert.equal(memberRoleOf(undefined, "openai-codex"), "primary");
    assert.equal(memberRoleOf({}, "openai-codex"), "primary");
  });
  test("explicit backup wins", () => {
    assert.equal(memberRoleOf({ memberRoles: { "openai-codex": "backup" } }, "openai-codex"), "backup");
  });
});

describe("resolveCustomSelection", () => {
  test("resolves an account ref to its eligible member", () => {
    const pick = resolveCustomSelection(pool(ids), cfgWith(ids), ctx(), createRotationState(), "openai-codex-2", NOW);
    assert.deepEqual(pick, { credentialId: "openai-codex-2", index: 1 });
  });

  test("accepts labels and ids as refs", () => {
    const cfg = cfgWith(ids);
    const byLabel = resolveCustomSelection(pool(ids), cfg, ctx(), createRotationState(), "openai-codex-3", NOW);
    const byId = resolveCustomSelection(pool(ids), cfg, ctx(), createRotationState(), "id-openai-codex-3", NOW);
    assert.equal(byLabel?.credentialId, "openai-codex-3");
    assert.equal(byId?.credentialId, "openai-codex-3");
  });

  test("empty or unknown refs yield undefined", () => {
    const cfg = cfgWith(ids);
    assert.equal(resolveCustomSelection(pool(ids), cfg, ctx(), createRotationState(), "", NOW), undefined);
    assert.equal(resolveCustomSelection(pool(ids), cfg, ctx(), createRotationState(), "nope", NOW), undefined);
    assert.equal(resolveCustomSelection(pool(ids), cfg, ctx(), createRotationState(), undefined, NOW), undefined);
  });

  test("a ref outside the pool yields undefined", () => {
    const cfg = cfgWith(ids);
    const pick = resolveCustomSelection(pool(["openai-codex"]), cfg, ctx(), createRotationState(), "openai-codex-2", NOW);
    assert.equal(pick, undefined);
  });

  test("an ineligible member (attempted, cooldown, restricted, unauthenticated) yields undefined", () => {
    const cfg = cfgWith(ids);
    const state = createRotationState();
    state.attempted.add("openai-codex-2");
    assert.equal(resolveCustomSelection(pool(ids), cfg, ctx(), state, "openai-codex-2", NOW), undefined, "attempted");
    const restricted = resolveCustomSelection(pool(ids), cfg, ctx({ allowed: () => false }), createRotationState(), "openai-codex-2", NOW);
    assert.equal(restricted, undefined, "project-restricted");
    const unauth = resolveCustomSelection(pool(ids), cfg, ctx({ auth: new Set(["openai-codex"]) }), createRotationState(), "openai-codex-2", NOW);
    assert.equal(unauth, undefined, "not authenticated");
    const cooling = resolveCustomSelection(pool(ids), cfg, ctx(), (() => { const s = createRotationState(); markCooldown(s, "openai-codex-2", 60, NOW); return s; })(), "openai-codex-2", NOW);
    assert.equal(cooling, undefined, "cooling down");
  });
});
