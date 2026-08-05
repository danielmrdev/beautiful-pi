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
} from "./store.ts";
import { nextCodexCredentialId, isSuffixedCodexId } from "./provider.ts";
import type { AccountConfig } from "./types.ts";

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
