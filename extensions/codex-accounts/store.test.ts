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
