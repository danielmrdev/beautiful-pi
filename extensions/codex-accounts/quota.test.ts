/**
 * Unit tests for Codex quota: normalization into deterministic status /
 * headroom / reset data, and per-account fetch classification (missing or
 * expired credentials, HTTP failures, malformed bodies) with a stubbed fetch.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeAccountQuota,
  fetchAccountQuotaReport,
  formatAccountQuota,
  formatUnavailableReason,
  type AccountQuota,
} from "./quota.ts";
import type { CodexAccount } from "./types.ts";
import type { OpenAIUsage } from "../shared/openai-usage.ts";

let tmpHome: string;
let originalFetch: typeof globalThis.fetch;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-quota-test-"));
  process.env["HOME"] = tmpHome;
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(tmpHome, ".pi"), { recursive: true, force: true });
});

function account(id = "openai-codex"): CodexAccount {
  return {
    id: `id-${id}`,
    provider: "openai-codex",
    credentialId: id,
    label: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function writeCredential(id: string, credential: Record<string, unknown>): void {
  const dir = join(tmpHome, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "auth.json");
  const existing: Record<string, unknown> = {};
  try {
    Object.assign(existing, JSON.parse(require("node:fs").readFileSync(path, "utf-8")));
  } catch {
    // first credential
  }
  existing[id] = credential;
  require("node:fs").writeFileSync(path, JSON.stringify(existing));
}

function stubFetch(
  fn: () => { status: number; body: unknown } | Error,
): void {
  globalThis.fetch = (() => {
    const outcome = fn();
    if (outcome instanceof Error) return Promise.reject(outcome);
    const { status, body } = outcome;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response);
  }) as typeof fetch;
}

// Future-relative base time so expiry checks behave regardless of the machine clock.
const NOW = Date.now() + 90 * 24 * 3600 * 1000;

function usage(fiveHour: Partial<{ used: number; resetAt: number; resetAfter: number }> = {}, sevenDay: Partial<{ used: number; resetAt: number; resetAfter: number }> = {}): OpenAIUsage {
  return {
    ...(fiveHour.used !== undefined
      ? { fiveHour: { usedPercent: fiveHour.used, windowSeconds: 5 * 3600, ...(fiveHour.resetAt !== undefined ? { resetAt: fiveHour.resetAt } : {}), ...(fiveHour.resetAfter !== undefined ? { resetAfterSeconds: fiveHour.resetAfter } : {}) } }
      : {}),
    ...(sevenDay.used !== undefined
      ? { sevenDay: { usedPercent: sevenDay.used, windowSeconds: 7 * 86400, ...(sevenDay.resetAt !== undefined ? { resetAt: sevenDay.resetAt } : {}), ...(sevenDay.resetAfter !== undefined ? { resetAfterSeconds: sevenDay.resetAfter } : {}) } }
      : {}),
  };
}

describe("normalizeAccountQuota", () => {
  test("healthy status with health = min headroom across windows", () => {
    const q = normalizeAccountQuota(usage({ used: 32 }, { used: 18 }));
    assert.ok(q);
    assert.equal(q!.status, "healthy");
    assert.equal(q!.health, 68, "min(100-32, 100-18)");
    assert.equal(q!.fiveHour?.remainingHeadroom, 68);
    assert.equal(q!.sevenDay?.remainingHeadroom, 82);
  });

  test("low when any window reaches 80% used", () => {
    const q = normalizeAccountQuota(usage({ used: 85 }));
    assert.ok(q);
    assert.equal(q!.status, "low");
    assert.equal(q!.health, 15);
  });

  test("exhausted when any window hits 100% used", () => {
    const q = normalizeAccountQuota(usage({ used: 100 }));
    assert.ok(q);
    assert.equal(q!.status, "exhausted");
    assert.equal(q!.health, 0);
  });

  test("headroom clamps to 0 for over-100 reports", () => {
    const q = normalizeAccountQuota(usage({ used: 130 }));
    assert.ok(q);
    assert.equal(q!.status, "exhausted");
    assert.equal(q!.health, 0);
  });

  test("health is driven by the most constrained window", () => {
    const q = normalizeAccountQuota(usage({ used: 90 }, { used: 50 }));
    assert.ok(q);
    assert.equal(q!.health, 10, "5h window binds even though 7d has headroom");
    assert.equal(q!.status, "low");
  });

  test("null usage yields null", () => {
    assert.equal(normalizeAccountQuota(null), null);
  });

  test("usage without any window yields null", () => {
    assert.equal(normalizeAccountQuota({}), null);
  });

  test("reset data is preserved", () => {
    const resetAt = Math.floor(NOW / 1000) + 7200;
    const q = normalizeAccountQuota(usage({ used: 40, resetAt }, { used: 10, resetAfter: 3 * 86400 }));
    assert.ok(q);
    assert.equal(q!.fiveHour?.resetAt, resetAt);
    assert.equal(q!.sevenDay?.resetAfterSeconds, 3 * 86400);
  });
});

describe("fetchAccountQuotaReport", () => {
  test("reports unauthenticated without a stored credential (no fetch)", async () => {
    let called = false;
    stubFetch(() => { called = true; return { status: 200, body: {} }; });
    const report = await fetchAccountQuotaReport(account());
    assert.equal(report.unavailableReason, "unauthenticated");
    assert.equal(report.quota, undefined);
    assert.equal(called, false, "no network call for a missing credential");
  });

  test("reports expired without a network round-trip", async () => {
    writeCredential("openai-codex", { type: "oauth", access: "tok", expires: Math.floor(Date.now() / 1000) - 60 });
    let called = false;
    stubFetch(() => { called = true; return { status: 200, body: {} }; });
    const report = await fetchAccountQuotaReport(account());
    assert.equal(report.unavailableReason, "expired");
    assert.equal(called, false);
  });

  test("unauthorized response classifies as unauthorized", async () => {
    writeCredential("openai-codex", { type: "oauth", access: "tok", expires: Math.floor(NOW / 1000) + 3600 });
    stubFetch(() => ({ status: 401, body: {} }));
    const report = await fetchAccountQuotaReport(account());
    assert.equal(report.unavailableReason, "unauthorized");
  });

  test("HTTP error classifies as http", async () => {
    writeCredential("openai-codex", { type: "oauth", access: "tok", expires: Math.floor(NOW / 1000) + 3600 });
    stubFetch(() => ({ status: 503, body: {} }));
    const report = await fetchAccountQuotaReport(account());
    assert.equal(report.unavailableReason, "http");
  });

  test("network failure classifies as network", async () => {
    writeCredential("openai-codex", { type: "oauth", access: "tok", expires: Math.floor(NOW / 1000) + 3600 });
    stubFetch(() => new Error("ECONNRESET"));
    const report = await fetchAccountQuotaReport(account());
    assert.equal(report.unavailableReason, "network");
  });

  test("2xx body without recognizable windows classifies as malformed", async () => {
    writeCredential("openai-codex", { type: "oauth", access: "tok", expires: Math.floor(NOW / 1000) + 3600 });
    stubFetch(() => ({ status: 200, body: { hello: "world" } }));
    const report = await fetchAccountQuotaReport(account());
    assert.equal(report.unavailableReason, "malformed");
  });

  test("valid response normalizes into quota data", async () => {
    writeCredential("openai-codex", { type: "oauth", access: "tok", expires: Math.floor(NOW / 1000) + 3600 });
    stubFetch(() => ({
      status: 200,
      body: {
        rate_limit: {
          primary_window: { limit_window_seconds: 5 * 3600, used_percent: 30, reset_at: Math.floor(NOW / 1000) + 3600 },
          secondary_window: { limit_window_seconds: 7 * 86400, used_percent: 12 },
        },
      },
    }));
    const report = await fetchAccountQuotaReport(account());
    assert.ok(report.quota);
    assert.equal(report.quota!.status, "healthy");
    assert.equal(report.quota!.fiveHour?.usedPercent, 30);
    assert.equal(report.quota!.health, 70);
    assert.equal(report.unavailableReason, undefined);
  });

  test("api-key credentials use the key as the bearer token", async () => {
    writeCredential("custom-provider", { type: "api_key", key: "sk-123" });
    let sawAuth = "";
    globalThis.fetch = (async (url: unknown, init: { headers: Record<string, string> }) => {
      sawAuth = init.headers["Authorization"];
      return { ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: { limit_window_seconds: 5 * 3600, used_percent: 5 } } }) } as unknown as Response;
    }) as typeof fetch;
    const report = await fetchAccountQuotaReport({ ...account("custom-provider"), provider: "custom" });
    assert.equal(sawAuth, "Bearer sk-123");
    assert.ok(report.quota);
  });
});

describe("formatting", () => {
  test("formatAccountQuota summarizes status and windows", () => {
    const quota: AccountQuota = {
      status: "healthy",
      health: 70,
      fiveHour: { windowSeconds: 5 * 3600, usedPercent: 30, remainingHeadroom: 70 },
      sevenDay: { windowSeconds: 7 * 86400, usedPercent: 12, remainingHeadroom: 88 },
    };
    const line = formatAccountQuota(quota, NOW);
    assert.match(line, /healthy/);
    assert.match(line, /5h 30% used/);
    assert.match(line, /7d 12% used/);
  });

  test("formatUnavailableReason is actionable", () => {
    assert.match(formatUnavailableReason("expired"), /re-login/);
    assert.match(formatUnavailableReason("network"), /unreachable/);
    assert.match(formatUnavailableReason("unauthenticated"), /not authenticated/);
  });
});
