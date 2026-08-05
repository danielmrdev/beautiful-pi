/**
 * Migration tests: legacy multi-pass config -> account namespace.
 * Covers backup, idempotent reruns, malformed tolerance, and the project gate.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateGlobalLegacy, migrateProjectLegacy, runMigration } from "./migration.ts";
import { loadGlobalAccountConfig, loadProjectAccountConfig } from "./store.ts";

let tmpHome: string;
let agentDir: string;
let settingsPath: string;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-migration-test-"));
  agentDir = join(tmpHome, ".pi", "agent");
  settingsPath = join(agentDir, "beautiful-pi.json");
  mkdirSync(agentDir, { recursive: true });
  process.env["HOME"] = tmpHome;
});

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function legacyGlobal(agentDirPath: string, content: string): string {
  const path = join(agentDirPath, "multi-pass.json");
  writeFileSync(path, content);
  return path;
}

function backupFiles(agentDirPath: string): string[] {
  return readdirSync(agentDirPath).filter((f) => f.startsWith("multi-pass.json.bak-"));
}

describe("global migration", () => {
  test("migrates valid subscriptions, backs up, and renames to .migrated", () => {
    legacyGlobal(agentDir, JSON.stringify({
      subscriptions: [
        { provider: "openai-codex", index: 2, label: "Codex danielmr.dev" },
        { provider: "openai-codex-2", index: 3, label: "work" },
      ],
      pools: [], chains: [], presets: [],
    }));

    const summary = migrateGlobalLegacy(agentDir);
    assert.equal(summary.global, "migrated");
    assert.equal(summary.accountsCreated, 2);
    assert.deepEqual(summary.warnings, []);

    const cfg = loadGlobalAccountConfig(settingsPath);
    assert.equal(cfg.accounts.length, 2);
    assert.equal(cfg.accounts[0].credentialId, "openai-codex");
    assert.equal(cfg.accounts[0].label, "Codex danielmr.dev");
    assert.equal(cfg.accounts[0].legacy?.index, 2);
    assert.equal(cfg.accounts[0].legacy?.source, "multi-pass");
    assert.equal(cfg.accounts[1].credentialId, "openai-codex-2");
    assert.ok(cfg.accounts[0].active, "first migrated account becomes active");
    assert.equal(cfg.activeAccountId, cfg.accounts[0].id, "activeAccountId set");
    assert.ok(cfg.migration?.globalMigratedAt);

    assert.equal(backupFiles(agentDir).length, 1, "backup created before changing legacy file");
    assert.ok(existsSync(join(agentDir, "multi-pass.json.migrated")), "legacy file renamed");
    assert.equal(existsSync(join(agentDir, "multi-pass.json")), false);
  });

  test("rerun is idempotent and creates no duplicate accounts", () => {
    // The legacy file was renamed to .migrated by the first run, so there is
    // nothing left to migrate; accounts stay as they are.
    const summary = migrateGlobalLegacy(agentDir);
    assert.equal(summary.accountsCreated, 0);
    assert.equal(summary.warnings.length, 0);
    const cfg = loadGlobalAccountConfig(settingsPath);
    assert.equal(cfg.accounts.length, 2, "no duplicates after rerun");
    assert.equal(backupFiles(agentDir).length, 1, "no extra backup on rerun");
  });

  test("malformed legacy JSON is left untouched, not consumed", () => {
    const fresh = mkdtempSync(join(tmpdir(), "bpi-malformed-"));
    const freshAgent = join(fresh, ".pi", "agent");
    mkdirSync(freshAgent, { recursive: true });
    process.env["HOME"] = fresh;
    const legacyPath = legacyGlobal(freshAgent, "{not json");

    const summary = migrateGlobalLegacy(freshAgent);
    assert.equal(summary.global, "skipped-malformed");
    assert.ok(summary.warnings.length > 0);
    const cfg = loadGlobalAccountConfig(join(freshAgent, "beautiful-pi.json"));
    assert.deepEqual(cfg.accounts, [], "no accounts invented from malformed file");
    // A malformed file is NOT consumed: fixing it must allow a later migration.
    assert.ok(existsSync(legacyPath), "malformed file left in place");
    assert.equal(existsSync(join(freshAgent, "multi-pass.json.migrated")), false, "not renamed");
    assert.deepEqual(backupFiles(freshAgent), [], "no backup for unparsed file");

    // Fixing the file lets the migration run.
    writeFileSync(legacyPath, JSON.stringify({ subscriptions: [{ provider: "openai-codex", label: "fixed" }] }));
    const retry = migrateGlobalLegacy(freshAgent);
    assert.equal(retry.global, "migrated");
    assert.equal(loadGlobalAccountConfig(join(freshAgent, "beautiful-pi.json")).accounts.length, 1);
  });

  test("unknown providers and malformed entries are skipped individually", () => {
    const fresh = mkdtempSync(join(tmpdir(), "bpi-unknown-"));
    const freshAgent = join(fresh, ".pi", "agent");
    mkdirSync(freshAgent, { recursive: true });
    process.env["HOME"] = fresh;
    legacyGlobal(freshAgent, JSON.stringify({
      subscriptions: [
        { provider: "anthropic-2", label: "Claude" },
        { provider: "openai-codex", label: "good" },
        { provider: 42 },
        { label: "no-provider" },
        null,
      ],
    }));

    const summary = migrateGlobalLegacy(freshAgent);
    assert.equal(summary.global, "migrated");
    assert.equal(summary.accountsCreated, 1);
    assert.equal(summary.warnings.length, 4, "one warning per skipped entry");
    const cfg = loadGlobalAccountConfig(join(freshAgent, "beautiful-pi.json"));
    assert.equal(cfg.accounts.length, 1);
    assert.equal(cfg.accounts[0].credentialId, "openai-codex");
  });

  test("label falls back to the provider id", () => {
    const fresh = mkdtempSync(join(tmpdir(), "bpi-nolabel-"));
    const freshAgent = join(fresh, ".pi", "agent");
    mkdirSync(freshAgent, { recursive: true });
    process.env["HOME"] = fresh;
    legacyGlobal(freshAgent, JSON.stringify({ subscriptions: [{ provider: "openai-codex-2" }] }));

    migrateGlobalLegacy(freshAgent);
    const cfg = loadGlobalAccountConfig(join(freshAgent, "beautiful-pi.json"));
    assert.equal(cfg.accounts[0].label, "openai-codex-2");
  });

  test("no legacy file is a no-op", () => {
    const fresh = mkdtempSync(join(tmpdir(), "bpi-none-"));
    process.env["HOME"] = fresh;
    const summary = migrateGlobalLegacy(join(fresh, ".pi", "agent"));
    assert.equal(summary.global, "none");
  });
});

describe("project migration", () => {
  test("migrates allowedSubs into .pi/beautiful-pi.json", () => {
    const project = mkdtempSync(join(tmpdir(), "bpi-proj-"));
    const piDir = join(project, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "multi-pass.json"), JSON.stringify({
      allowedSubs: ["openai-codex", "openai-codex-2", "anthropic-2", ""],
      pools: [], chains: [],
    }));

    const summary = migrateProjectLegacy(project);
    assert.equal(summary.project, "migrated");
    assert.equal(summary.warnings.length, 2, "unknown provider + empty entry warned");
    const cfg = loadProjectAccountConfig(project);
    assert.deepEqual(cfg?.allowedCredentialIds, ["openai-codex", "openai-codex-2"]);
    assert.ok(cfg?.migratedFromLegacyAt, "per-project marker written");
    assert.ok(existsSync(join(piDir, "multi-pass.json.migrated")));
    assert.equal(existsSync(join(piDir, "multi-pass.json")), false);
    assert.equal(backupFiles(piDir).length, 1);

    // Rerun is idempotent: a re-created legacy file is not migrated again.
    writeFileSync(join(piDir, "multi-pass.json"), JSON.stringify({
      allowedSubs: ["openai-codex-3"],
    }));
    const again = migrateProjectLegacy(project);
    assert.equal(again.project, "already");
    const unchanged = loadProjectAccountConfig(project);
    assert.deepEqual(unchanged?.allowedCredentialIds, ["openai-codex", "openai-codex-2"], "no re-migration");
  });

  test("project without valid codex subs writes only the marker", () => {
    const project = mkdtempSync(join(tmpdir(), "bpi-proj2-"));
    const piDir = join(project, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "multi-pass.json"), JSON.stringify({ allowedSubs: ["anthropic-2"] }));
    const summary = migrateProjectLegacy(project);
    assert.equal(summary.project, "skipped-malformed");
    const cfg = loadProjectAccountConfig(project);
    assert.equal(cfg?.allowedCredentialIds, undefined, "no restriction written");
    assert.ok(cfg?.migratedFromLegacyAt, "marker written so rerun is idempotent");
    assert.ok(existsSync(join(piDir, "multi-pass.json.migrated")));
  });
});

describe("runMigration orchestration", () => {
  test("project migration only when trusted", () => {
    const project = mkdtempSync(join(tmpdir(), "bpi-run-"));
    const piDir = join(project, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "multi-pass.json"), JSON.stringify({ allowedSubs: ["openai-codex"] }));

    const untrusted = runMigration(agentDir, project, { trusted: false });
    assert.equal(untrusted.project, "skipped-untrusted");
    assert.equal(loadProjectAccountConfig(project), null, "no write when untrusted");
    assert.ok(existsSync(join(piDir, "multi-pass.json")), "legacy untouched when untrusted");

    const trusted = runMigration(agentDir, project, { trusted: true });
    assert.equal(trusted.project, "migrated");
    assert.equal(loadProjectAccountConfig(project)?.allowedCredentialIds?.[0], "openai-codex");
  });

  test("global already-migrated state stays intact across runMigration", () => {
    const fresh = mkdtempSync(join(tmpdir(), "bpi-again-"));
    const freshAgent = join(fresh, ".pi", "agent");
    mkdirSync(freshAgent, { recursive: true });
    process.env["HOME"] = fresh;
    const legacy = legacyGlobal(freshAgent, JSON.stringify({
      subscriptions: [{ provider: "openai-codex", index: 1, label: "first" }],
    }));
    migrateGlobalLegacy(freshAgent);
    assert.equal(loadGlobalAccountConfig(join(freshAgent, "beautiful-pi.json")).accounts.length, 1);

    // A re-created legacy file (e.g. pi-multi-pass writing again) must not
    // re-migrate: the .migrated marker short-circuits.
    writeFileSync(legacy, JSON.stringify({
      subscriptions: [{ provider: "openai-codex-2", index: 2, label: "second" }],
    }));
    const again = runMigration(freshAgent, join(tmpdir()), { trusted: false });
    assert.equal(again.global, "already");
    assert.equal(again.accountsCreated, 0);
    const cfg = loadGlobalAccountConfig(join(freshAgent, "beautiful-pi.json"));
    assert.equal(cfg.accounts.length, 1, "no second migration pass");
    assert.equal(cfg.accounts[0].label, "first");
  });
});
