/**
 * Unit tests for pool rotation: member eligibility (attempted set, cooldowns,
 * auth, project restriction) and round-robin advance/wrap/exhaustion.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createRotationState,
  markCooldown,
  isCooldownActive,
  nextEligibleMember,
} from "./rotation.ts";
import { sel } from "../test-helpers.ts";
import type { AccountConfig, CodexAccount, CodexPool } from "./types.ts";

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

/** Default context: everything allowed and authenticated. */
function ctx(overrides: { auth?: Set<string>; allowed?: (id: string) => boolean } = {}) {
  const auth = overrides.auth;
  return {
    authConfigured: (id: string) => auth === undefined || auth.has(id),
    allowed: overrides.allowed ?? (() => true),
  };
}

describe("eligibility", () => {
  test("an account already attempted for this request is not eligible", () => {
    const state = createRotationState();
    state.attempted.add("openai-codex");
    const pick = nextEligibleMember(pool(["openai-codex", "openai-codex-2"]), sel(cfgWith(["openai-codex", "openai-codex-2"]), ctx(), state, NOW));
    assert.equal(pick?.credentialId, "openai-codex-2");
  });

  test("an account in cooldown is not eligible", () => {
    const state = createRotationState();
    markCooldown(state, "openai-codex-2", 60, NOW);
    const pick = nextEligibleMember(pool(["openai-codex-2", "openai-codex"]), sel(cfgWith(["openai-codex-2", "openai-codex"]), ctx(), state, NOW));
    assert.equal(pick?.credentialId, "openai-codex");
  });

  test("cooldown expires and the account becomes eligible again", () => {
    const state = createRotationState();
    markCooldown(state, "openai-codex", 60, NOW);
    assert.equal(isCooldownActive(state, "openai-codex", NOW + 30_000), true);
    assert.equal(isCooldownActive(state, "openai-codex", NOW + 60_000), false);
    const pick = nextEligibleMember(pool(["openai-codex"]), sel(cfgWith(["openai-codex"]), ctx(), state, NOW + 61_000));
    assert.equal(pick?.credentialId, "openai-codex");
  });

  test("unauthenticated members are skipped", () => {
    const pick = nextEligibleMember(
      pool(["openai-codex", "openai-codex-2"]),
      sel(
        cfgWith(["openai-codex", "openai-codex-2"]),
        ctx({ auth: new Set(["openai-codex"]) }),
        createRotationState(),
        NOW,
      ),
    );
    assert.equal(pick?.credentialId, "openai-codex");
  });

  test("project-restricted members are skipped", () => {
    const pick = nextEligibleMember(
      pool(["openai-codex", "openai-codex-2"]),
      sel(
        cfgWith(["openai-codex", "openai-codex-2"]),
        ctx({ allowed: (id) => id !== "openai-codex" }),
        createRotationState(),
        NOW,
      ),
    );
    assert.equal(pick?.credentialId, "openai-codex-2");
  });

  test("members without an account entry are skipped", () => {
    const pick = nextEligibleMember(
      pool(["openai-codex", "ghost"]),
      sel(cfgWith(["openai-codex"]), ctx(), createRotationState(), NOW),
    );
    assert.equal(pick?.credentialId, "openai-codex");
  });
});

describe("round-robin", () => {
  test("advances past the last-used index and wraps around", () => {
    const cfg = cfgWith(["a", "b", "c"].map((x) => `openai-codex-${x}`));
    const ids = cfg.accounts.map((a) => a.credentialId);
    const state = createRotationState();

    const first = nextEligibleMember(pool(ids, { lastUsedIndex: 0 }), sel(cfg, ctx(), state, NOW));
    assert.equal(first?.credentialId, ids[1], "starts after lastUsedIndex");
    const second = nextEligibleMember(pool(ids, { lastUsedIndex: first!.index }), sel(cfg, ctx(), state, NOW));
    assert.equal(second?.credentialId, ids[2]);
    const third = nextEligibleMember(pool(ids, { lastUsedIndex: second!.index }), sel(cfg, ctx(), state, NOW));
    assert.equal(third?.credentialId, ids[0], "wraps to the start");
  });

  test("a fresh pool (no last used) starts with the first member", () => {
    const cfg = cfgWith(["a", "b"].map((x) => `openai-codex-${x}`));
    const ids = cfg.accounts.map((a) => a.credentialId);
    const pick = nextEligibleMember(pool(ids, { lastUsedIndex: -1 }), sel(cfg, ctx(), createRotationState(), NOW));
    assert.equal(pick?.credentialId, ids[0]);
    assert.equal(pick?.index, 0);
  });

  test("skips ineligible members during the scan", () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2", "openai-codex-3"]);
    const state = createRotationState();
    markCooldown(state, "openai-codex-2", 60, NOW);
    const pick = nextEligibleMember(pool(["openai-codex", "openai-codex-2", "openai-codex-3"]), sel(cfg, ctx(), state, NOW));
    assert.equal(pick?.credentialId, "openai-codex-3", "skips the cooled-down member");
  });

  test("returns undefined when every member is exhausted", () => {
    const state = createRotationState();
    state.attempted.add("openai-codex");
    state.attempted.add("openai-codex-2");
    const pick = nextEligibleMember(pool(["openai-codex", "openai-codex-2"]), sel(cfgWith(["openai-codex", "openai-codex-2"]), ctx(), state, NOW));
    assert.equal(pick, undefined);
  });

  test("disabled pools yield nothing", () => {
    const pick = nextEligibleMember(
      pool(["openai-codex"], { enabled: false }),
      sel(cfgWith(["openai-codex"]), ctx(), createRotationState(), NOW),
    );
    assert.equal(pick, undefined);
  });

  test("empty pools yield nothing", () => {
    const pick = nextEligibleMember(pool([]), sel(cfgWith(["openai-codex"]), ctx(), createRotationState(), NOW));
    assert.equal(pick, undefined);
  });

  test("single-member pool picks the member when eligible", () => {
    const pick = nextEligibleMember(pool(["openai-codex"]), sel(cfgWith(["openai-codex"]), ctx(), createRotationState(), NOW));
    assert.equal(pick?.credentialId, "openai-codex");
  });
});
