/**
 * Tests for settings.ts fixes:
 * 1. saveSettings deletes stale file when reverting to defaults
 * 2. loadSettings caches results to avoid repeated disk reads
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpHome: string;
let userSettingsPath: string;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "beautiful-pi-test-"));
  userSettingsPath = join(tmpHome, ".pi", "agent", "beautiful-pi.json");
  mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
  // Override HOME so the module resolves USER_SETTINGS_PATH to our temp dir
  process.env["HOME"] = tmpHome;
});

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Dynamic import helper (re-imports with fresh module cache) ────────────────

async function freshSettings() {
  // Clear module cache to get a fresh module state (resets cache vars)
  // tsx uses a different cache key — use ?v= trick
  const v = Date.now() + Math.random();
  const mod = await import(`./settings.ts?v=${v}`);
  return mod as typeof import("./settings");
}

// ── Issue 1: saveSettings deletes stale file when reverting to defaults ───────

describe("saveSettings - stale file deletion", () => {
  beforeEach(() => {
    // Ensure settings file does not exist before each test
    try { rmSync(userSettingsPath); } catch { /* ok */ }
  });

  test("deletes the user settings file when all values match defaults", async () => {
    const { saveSettings, loadSettings } = await freshSettings();

    // First, write a non-default value so the file exists
    const defaults = loadSettings();
    const modified = { ...defaults, indentLevel: 8 };
    saveSettings(modified);
    assert.ok(existsSync(userSettingsPath), "file should exist after saving non-default");

    // Now revert to defaults — file should be deleted
    saveSettings(defaults);
    assert.equal(existsSync(userSettingsPath), false, "file should be deleted when all values are defaults");
  });

  test("does not throw when file does not exist and all values match defaults", async () => {
    const { saveSettings, loadSettings } = await freshSettings();
    const defaults = loadSettings();

    assert.doesNotThrow(() => saveSettings(defaults));
    assert.equal(existsSync(userSettingsPath), false);
  });

  test("still writes file when some values differ from defaults", async () => {
    const { saveSettings, loadSettings } = await freshSettings();
    const defaults = loadSettings();

    saveSettings({ ...defaults, indentLevel: 2 });
    assert.ok(existsSync(userSettingsPath), "file should exist when a value differs");
  });
});

// ── Issue 2: loadSettings caches results within TTL ───────────────────────────

describe("loadSettings - caching", () => {
  beforeEach(() => {
    try { rmSync(userSettingsPath); } catch { /* ok */ }
  });

  test("returns the same object reference within cache TTL (no re-read)", async () => {
    const { loadSettings } = await freshSettings();

    const first = loadSettings();
    const second = loadSettings();

    // Same reference means cached — no second disk read
    assert.equal(first, second, "loadSettings should return cached result within TTL");
  });

  test("invalidateSettingsCache forces a fresh read on next call", async () => {
    const { loadSettings, saveSettings, invalidateSettingsCache } = await freshSettings();

    const before = loadSettings(); // primes cache
    assert.equal(before.indentLevel, loadSettings().indentLevel);

    // Write a new file externally, then invalidate
    writeFileSync(userSettingsPath, JSON.stringify({ indentLevel: 99 }) + "\n");
    invalidateSettingsCache();

    const after = loadSettings();
    assert.equal(after.indentLevel, 99, "should reflect new file after invalidation");
  });

  test("saveSettings invalidates the cache so next loadSettings reflects changes", async () => {
    const { loadSettings, saveSettings } = await freshSettings();

    const defaults = loadSettings();
    saveSettings({ ...defaults, indentLevel: 7 });
    const updated = loadSettings();

    assert.equal(updated.indentLevel, 7, "loadSettings should see saved change immediately");
  });
});
