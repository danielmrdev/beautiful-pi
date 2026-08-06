/**
 * Unit tests for rate-limit failover: error classification, run extraction,
 * the failover decision (replay accumulation, cooldowns, exhaustion) and the
 * action taken on a retry decision.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isCodexRateLimitError,
  extractRunInfo,
  decideFailover,
  actOnFailover,
  wireFailover,
} from "./failover.ts";
import { createRotationState, markCooldown } from "./rotation.ts";
import { loadGlobalAccountConfig, resolveEffectiveConfig } from "./store.ts";
import { fakePi, sel } from "../test-helpers.ts";
import type { AccountConfig, CodexAccount, CodexPool } from "./types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOW = 1_000_000_000_000;

let tmpHome: string;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-failover-test-"));
  process.env["HOME"] = tmpHome;
});

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // The wireFailover /reload guard is a process-global symbol; clear it so
  // each wiring test registers its own handlers.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("beautiful-pi:codex-failover-wired")];
});

function account(id: string): CodexAccount {
  return {
    id: `id-${id}`,
    provider: "openai-codex",
    credentialId: id,
    label: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function cfgWith(ids: string[], pools: CodexPool[] = []): AccountConfig {
  return { version: 1, accounts: ids.map(account), pools };
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

function ctx() {
  return { authConfigured: () => true, allowed: () => true };
}

describe("isCodexRateLimitError", () => {
  const hits = [
    "Error: 429 Too Many Requests",
    "Rate limit reached for openai-codex",
    "rate-limit exceeded, retry in 30s",
    "You've exceeded your current quota, please check your plan",
    "Your quota has been exceeded",
    "too many requests",
  ];
  for (const msg of hits) {
    test(`matches: ${msg.slice(0, 40)}`, () => {
      assert.equal(isCodexRateLimitError(msg), true);
    });
  }
  const misses = [
    "Context length exceeded, reduce input",
    "Network error: connection reset",
    "Invalid API key",
    "stop reason length",
    "Your quota for this project is 1000 tokens",
    "Check your quota usage in the account dashboard",
    "exceeded the token limit, check quota limits",
  ];
  for (const msg of misses) {
    test(`ignores: ${msg.slice(0, 40)}`, () => {
      assert.equal(isCodexRateLimitError(msg), false);
    });
  }
});

describe("extractRunInfo", () => {
  test("pulls user text, provider, and error from the final assistant message", async () => {
    const run = extractRunInfo([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", provider: "openai-codex-2", model: "gpt-5.5", content: [], usage: {}, stopReason: "error", errorMessage: "429 rate limit", timestamp: 2 },
    ]);
    assert.equal(run.lastUserText, "hello");
    assert.equal(run.lastProvider, "openai-codex-2");
    assert.match(run.lastError ?? "", /rate limit/);
  });

  test("joins structured user content into text", async () => {
    const run = extractRunInfo([
      { role: "user", content: [{ type: "text", text: "fix " }, { type: "text", text: "this" }], timestamp: 1 },
      { role: "assistant", provider: "openai-codex", model: "gpt-5.5", content: [], usage: {}, stopReason: "error", errorMessage: "quota", timestamp: 2 },
    ]);
    assert.equal(run.lastUserText, "fix this");
  });

  test("no error run yields no provider/error", async () => {
    const run = extractRunInfo([
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", provider: "openai-codex", model: "gpt-5.5", content: [], usage: {}, stopReason: "stop", timestamp: 2 },
    ]);
    assert.equal(run.lastError, undefined);
  });
});

describe("decideFailover", () => {
  test("rate-limit failure rotates to the next eligible member", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"], [pool(["openai-codex", "openai-codex-2"])]);
    const state = createRotationState();
    const decision = await decideFailover(
      { lastUserText: "retry me", lastProvider: "openai-codex", lastError: "429 rate limit" },
      sel(cfg, ctx(), state, NOW),
    );
    assert.equal(decision.kind, "retry");
    if (decision.kind === "retry") {
      assert.equal(decision.fromCredentialId, "openai-codex");
      assert.equal(decision.toCredentialId, "openai-codex-2");
      assert.equal(decision.userText, "retry me");
    }
    assert.ok(state.attempted.has("openai-codex"), "failed account recorded as attempted");
    assert.ok(state.cooldownUntil.get("openai-codex")! > NOW, "failed account cooled down");
  });

  test("repeated failures on the same user text accumulate attempts", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2", "openai-codex-3"], [pool(["openai-codex", "openai-codex-2", "openai-codex-3"])]);
    const state = createRotationState();
    const first = await decideFailover({ lastUserText: "same", lastProvider: "openai-codex", lastError: "429" }, sel(cfg, ctx(), state, NOW));
    const second = await decideFailover({ lastUserText: "same", lastProvider: "openai-codex-2", lastError: "429" }, sel(cfg, ctx(), state, NOW));
    assert.equal(first.kind, "retry");
    assert.equal(second.kind, "retry");
    if (first.kind === "retry" && second.kind === "retry") {
      assert.equal(second.fromCredentialId, "openai-codex-2");
      assert.equal(second.toCredentialId, "openai-codex-3", "third member, never reusing an attempted account");
    }
    assert.deepEqual([...state.attempted].sort(), ["openai-codex", "openai-codex-2"]);
  });

  test("a new user text resets the attempted set", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"], [pool(["openai-codex", "openai-codex-2"])]);
    const state = createRotationState();
    await decideFailover({ lastUserText: "old", lastProvider: "openai-codex", lastError: "429" }, sel(cfg, ctx(), state, NOW));
    const fresh = await decideFailover({ lastUserText: "new request", lastProvider: "openai-codex", lastError: "429" }, sel(cfg, ctx(), state, NOW));
    assert.equal(fresh.kind, "retry");
    if (fresh.kind === "retry") {
      assert.equal(fresh.toCredentialId, "openai-codex-2", "attempted set was reset for the new request");
    }
  });

  test("returns none when every member has been attempted", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"], [pool(["openai-codex", "openai-codex-2"])]);
    const state = createRotationState();
    await decideFailover({ lastUserText: "same", lastProvider: "openai-codex", lastError: "429" }, sel(cfg, ctx(), state, NOW));
    const exhausted = await decideFailover({ lastUserText: "same", lastProvider: "openai-codex-2", lastError: "429" }, sel(cfg, ctx(), state, NOW));
    assert.equal(exhausted.kind, "none");
  });

  test("non-rate-limit errors never fail over", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"], [pool(["openai-codex", "openai-codex-2"])]);
    const decision = await decideFailover(
      { lastUserText: "x", lastProvider: "openai-codex", lastError: "network timeout" },
      sel(cfg, ctx(), createRotationState(), NOW),
    );
    assert.equal(decision.kind, "none");
  });

  test("an error mentioning quota without a rate-limit condition does not fail over", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"], [pool(["openai-codex", "openai-codex-2"])]);
    const decision = await decideFailover(
      { lastUserText: "x", lastProvider: "openai-codex", lastError: "Your account quota for this project is 1000 tokens" },
      sel(cfg, ctx(), createRotationState(), NOW),
    );
    assert.equal(decision.kind, "none");
  });

  test("providers outside any enabled pool never fail over", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2"], [pool(["openai-codex-2"])]);
    const decision = await decideFailover(
      { lastUserText: "x", lastProvider: "openai-codex", lastError: "429" },
      sel(cfg, ctx(), createRotationState(), NOW),
    );
    assert.equal(decision.kind, "none");
  });

  test("members already cooling down are skipped by the rotation", async () => {
    const cfg = cfgWith(["openai-codex", "openai-codex-2", "openai-codex-3"], [pool(["openai-codex", "openai-codex-2", "openai-codex-3"])]);
    const state = createRotationState();
    markCooldown(state, "openai-codex-2", 60, NOW);
    const decision = await decideFailover(
      { lastUserText: "x", lastProvider: "openai-codex", lastError: "429" },
      sel(cfg, ctx(), state, NOW),
    );
    assert.equal(decision.kind, "retry");
    if (decision.kind === "retry") {
      assert.equal(decision.toCredentialId, "openai-codex-3", "skips the cooling-down member");
    }
  });
});

describe("actOnFailover", () => {
  function fakePi() {
    const calls: string[] = [];
    const pi = {
      setModel: async () => { calls.push("setModel"); return true; },
      sendUserMessage: (text: string) => { calls.push(`send:${text}`); },
    } as unknown as ExtensionAPI;
    return { pi, calls };
  }

  function fakeCtx(models: { provider: string; id: string }[]) {
    return {
      modelRegistry: {
        getAll: () => models,
        getProviderAuthStatus: () => ({ configured: true }),
        registerProvider: () => {},
        hasConfiguredAuth: () => true,
      },
      cwd: "/tmp/proj",
      isProjectTrusted: () => true,
      hasUI: false,
      ui: undefined as never,
    };
  }

  function writeFixture(pools: CodexPool[]): void {
    const dir = join(tmpHome, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "beautiful-pi.json"),
      JSON.stringify({
        accounts: {
          version: 1,
          accounts: [account("openai-codex"), account("openai-codex-2")],
          pools,
        },
      }),
    );
  }

  test("switches model, advances the pointer, and re-sends the user text", async () => {
    writeFixture([pool(["openai-codex", "openai-codex-2"])]);
    const { pi, calls } = fakePi();
    const ctx = fakeCtx([
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "openai-codex-2", id: "gpt-5.5" },
    ]);
    await actOnFailover(pi, ctx as never, {
      kind: "retry",
      fromCredentialId: "openai-codex",
      toCredentialId: "openai-codex-2",
      poolName: "prod",
      toIndex: 1,
      poolId: "pool-1",
      userText: "retry me",
    });
    assert.deepEqual(calls, ["setModel", "send:retry me"]);
    const saved = loadGlobalAccountConfig();
    assert.equal(saved.pools![0].lastUsedIndex, 1, "rotation pointer persisted after failover");
  });

  test("does nothing for a none decision", async () => {
    const { pi, calls } = fakePi();
    await actOnFailover(pi, fakeCtx([]) as never, { kind: "none" });
    assert.deepEqual(calls, []);
  });
});

describe("failover wiring (agent_end -> agent_settled)", () => {
  test("captures the run and failovers on a settled rate-limit error", async () => {
    const dir = join(tmpHome, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "beautiful-pi.json"),
      JSON.stringify({
        accounts: {
          version: 1,
          accounts: [account("openai-codex"), account("openai-codex-2")],
          pools: [pool(["openai-codex", "openai-codex-2"])],
        },
      }),
    );
    const pi: any = fakePi();
    const setModelCalls: any[] = [];
    const sent: string[] = [];
    pi.setModel = async (m: any) => { setModelCalls.push(m); return true; };
    pi.sendUserMessage = (t: string) => { sent.push(t); };
    wireFailover(pi);
    const ctx = {
      cwd: "/tmp/proj",
      hasUI: false,
      modelRegistry: {
        getAll: () => [{ provider: "openai-codex-2", id: "gpt-5.5" }],
        getProviderAuthStatus: () => ({ configured: true }),
        registerProvider: () => {},
        hasConfiguredAuth: () => true,
      },
    };
    const agentEnd = (pi.events.get("agent_end") ?? [])[0];
    const agentSettled = (pi.events.get("agent_settled") ?? [])[0];
    assert.ok(agentEnd && agentSettled, "both handlers registered");
    await agentEnd({ messages: [
      { role: "user", content: "retry me", timestamp: 1 },
      { role: "assistant", provider: "openai-codex", model: "gpt-5.5", content: [], usage: {}, stopReason: "error", errorMessage: "429 rate limit", timestamp: 2 },
    ] }, ctx);
    await agentSettled({}, ctx);
    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0].provider, "openai-codex-2", "model switched to next eligible member");
    assert.deepEqual(sent, ["retry me"], "interrupted request re-sent");
  });

  test("a duplicated agent_settled for the same run does not double-failover", async () => {
    const pi: any = fakePi();
    let setModelCount = 0;
    pi.setModel = async () => { setModelCount++; return true; };
    pi.sendUserMessage = () => {};
    wireFailover(pi);
    const ctx = {
      cwd: "/tmp/proj",
      hasUI: false,
      modelRegistry: {
        getAll: () => [{ provider: "openai-codex-2", id: "gpt-5.5" }],
        getProviderAuthStatus: () => ({ configured: true }),
        registerProvider: () => {},
        hasConfiguredAuth: () => true,
      },
    };
    const agentEnd = (pi.events.get("agent_end") ?? [])[0];
    const agentSettled = (pi.events.get("agent_settled") ?? [])[0];
    await agentEnd({ messages: [
      { role: "user", content: "same", timestamp: 1 },
      { role: "assistant", provider: "openai-codex", model: "gpt-5.5", content: [], usage: {}, stopReason: "error", errorMessage: "429 quota exceeded", timestamp: 2 },
    ] }, ctx);
    await agentSettled({}, ctx);
    await agentSettled({}, ctx);
    assert.equal(setModelCount, 1, "settled re-fire is ignored");
  });
});

describe("decideFailover with chains", () => {
  function cfgWithChains(): AccountConfig {
    const pools = [
      pool(["openai-codex", "openai-codex-2"], { id: "pool-1", name: "prod" }),
      pool(["openai-codex-3"], { id: "pool-2", name: "dev", lastUsedIndex: -1 }),
    ];
    return {
      version: 1,
      accounts: ["openai-codex", "openai-codex-2", "openai-codex-3"].map(account),
      pools,
      chains: [
        {
          id: "chain-1",
          name: "primary",
          enabled: true,
          targets: [
            { kind: "pool", poolId: "pool-1" },
            { kind: "pool", poolId: "pool-2" },
          ],
          lastUsedTargetIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
  }

  test("chain replay rotates past the failed member, then advances the chain", async () => {
    const cfg = cfgWithChains();
    const state = createRotationState();
    const run = { lastUserText: "retry me", lastProvider: "openai-codex", lastError: "429 rate limit" };
    const first = await decideFailover(run, sel(cfg, ctx(), state, NOW));
    assert.equal(first.kind, "retry");
    if (first.kind !== "retry") return;
    assert.equal(first.toCredentialId, "openai-codex-2", "rotates past failed member in same pool target");
    assert.equal(first.chainId, "chain-1");
    assert.equal(first.toTargetIndex, 0, "chain progress stays on the failing target's pool");
    // Second failure on the same user text: pool exhausted -> next chain target.
    const secondRun = { ...run, lastProvider: "openai-codex-2" };
    const second = await decideFailover(secondRun, sel(cfg, ctx(), state, NOW));
    assert.equal(second.kind, "retry");
    if (second.kind !== "retry") return;
    assert.equal(second.toCredentialId, "openai-codex-3", "moved to the next chain target");
    assert.equal(second.toTargetIndex, 1);
    assert.equal(second.poolId, "pool-2");
  });

  test("chain replay never revisits the failed target", async () => {
    const cfg = cfgWithChains();
    const state = createRotationState();
    // Both pool-1 members failed on this user text already.
    const run1 = { lastUserText: "same text", lastProvider: "openai-codex", lastError: "429 rate limit" };
    const d1 = await decideFailover(run1, sel(cfg, ctx(), state, NOW));
    assert.equal(d1.kind, "retry");
    if (d1.kind !== "retry") return;
    assert.equal(d1.toCredentialId, "openai-codex-2");
    const run2 = { lastUserText: "same text", lastProvider: "openai-codex-2", lastError: "429 rate limit" };
    const d2 = await decideFailover(run2, sel(cfg, ctx(), state, NOW));
    assert.equal(d2.kind, "retry");
    if (d2.kind !== "retry") return;
    assert.equal(d2.toCredentialId, "openai-codex-3");
    const run3 = { lastUserText: "same text", lastProvider: "openai-codex-3", lastError: "429 rate limit" };
    const d3 = await decideFailover(run3, sel(cfg, ctx(), state, NOW));
    assert.equal(d3.kind, "none", "no member left in the chain");
  });

  test("a direct account target in a chain fails over to the next target", async () => {
    const pools = [pool(["openai-codex"], { id: "pool-1", name: "prod", lastUsedIndex: -1 })];
    const cfg: AccountConfig = {
      version: 1,
      accounts: ["openai-codex", "openai-codex-2"].map(account),
      pools,
      chains: [
        {
          id: "chain-1",
          name: "primary",
          enabled: true,
          targets: [
            { kind: "account", credentialId: "openai-codex" },
            { kind: "account", credentialId: "openai-codex-2" },
          ],
          lastUsedTargetIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const state = createRotationState();
    const run = { lastUserText: "retry me", lastProvider: "openai-codex", lastError: "rate limit hit" };
    const d = await decideFailover(run, sel(cfg, ctx(), state, NOW));
    assert.equal(d.kind, "retry");
    if (d.kind !== "retry") return;
    assert.equal(d.toCredentialId, "openai-codex-2");
    assert.equal(d.poolId, undefined, "no pool pointer for account targets");
  });
});

describe("actOnFailover with chains", () => {
  test("persists the chain target progress and the pool pointer", async () => {
    const dir = join(tmpHome, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "beautiful-pi.json"),
      JSON.stringify({
        accounts: {
          version: 1,
          accounts: ["openai-codex", "openai-codex-2"].map(account),
          pools: [pool(["openai-codex", "openai-codex-2"])],
          chains: [
            {
              id: "chain-1",
              name: "primary",
              enabled: true,
              targets: [{ kind: "pool", poolId: "pool-1" }],
              lastUsedTargetIndex: -1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      }),
    );
    const pi = {
      setModel: async () => true,
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI;
    const ctx = {
      modelRegistry: {
        getAll: () => [{ provider: "openai-codex-2", id: "gpt-5.5" }],
        getProviderAuthStatus: () => ({ configured: true }),
        registerProvider: () => {},
        hasConfiguredAuth: () => true,
      },
      cwd: "/tmp/proj",
      hasUI: false,
    };
    await actOnFailover(pi, ctx as never, {
      kind: "retry",
      fromCredentialId: "openai-codex",
      toCredentialId: "openai-codex-2",
      poolName: "prod",
      toIndex: 1,
      poolId: "pool-1",
      chainId: "chain-1",
      toTargetIndex: 0,
      userText: "retry me",
    });
    const saved = loadGlobalAccountConfig();
    assert.equal(saved.pools![0].lastUsedIndex, 1, "pool pointer persisted");
    assert.equal(saved.chains![0].lastUsedTargetIndex, 0, "chain progress persisted");
  });
});

describe("decideFailover with project overrides", () => {
  test("replay honors an effective pool override's member list", async () => {
    // Global pool prod = [openai-codex, openai-codex-2]; project override = [openai-codex-2, openai-codex-3].
    const global: AccountConfig = {
      version: 1,
      accounts: ["openai-codex", "openai-codex-2", "openai-codex-3"].map(account),
      pools: [pool(["openai-codex", "openai-codex-2"])],
      chains: [
        {
          id: "chain-1",
          name: "primary",
          enabled: true,
          targets: [{ kind: "pool", poolId: "pool-1" }],
          lastUsedTargetIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const effective = resolveEffectiveConfig(global, {
      poolOverrides: { prod: { credentialIds: ["openai-codex-2", "openai-codex-3"] } },
    });
    assert.equal(effective.pools![0].credentialIds.length, 2, "override applied");
    const state = createRotationState();
    const run = { lastUserText: "retry me", lastProvider: "openai-codex-2", lastError: "429 rate limit" };
    const d = await decideFailover(run, sel(effective, ctx(), state, NOW));
    assert.equal(d.kind, "retry");
    if (d.kind !== "retry") return;
    assert.equal(d.toCredentialId, "openai-codex-3", "replay routes to the override member, not the global one");
  });
});
