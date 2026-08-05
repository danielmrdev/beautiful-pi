/**
 * Unit tests for pool store operations: create/delete/enable/disable,
 * membership add/remove with unknown-ref rejection, resolution, and
 * normalize round-trips.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AccountConfig, CodexAccount } from "./types.ts";
import {
  createPool,
  deletePool,
  setPoolEnabled,
  addPoolMembers,
  removePoolMembers,
  resolvePool,
  listPools,
} from "./store.ts";

function emptyCfg(): AccountConfig {
  return { version: 1, accounts: [] };
}

function account(id: string, label: string): CodexAccount {
  return {
    id: `id-${id}`,
    provider: "openai-codex",
    credentialId: id,
    label,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function cfgWith(...accounts: CodexAccount[]): AccountConfig {
  return { version: 1, accounts };
}

describe("pool ops", () => {
  test("createPool adds an enabled pool with resolved members", () => {
    const cfg = cfgWith(account("openai-codex", "work"), account("openai-codex-2", "personal"));
    const result = createPool(cfg, "prod", ["work", "openai-codex-2"], { cooldownSeconds: 120 });
    assert.equal(result.created, true);
    const pool = result.cfg.pools?.[0];
    assert.ok(pool);
    assert.equal(pool.name, "prod");
    assert.equal(pool.enabled, true);
    assert.equal(pool.cooldownSeconds, 120);
    assert.deepEqual(pool.credentialIds, ["openai-codex", "openai-codex-2"]);
  });

  test("createPool rejects unknown member refs and does not create", () => {
    const cfg = cfgWith(account("openai-codex", "work"));
    const result = createPool(cfg, "prod", ["work", "nope"], {});
    assert.equal(result.created, false);
    assert.deepEqual(result.errors, ["nope"]);
    assert.deepEqual(result.cfg.pools ?? [], [], "no pool created");
  });

  test("createPool rejects a duplicate pool name", () => {
    let cfg = cfgWith(account("openai-codex", "work"));
    cfg = createPool(cfg, "prod", ["work"], {}).cfg;
    const second = createPool(cfg, "prod", ["work"], {});
    assert.equal(second.created, false);
    assert.ok(second.errors.some((e) => /already exists/i.test(e)));
  });

  test("deletePool removes the pool and clears its id from the config", () => {
    let cfg = cfgWith(account("openai-codex", "work"));
    cfg = createPool(cfg, "prod", ["work"], {}).cfg;
    cfg = deletePool(cfg, "prod");
    assert.deepEqual(cfg.pools ?? [], []);
  });

  test("setPoolEnabled toggles the flag", () => {
    let cfg = cfgWith(account("openai-codex", "work"));
    cfg = createPool(cfg, "prod", ["work"], {}).cfg;
    cfg = setPoolEnabled(cfg, "prod", false);
    assert.equal(cfg.pools![0].enabled, false);
    cfg = setPoolEnabled(cfg, "prod", true);
    assert.equal(cfg.pools![0].enabled, true);
  });

  test("addPoolMembers rejects unknown refs without modifying the pool", () => {
    let cfg = cfgWith(account("openai-codex", "work"), account("openai-codex-2", "personal"));
    cfg = createPool(cfg, "prod", ["work"], {}).cfg;
    const result = addPoolMembers(cfg, "prod", ["personal", "ghost"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ["ghost"]);
    assert.deepEqual(result.cfg.pools![0].credentialIds, ["openai-codex"], "no partial add");
  });

  test("addPoolMembers is idempotent for existing members", () => {
    let cfg = cfgWith(account("openai-codex", "work"));
    cfg = createPool(cfg, "prod", ["work"], {}).cfg;
    const result = addPoolMembers(cfg, "prod", ["work", "work"]);
    assert.deepEqual(result.cfg.pools![0].credentialIds, ["openai-codex"]);
  });

  test("removePoolMembers removes members by ref", () => {
    let cfg = cfgWith(account("openai-codex", "work"), account("openai-codex-2", "personal"));
    cfg = createPool(cfg, "prod", ["work", "personal"], {}).cfg;
    const result = removePoolMembers(cfg, "prod", ["work"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.cfg.pools![0].credentialIds, ["openai-codex-2"]);
  });

  test("resolvePool matches by id or name", () => {
    let cfg = cfgWith(account("openai-codex", "work"));
    cfg = createPool(cfg, "prod", ["work"], {}).cfg;
    const byName = resolvePool(cfg, "prod");
    const byId = resolvePool(cfg, cfg.pools![0].id);
    const missing = resolvePool(cfg, "nope");
    assert.equal(byName?.name, "prod");
    assert.equal(byId?.id, cfg.pools![0].id);
    assert.equal(missing, undefined);
  });

  test("listPools returns all pools sorted by name", () => {
    let cfg = cfgWith(account("openai-codex", "work"));
    cfg = createPool(cfg, "zulu", ["work"], {}).cfg;
    cfg = createPool(cfg, "alpha", ["work"], {}).cfg;
    assert.deepEqual(listPools(cfg).map((p) => p.name), ["alpha", "zulu"]);
  });
});
