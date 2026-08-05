/**
 * Unit tests for ordered chain traversal: target resolution, skipping
 * disabled/unauthenticated/restricted/exhausted entries, round-robin advance
 * within pool targets, and chain-progress-preserving retry replay.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createRotationState,
  markCooldown,
} from "./rotation.ts";
import { nextChainMember, chainTargetStatus } from "./chain.ts";
import type { AccountConfig, ChainTarget, CodexAccount, CodexChain, CodexPool } from "./types.ts";

const NOW = 1_000_000;

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

function pool(id: string, name: string, credentialIds: string[], extra: Partial<CodexPool> = {}): CodexPool {
  return {
    id,
    name,
    credentialIds,
    enabled: true,
    cooldownSeconds: 60,
    lastUsedIndex: -1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function chain(targets: ChainTarget[], extra: Partial<CodexChain> = {}): CodexChain {
  return {
    id: "chain-1",
    name: "primary",
    enabled: true,
    targets,
    lastUsedTargetIndex: -1,
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

describe("nextChainMember", () => {
  test("walks targets in order and returns the first eligible member", () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2", "openai-codex-3"]);
    const pools = [
      pool("p1", "prod", ["openai-codex", "openai-codex-2"]),
      pool("p2", "dev", ["openai-codex-3"]),
    ];
    const cfgWithPools: AccountConfig = { ...cfg, pools };
    const c = chain([
      { kind: "pool", poolId: "p1" },
      { kind: "account", credentialId: "openai-codex-3" },
    ]);
    const walk = nextChainMember(c, cfgWithPools, ctx(), createRotationState(), NOW);
    assert.equal(walk?.member.credentialId, "openai-codex", "first member of first pool");
    assert.equal(walk?.pool?.id, "p1");
    assert.equal(walk?.targetIndex, 0);
    assert.deepEqual(walk?.skipped, []);
  });

  test("skips a disabled pool target and falls to the next", () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"]);
    const pools = [
      pool("p1", "prod", ["openai-codex"], { enabled: false }),
      pool("p2", "dev", ["openai-codex-2"]),
    ];
    const c = chain([
      { kind: "pool", poolId: "p1" },
      { kind: "pool", poolId: "p2" },
    ]);
    const walk = nextChainMember(c, { ...cfg, pools }, ctx(), createRotationState(), NOW);
    assert.equal(walk?.member.credentialId, "openai-codex-2");
    assert.equal(walk?.targetIndex, 1);
    assert.ok(walk?.skipped[0].includes("disabled"));
  });

  test("skips unauthenticated and restricted members with reasons", () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"]);
    const pools = [
      pool("p1", "prod", ["openai-codex", "openai-codex-2"]),
    ];
    const c = chain([{ kind: "pool", poolId: "p1" }]);
    // openai-codex unauthenticated -> skipped, openai-codex-2 eligible.
    const walk = nextChainMember(
      c,
      { ...cfg, pools },
      ctx({ auth: new Set(["openai-codex-2"]) }),
      createRotationState(),
      NOW,
    );
    assert.equal(walk?.member.credentialId, "openai-codex-2", "unauth member skipped");
    // Now also restrict openai-codex-2: no member left.
    const restricted = (id: string) => id !== "openai-codex-2";
    const noWalk = nextChainMember(
      c,
      { ...cfg, pools },
      ctx({ auth: new Set(["openai-codex-2"]), allowed: restricted }),
      createRotationState(),
      NOW,
    );
    assert.equal(noWalk, undefined, "all members unavailable -> no member");
  });

  test("cooled-down member is skipped, chain still resolves", () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"]);
    const pools = [pool("p1", "prod", ["openai-codex", "openai-codex-2"])];
    const state = createRotationState();
    markCooldown(state, "openai-codex", 60, NOW);
    const walk = nextChainMember(
      chain([{ kind: "pool", poolId: "p1" }]),
      { ...cfg, pools },
      ctx(),
      state,
      NOW,
    );
    assert.equal(walk?.member.credentialId, "openai-codex-2");
  });

  test("account targets are used directly when eligible", () => {
    const cfg = cfgWith(["openai-codex-2"]);
    const c = chain([{ kind: "account", credentialId: "openai-codex-2" }]);
    const walk = nextChainMember(c, cfg, ctx(), createRotationState(), NOW);
    assert.equal(walk?.member.credentialId, "openai-codex-2");
    assert.equal(walk?.pool, undefined);
    assert.equal(walk?.member.index, -1, "no pool pointer for account targets");
  });

  test("replay continues from the last used target and never revisits attempts", () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2", "openai-codex-3"]);
    const pools = [
      pool("p1", "prod", ["openai-codex", "openai-codex-2"]),
      pool("p2", "dev", ["openai-codex-3"]),
    ];
    const state = createRotationState();
    state.attempted.add("openai-codex");
    // First use picked target 0 (openai-codex); it failed and is attempted.
    const c = chain(
      [{ kind: "pool", poolId: "p1" }, { kind: "pool", poolId: "p2" }],
      { lastUsedTargetIndex: 0 },
    );
    const walk = nextChainMember(c, { ...cfg, pools }, ctx(), state, NOW);
    assert.equal(walk?.member.credentialId, "openai-codex-2", "rotates past failed member in same pool");
    assert.equal(walk?.targetIndex, 0, "chain progress stays on the failed target's pool first");
    state.attempted.add("openai-codex-2");
    const second = nextChainMember(c, { ...cfg, pools }, ctx(), state, NOW);
    assert.equal(second?.member.credentialId, "openai-codex-3", "pool exhausted -> next target");
    assert.equal(second?.targetIndex, 1);
  });

  test("disabled chain yields no member", () => {
    const cfg = cfgWith(["openai-codex"]);
    const c = chain([{ kind: "account", credentialId: "openai-codex" }], { enabled: false });
    assert.equal(nextChainMember(c, cfg, ctx(), createRotationState(), NOW), undefined);
  });

  test("missing pool target is skipped with a reason", () => {
    const cfg = cfgWith(["openai-codex"]);
    const c = chain([{ kind: "pool", poolId: "ghost" }]);
    const walk = nextChainMember(c, cfg, ctx(), createRotationState(), NOW);
    assert.equal(walk, undefined);
    assert.equal(chainTargetStatus({ kind: "pool", poolId: "ghost" }, cfg, ctx(), createRotationState(), NOW), "pool ghost: not found");
  });
});

describe("chainTargetStatus", () => {
  test("reports eligibility per target", () => {
    const cfg = cfgWith(["openai-codex"]);
    const pools = [pool("p1", "prod", ["openai-codex"])];
    const state = createRotationState();
    const c = ctx();
    assert.equal(chainTargetStatus({ kind: "account", credentialId: "openai-codex" }, cfg, c, state, NOW), "account openai-codex: eligible");
    assert.equal(
      chainTargetStatus({ kind: "account", credentialId: "openai-codex" }, cfg, ctx({ auth: new Set() }), state, NOW),
      "account openai-codex: not authenticated",
    );
    assert.equal(
      chainTargetStatus({ kind: "pool", poolId: "p1" }, { ...cfg, pools }, c, state, NOW),
      "pool prod: eligible",
    );
    markCooldown(state, "openai-codex", 60, NOW);
    assert.ok(
      chainTargetStatus({ kind: "pool", poolId: "p1" }, { ...cfg, pools }, c, state, NOW).includes("no eligible member"),
    );
  });
});
