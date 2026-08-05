/**
 * Unit tests for the account config store: pure account operations and
 * file round-trips (global + project), plus settings/accounts coexistence.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadGlobalAccountConfig,
  saveGlobalAccountConfig,
  loadProjectAccountConfig,
  saveProjectAccountConfig,
  isCredentialAllowed,
  addAccount,
  removeAccount,
  setActiveAccount,
  resolveAccount,
  agentDirPath,
  authFilePath,
  createPool,
  setPoolStrategy,
  setPoolSchedule,
  clearPoolSchedule,
  setPoolSelector,
  clearPoolSelector,
  isPoolStrategy,
  createChain,
  addChainTargets,
  removeChainTargets,
  setChainEnabled,
  deleteChain,
  createPreset,
  setPresetEnabled,
  deletePreset,
  resolveEffectiveConfig,
} from "./store.ts";
import { nextCodexCredentialId, isSuffixedCodexId } from "./provider.ts";
import type { AccountConfig, ProjectAccountConfig } from "./types.ts";

// ── Setup: isolated HOME ──────────────────────────────────────────────────────

let tmpHome: string;
let tmpProject: string;
let settingsPath: string;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-store-test-"));
  tmpProject = mkdtempSync(join(tmpdir(), "bpi-store-proj-"));
  settingsPath = join(tmpHome, ".pi", "agent", "beautiful-pi.json");
  process.env["HOME"] = tmpHome;
});

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

function emptyCfg(): AccountConfig {
  return { version: 1, accounts: [] };
}

// ── Pure ops ─────────────────────────────────────────────────────────────────

describe("account ops", () => {
  test("addAccount creates an account and is idempotent by credentialId", () => {
    const { cfg, account, created } = addAccount(emptyCfg(), {
      provider: "openai-codex",
      credentialId: "openai-codex-2",
      label: "work",
    });
    assert.equal(created, true);
    assert.equal(cfg.accounts.length, 1);
    assert.equal(account.label, "work");
    assert.ok(account.id.length > 0);

    const second = addAccount(cfg, {
      provider: "openai-codex",
      credentialId: "openai-codex-2",
      label: "work",
    });
    assert.equal(second.created, false);
    assert.equal(second.cfg.accounts.length, 1, "no duplicate account");
  });

  test("setActiveAccount marks one account active and records lastUsedAt", () => {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    cfg = setActiveAccount(cfg, cfg.accounts[1].id);
    assert.equal(cfg.activeAccountId, cfg.accounts[1].id);
    assert.ok(cfg.accounts[1].active, "active flag set");
    assert.equal(cfg.accounts[0].active, undefined, "other account not active");
    assert.ok(cfg.accounts[1].lastUsedAt, "lastUsedAt recorded");
  });

  test("removeAccount removes the entry and clears activeAccountId", () => {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "a" }).cfg;
    cfg = setActiveAccount(cfg, cfg.accounts[0].id);
    cfg = removeAccount(cfg, cfg.accounts[0].id);
    assert.equal(cfg.accounts.length, 0);
    assert.equal(cfg.activeAccountId, undefined);
  });

  test("removeAccount promotes a successor when the active account is removed", () => {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "a" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "b" }).cfg;
    assert.equal(cfg.activeAccountId, cfg.accounts[0].id, "first account active");
    cfg = removeAccount(cfg, cfg.accounts[0].id);
    assert.equal(cfg.accounts.length, 1);
    assert.equal(cfg.activeAccountId, cfg.accounts[0].id, "successor promoted");
    assert.ok(cfg.accounts[0].active, "successor marked active");
  });

  test("addAccount auto-promotes the first account", () => {
    const result = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex-2", label: "first" });
    assert.equal(result.cfg.activeAccountId, result.account.id, "first account becomes active");
    assert.ok(result.account.active);
  });

  test("resolveAccount matches by id, credentialId, and label", () => {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex-2", label: "Work Account" }).cfg;
    const account = cfg.accounts[0];
    assert.equal(resolveAccount(cfg, account.id)?.id, account.id);
    assert.equal(resolveAccount(cfg, "openai-codex-2")?.id, account.id);
    assert.equal(resolveAccount(cfg, "work account")?.id, account.id);
    assert.equal(resolveAccount(cfg, "nope"), undefined);
  });
});

describe("credential id allocation", () => {
  test("nextCodexCredentialId skips used suffixes", () => {
    assert.equal(nextCodexCredentialId([]), "openai-codex-2");
    assert.equal(nextCodexCredentialId(["openai-codex"]), "openai-codex-2");
    assert.equal(nextCodexCredentialId(["openai-codex", "openai-codex-2", "openai-codex-5"]), "openai-codex-6");
  });

  test("isSuffixedCodexId distinguishes base and suffixed ids", () => {
    assert.equal(isSuffixedCodexId("openai-codex"), false);
    assert.equal(isSuffixedCodexId("openai-codex-2"), true);
    assert.equal(isSuffixedCodexId("anthropic-2"), false);
  });
});

// ── File round-trips ─────────────────────────────────────────────────────────

describe("global account config file", () => {
  test("save then load round-trips accounts and preserves other keys", () => {
    const cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    saveGlobalAccountConfig(cfg, settingsPath);

    // Simulate the settings file owning other keys.
    writeFileSync(settingsPath, JSON.stringify({ agentRailColor: "error", accounts: cfg }) + "\n");
    const loaded = loadGlobalAccountConfig(settingsPath);
    assert.equal(loaded.accounts.length, 1);
    assert.equal(loaded.accounts[0].label, "work");
    const raw = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
    assert.equal(raw.agentRailColor, "error", "non-accounts keys preserved");
  });

  test("missing or corrupt file yields an empty config", () => {
    const missing = loadGlobalAccountConfig(join(tmpHome, "does-not-exist.json"));
    assert.deepEqual(missing.accounts, []);
    writeFileSync(settingsPath, "{corrupt");
    const corrupt = loadGlobalAccountConfig(settingsPath);
    assert.deepEqual(corrupt.accounts, []);
  });

  test("agentDirPath and authFilePath point under HOME", () => {
    assert.equal(agentDirPath(), join(tmpHome, ".pi", "agent"));
    assert.equal(authFilePath(), join(tmpHome, ".pi", "agent", "auth.json"));
  });
});

describe("project account config", () => {
  test("save/load allowedCredentialIds and restriction check", () => {
    const projectPath = join(tmpProject, ".pi");
    mkdirSync(projectPath, { recursive: true });
    saveProjectAccountConfig(tmpProject, { allowedCredentialIds: ["openai-codex"] });
    const loaded = loadProjectAccountConfig(tmpProject);
    assert.deepEqual(loaded?.allowedCredentialIds, ["openai-codex"]);
    assert.equal(isCredentialAllowed(tmpProject, "openai-codex"), true);
    assert.equal(isCredentialAllowed(tmpProject, "openai-codex-2"), false);
  });

  test("missing project config allows everything", () => {
    assert.equal(isCredentialAllowed(join(tmpProject, "empty"), "openai-codex-2"), true);
  });

  test("no restriction when allowedCredentialIds is empty", () => {
    const projectPath = join(tmpProject, ".pi");
    saveProjectAccountConfig(tmpProject, { allowedCredentialIds: [] });
    assert.equal(isCredentialAllowed(tmpProject, "openai-codex-2"), true);
  });
});

describe("settings file coexistence", () => {
  test("saveSettings preserves the accounts key", async () => {
    const v = Date.now() + Math.random();
    const { loadSettings, saveSettings } = await import(`../shared/settings.ts?v=${v}`);

    // Seed an accounts namespace in the settings file.
    const cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    saveGlobalAccountConfig(cfg, settingsPath);

    // Saving settings must not drop accounts.
    const settings = loadSettings();
    saveSettings({ ...settings, indentLevel: 8 });
    const raw = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
    assert.ok(raw.accounts, "accounts key preserved after saveSettings");
    assert.equal(raw.accounts.accounts.length, 1);
    assert.equal(raw.indentLevel, 8);

    // Reverting settings to defaults must NOT delete the file while accounts exist.
    saveSettings(loadSettings());
    assert.ok(existsSync(settingsPath), "file kept when accounts namespace present");
  });
});

describe("pool strategy ops", () => {
  function cfgWithPool(extra: Record<string, unknown> = {}): AccountConfig {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    const created = createPool(cfg, "prod", ["personal", "work"]);
    assert.equal(created.created, true);
    return { ...created.cfg, pools: created.cfg.pools!.map((p) => ({ ...p, ...extra })) };
  }

  test("setPoolStrategy accepts the four strategies and rejects others", () => {
    for (const s of ["round-robin", "quota-first", "scheduled", "custom"] as const) {
      const r = setPoolStrategy(cfgWithPool(), "prod", s);
      assert.equal(r.ok, true);
      assert.equal(r.cfg.pools![0].strategy, s === "round-robin" ? undefined : s);
    }
    const bad = setPoolStrategy(cfgWithPool(), "prod", "quantum");
    assert.equal(bad.ok, false);
    assert.ok(bad.errors[0].includes("quantum"));
    assert.equal(isPoolStrategy("quota-first"), true);
    assert.equal(isPoolStrategy("nope"), false);
  });

  test("setPoolStrategy reports an unknown pool", () => {
    const r = setPoolStrategy(cfgWithPool(), "ghost", "quota-first");
    assert.equal(r.ok, false);
  });

  test("setPoolSchedule stores and clearPoolSchedule removes the schedule", () => {
    const withSchedule = setPoolSchedule(cfgWithPool(), "prod", {
      timeWindows: [{ start: "09:00", end: "17:00" }],
      days: [1, 2, 3, 4, 5],
      dateRange: { start: "2026-01-01", end: "2026-12-31" },
      memberRoles: { "openai-codex": "backup" },
    });
    assert.equal(withSchedule.ok, true);
    const schedule = withSchedule.cfg.pools![0].schedule!;
    assert.deepEqual(schedule.timeWindows, [{ start: "09:00", end: "17:00" }]);
    assert.deepEqual(schedule.days, [1, 2, 3, 4, 5]);
    assert.deepEqual(schedule.memberRoles, { "openai-codex": "backup" });

    const cleared = clearPoolSchedule(withSchedule.cfg, "prod");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cfg.pools![0].schedule, undefined);
  });

  test("setPoolSchedule rejects an empty schedule", () => {
    const r = setPoolSchedule(cfgWithPool(), "prod", {});
    assert.equal(r.ok, false);
  });

  test("setPoolSelector stores and clearPoolSelector removes it", () => {
    const set = setPoolSelector(cfgWithPool(), "prod", "./select.sh --json");
    assert.equal(set.ok, true);
    assert.equal(set.cfg.pools![0].selector, "./select.sh --json");
    const cleared = clearPoolSelector(set.cfg, "prod");
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cfg.pools![0].selector, undefined);
  });

  test("normalization drops invalid strategy, schedule, and selector entries", () => {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    cfg = createPool(cfg, "prod", ["personal", "work"]).cfg;
    saveGlobalAccountConfig(cfg, settingsPath);
    const raw = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
    raw.accounts.pools[0] = {
      ...raw.accounts.pools[0],
      strategy: "quantum",
      schedule: { timeWindows: [{ start: "25:99", end: "17:00" }], days: [9], memberRoles: { x: "king" } },
      selector: "   ",
    };
    require("node:fs").writeFileSync(settingsPath, JSON.stringify(raw, null, 2));

    const loaded = loadGlobalAccountConfig(settingsPath);
    const pool = loaded.pools![0];
    assert.equal(pool.strategy, undefined, "invalid strategy dropped");
    assert.equal(pool.schedule, undefined, "invalid schedule dropped");
    assert.equal(pool.selector, undefined, "blank selector dropped");
  });

  test("normalization keeps valid strategy/schedule/selector through a round-trip", () => {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    const withPool = createPool(cfg, "prod", ["personal", "work"]);
    const configured = setPoolSelector(
      setPoolSchedule(
        setPoolStrategy(withPool.cfg, "prod", "scheduled").cfg,
        "prod",
        { timeWindows: [{ start: "22:00", end: "02:00" }], memberRoles: { "openai-codex-2": "backup" } },
      ).cfg,
      "prod",
      "echo work",
    );
    saveGlobalAccountConfig(configured.cfg, settingsPath);

    const loaded = loadGlobalAccountConfig(settingsPath);
    const pool = loaded.pools![0];
    assert.equal(pool.strategy, "scheduled");
    assert.deepEqual(pool.schedule?.timeWindows, [{ start: "22:00", end: "02:00" }]);
    assert.equal(pool.schedule?.memberRoles?.["openai-codex-2"], "backup");
    assert.equal(pool.selector, "echo work");
  });
});

describe("chain ops", () => {
  function cfgWithPoolAndAccount(): AccountConfig {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    const created = createPool(cfg, "prod", ["personal", "work"]);
    return created.cfg;
  }

  test("createChain resolves pool and account refs in order", () => {
    const cfg = cfgWithPoolAndAccount();
    const r = createChain(cfg, "primary", ["prod", "openai-codex-2"]);
    assert.equal(r.created, true);
    assert.equal(r.chain!.targets.length, 2);
    assert.deepEqual(r.chain!.targets[0], { kind: "pool", poolId: cfg.pools![0].id });
    assert.deepEqual(r.chain!.targets[1], { kind: "account", credentialId: "openai-codex-2" });
    assert.equal(r.chain!.enabled, true);
    assert.equal(r.chain!.lastUsedTargetIndex, -1);
  });

  test("createChain rejects unknown targets without touching config", () => {
    const cfg = cfgWithPoolAndAccount();
    const r = createChain(cfg, "primary", ["prod", "ghost"]);
    assert.equal(r.created, false);
    assert.ok(r.errors[0].includes("ghost"));
    assert.equal((cfg.chains ?? []).length, 0, "config unchanged");
  });

  test("createChain rejects duplicate names and empty target lists", () => {
    const cfg = cfgWithPoolAndAccount();
    const first = createChain(cfg, "primary", ["prod"]);
    assert.equal(first.created, true);
    const dup = createChain(first.cfg, "primary", ["prod"]);
    assert.equal(dup.created, false);
    assert.ok(dup.errors[0].includes("already exists"));
    const empty = createChain(first.cfg, "secondary", []);
    assert.equal(empty.created, false);
  });

  test("chain add/remove targets, enable/disable, delete", () => {
    let cfg = cfgWithPoolAndAccount();
    cfg = createChain(cfg, "primary", ["prod"]).cfg;
    const added = addChainTargets(cfg, "primary", ["openai-codex-2"]);
    assert.equal(added.ok, true);
    assert.equal(added.cfg.chains![0].targets.length, 2);
    const bad = addChainTargets(cfg, "primary", ["ghost"]);
    assert.equal(bad.ok, false);
    const removed = removeChainTargets(added.cfg, "primary", ["openai-codex-2"]);
    assert.equal(removed.ok, true);
    assert.equal(removed.cfg.chains![0].targets.length, 1);
    const disabled = setChainEnabled(removed.cfg, "primary", false);
    assert.equal(disabled.cfg.chains![0].enabled, false);
    const unknown = setChainEnabled(disabled.cfg, "ghost", true);
    assert.equal(unknown.ok, false);
    const deleted = deleteChain(disabled.cfg, "primary");
    assert.equal((deleted.chains ?? []).length, 0);
  });
});

describe("preset ops", () => {
  function cfgWithPool(): AccountConfig {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    return createPool(cfg, "prod", ["personal"]).cfg;
  }

  test("createPreset resolves the pool and stores an optional model filter", () => {
    const cfg = cfgWithPool();
    const r = createPreset(cfg, "fast", "prod", "gpt-5-codex");
    assert.equal(r.created, true);
    assert.equal(r.preset!.poolId, cfg.pools![0].id);
    assert.equal(r.preset!.model, "gpt-5-codex");
    const noModel = createPreset(cfg, "plain", "prod", undefined);
    assert.equal(noModel.preset!.model, undefined);
  });

  test("createPreset rejects unknown pools and duplicate names", () => {
    const cfg = cfgWithPool();
    const bad = createPreset(cfg, "fast", "ghost", undefined);
    assert.equal(bad.created, false);
    assert.ok(bad.errors[0].includes("ghost"));
    const first = createPreset(cfg, "fast", "prod", undefined);
    assert.equal(first.created, true);
    const dup = createPreset(first.cfg, "fast", "prod", undefined);
    assert.equal(dup.created, false);
    assert.equal((cfg.presets ?? []).length, 0, "config unchanged on failure");
  });

  test("preset enable/disable and delete", () => {
    let cfg = cfgWithPool();
    cfg = createPreset(cfg, "fast", "prod", undefined).cfg;
    const disabled = setPresetEnabled(cfg, "fast", false);
    assert.equal(disabled.cfg.presets![0].enabled, false);
    assert.equal(setPresetEnabled(disabled.cfg, "ghost", true).ok, false);
    const deleted = deletePreset(disabled.cfg, "fast");
    assert.equal((deleted.presets ?? []).length, 0);
  });
});

describe("effective config (project overrides)", () => {
  function globalCfg(): AccountConfig {
    let cfg = addAccount(emptyCfg(), { provider: "openai-codex", credentialId: "openai-codex", label: "personal" }).cfg;
    cfg = addAccount(cfg, { provider: "openai-codex", credentialId: "openai-codex-2", label: "work" }).cfg;
    cfg = createPool(cfg, "prod", ["personal", "work"]).cfg;
    cfg = createChain(cfg, "primary", ["prod"]).cfg;
    return cfg;
  }

  test("no project config keeps the global config untouched", () => {
    const global = globalCfg();
    const effective = resolveEffectiveConfig(global, null);
    assert.equal(effective, global, "returns the same reference");
  });

  test("pool override replaces members and enabled for the named pool", () => {
    const global = globalCfg();
    const project: ProjectAccountConfig = {
      poolOverrides: {
        prod: { enabled: false, credentialIds: ["openai-codex-2"] },
      },
    };
    const effective = resolveEffectiveConfig(global, project);
    const prod = effective.pools!.find((p) => p.name === "prod")!;
    assert.equal(prod.enabled, false);
    assert.deepEqual(prod.credentialIds, ["openai-codex-2"]);
    // Other pools are untouched.
    assert.equal(effective.pools!.length, 1);
  });

  test("chain override replaces targets for the named chain", () => {
    const global = globalCfg();
    const project: ProjectAccountConfig = {
      chainOverrides: {
        primary: { targets: [{ kind: "account", credentialId: "openai-codex-2" }] },
      },
    };
    const effective = resolveEffectiveConfig(global, project);
    const chain = effective.chains!.find((c) => c.name === "primary")!;
    assert.deepEqual(chain.targets, [{ kind: "account", credentialId: "openai-codex-2" }]);
  });

  test("global entries without an override remain the fallback", () => {
    const global = globalCfg();
    const project: ProjectAccountConfig = {
      poolOverrides: { prod: { credentialIds: ["openai-codex-2"] } },
    };
    const effective = resolveEffectiveConfig(global, project);
    const primary = effective.chains!.find((c) => c.name === "primary")!;
    assert.deepEqual(primary.targets, [{ kind: "pool", poolId: global.pools![0].id }], "chain untouched");
  });
});
