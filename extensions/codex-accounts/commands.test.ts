/**
 * Command surface tests: /codex account <sub> handlers against a fake pi and
 * fake context (isolated HOME). Exercises add/login/logout/remove/switch/
 * list/status/migrate behavior.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakePi } from "../test-helpers.ts";
import { registerCodexCommand } from "./commands.ts";
import { loadGlobalAccountConfig } from "./store.ts";

let tmpHome: string;
let tmpProject: string;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-cmd-test-"));
  tmpProject = mkdtempSync(join(tmpdir(), "bpi-cmd-proj-"));
  mkdirSync(join(tmpProject, ".pi"), { recursive: true });
  process.env["HOME"] = tmpHome;
});

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

// Isolate each test from accounts left behind by earlier tests.
beforeEach(() => {
  rmSync(join(tmpHome, ".pi", "agent", "beautiful-pi.json"), { force: true });
  rmSync(join(tmpHome, ".pi", "agent", "auth.json"), { force: true });
});

interface FakeEnv {
  ctx: any;
  notifications: Array<{ msg: string; type?: string }>;
  registered: string[];
  unregistered: string[];
  setModelCalls: any[];
  sent: any[];
  auth: Record<string, { configured: boolean }>;
  models: any[];
}

function makeEnv(): FakeEnv & { handler: (args: string) => Promise<void> } {
  const pi: any = fakePi();
  const env: FakeEnv = {
    ctx: null as any,
    notifications: [],
    registered: [],
    unregistered: [],
    setModelCalls: [],
    sent: [],
    auth: {},
    models: [],
  };
  pi.setModel = async (model: any) => {
    env.setModelCalls.push(model);
    return true;
  };
  pi.sendMessage = (msg: any) => { env.sent.push(msg); };
  registerCodexCommand(pi);

  env.ctx = {
    hasUI: true,
    cwd: tmpProject,
    ui: {
      notify: (msg: string, type?: string) => env.notifications.push({ msg, type }),
      input: async () => "typed label",
      confirm: async () => true,
    },
    modelRegistry: {
      getProviderAuthStatus: (id: string) => env.auth[id] ?? { configured: false },
      getAll: () => env.models,
      hasConfiguredAuth: (m: any) => env.auth[m.provider]?.configured === true,
      registerProvider: (p: any) => { env.registered.push(p.id); },
      unregisterProvider: (id: string) => { env.unregistered.push(id); },
    },
    isProjectTrusted: () => true,
  };

  const handler = pi.commands.get("codex")?.handler as ((args: string, ctx: any) => Promise<void>);
  assert.ok(handler, "/codex command registered");
  (env as any).handler = (args: string) => handler(args, env.ctx);
  return env as FakeEnv & { handler: (args: string) => Promise<void> };
}

const lastNotify = (env: FakeEnv) => env.notifications[env.notifications.length - 1]?.msg ?? "";

describe("/codex account add", () => {
  test("adds an account, allocates a suffixed id, registers the provider", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    assert.equal(env.registered[0], "openai-codex-2", "provider registered for /login");
    const cfg = loadGlobalAccountConfig();
    assert.equal(cfg.accounts.length, 1);
    assert.equal(cfg.accounts[0].label, "work");
    assert.equal(cfg.accounts[0].credentialId, "openai-codex-2");
    assert.equal(cfg.activeAccountId, cfg.accounts[0].id, "first account becomes active");
    assert.ok(lastNotify(env).includes("/login openai-codex-2"), "login hint in notification");
  });

  test("prompts for label when omitted", async () => {
    const env = makeEnv();
    await env.handler("account add");
    const cfg = loadGlobalAccountConfig();
    assert.equal(cfg.accounts[cfg.accounts.length - 1].label, "typed label");
  });

  test("allocates the next free suffix", async () => {
    const env = makeEnv();
    await env.handler("account add one");
    await env.handler("account add two");
    const cfg = loadGlobalAccountConfig();
    assert.deepEqual(
      cfg.accounts.map((a) => a.credentialId).sort(),
      ["openai-codex-2", "openai-codex-3"],
    );
  });

  test("avoids colliding with a credential already in auth.json", async () => {
    // Simulate a credential created by a manual /login with no account entry.
    writeFileSync(join(tmpHome, ".pi", "agent", "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth" },
      "openai-codex-2": { type: "oauth" },
    }));
    const env = makeEnv();
    await env.handler("account add work");
    const cfg = loadGlobalAccountConfig();
    assert.equal(cfg.accounts[0].credentialId, "openai-codex-3", "skips id used by auth.json");
    rmSync(join(tmpHome, ".pi", "agent", "auth.json"), { force: true });
  });
});

describe("/codex account login/logout", () => {
  test("login shows the /login command when not authenticated", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account login work");
    assert.ok(lastNotify(env).includes("/login openai-codex-2"));
  });

  test("login confirms when already authenticated", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    env.auth["openai-codex-2"] = { configured: true };
    await env.handler("account login work");
    assert.ok(lastNotify(env).includes("already authenticated"));
  });

  test("logout instructs /logout when authenticated", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    env.auth["openai-codex-2"] = { configured: true };
    await env.handler("account logout work");
    assert.ok(lastNotify(env).includes("/logout openai-codex-2"));
  });

  test("logout reports not authenticated otherwise", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account logout work");
    assert.ok(lastNotify(env).includes("not authenticated"));
  });
});

describe("/codex account remove", () => {
  test("removes config entry, unregisters suffixed provider, keeps credential", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account remove work");
    const cfg = loadGlobalAccountConfig();
    assert.equal(cfg.accounts.length, 0, "config entry removed");
    assert.deepEqual(env.unregistered, ["openai-codex-2"], "suffixed provider unregistered");
    assert.ok(lastNotify(env).includes("/logout"), "credential removal hint");
  });

  test("never unregisters the base openai-codex provider", async () => {
    const env = makeEnv();
    env.auth["openai-codex"] = { configured: true };
    await env.handler("account remove openai-codex");
    assert.deepEqual(env.unregistered, [], "base provider untouched");
  });
});

describe("/codex account switch", () => {
  test("switches the active model to the account provider", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    env.models = [{ id: "gpt-5.5", provider: "openai-codex-2" }];
    env.auth["openai-codex-2"] = { configured: true };
    await env.handler("account switch work");
    assert.equal(env.setModelCalls.length, 1);
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2");
    const cfg = loadGlobalAccountConfig();
    assert.equal(cfg.activeAccountId, cfg.accounts[0].id, "active account recorded");
    assert.ok(lastNotify(env).includes("Switched"));
  });

  test("warns and does not switch when not authenticated", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    env.models = [{ id: "gpt-5.5", provider: "openai-codex-2" }];
    await env.handler("account switch work");
    assert.equal(env.setModelCalls.length, 0);
    assert.ok(lastNotify(env).includes("Authenticate"), "auth hint shown");
  });
});

describe("/codex account list/status", () => {
  test("list sends a codex-accounts custom message with rows", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    env.auth["openai-codex-2"] = { configured: true };
    await env.handler("account list");
    const sent = env.sent[env.sent.length - 1];
    assert.equal(sent.customType, "codex-accounts");
    assert.ok(sent.content.includes("work"));
    assert.ok(sent.content.includes("openai-codex-2"));
    assert.ok(sent.content.includes("authenticated"));
  });

  test("status reports detail lines", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account status work");
    const sent = env.sent[env.sent.length - 1];
    assert.ok(sent.content.includes("Account: work"));
    assert.ok(sent.content.includes("credential:"));
    assert.ok(sent.content.includes("/login openai-codex-2"));
  });
});

describe("/codex account migrate + usage", () => {
  test("migrate runs and reports summary via custom message", async () => {
    const env = makeEnv();
    await env.handler("account migrate");
    const sent = env.sent[env.sent.length - 1];
    assert.equal(sent.customType, "codex-accounts");
    assert.ok(sent.content.includes("global:"));
  });

  test("unknown subcommand shows usage", async () => {
    const env = makeEnv();
    await env.handler("account bogus");
    assert.ok(lastNotify(env).includes("/codex account"));
  });

  test("unknown section shows usage", async () => {
    const env = makeEnv();
    await env.handler("bogus list");
    assert.ok(lastNotify(env).includes("subcommand"));
  });
});

describe("/codex pool", () => {
  /** Mark every current account as authenticated + provide models. */
  function authenticateAll(env: FakeEnv): void {
    const cfg = loadGlobalAccountConfig();
    env.models = cfg.accounts.map((a) => ({ provider: a.credentialId, id: "gpt-5.5" }));
    env.auth = Object.fromEntries(cfg.accounts.map((a) => [a.credentialId, { configured: true }]));
  }

  test("create rejects unauthenticated members and creates once authenticated", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account add personal");
    await env.handler("pool create prod work personal");
    assert.ok(lastNotify(env).includes("not authenticated"), "unavailable members rejected clearly");
    assert.equal(env.notifications.at(-1)?.type, "error");
    assert.equal(loadGlobalAccountConfig().pools?.length ?? 0, 0, "no pool created");

    authenticateAll(env);
    await env.handler("pool create prod work personal");
    const after = loadGlobalAccountConfig();
    assert.equal(after.pools?.length, 1);
    assert.equal(after.pools![0].name, "prod");
    assert.deepEqual(after.pools![0].credentialIds, ["openai-codex-2", "openai-codex-3"]);
    assert.ok(lastNotify(env).includes("Created pool \"prod\""));
  });

  test("create rejects unknown members without creating", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("pool create prod work ghost");
    assert.ok(lastNotify(env).includes("ghost"));
    assert.equal(env.notifications.at(-1)?.type, "error");
    assert.equal(loadGlobalAccountConfig().pools?.length ?? 0, 0);
  });

  test("list reports pools with members", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    authenticateAll(env);
    await env.handler("pool create prod work");
    await env.handler("pool list");
    const sent = env.sent[env.sent.length - 1];
    assert.ok(sent.content.includes("prod"));
    assert.ok(sent.content.includes("work"));
  });

  test("inspect shows per-member status", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    authenticateAll(env);
    await env.handler("pool create prod work");
    await env.handler("pool inspect prod");
    const sent = env.sent[env.sent.length - 1];
    assert.ok(sent.content.includes("Pool: prod"));
    assert.ok(sent.content.includes("cooldown:"));
  });

  test("enable/disable toggle the pool", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    authenticateAll(env);
    await env.handler("pool create prod work");
    await env.handler("pool disable prod");
    assert.equal(loadGlobalAccountConfig().pools![0].enabled, false);
    await env.handler("pool enable prod");
    assert.equal(loadGlobalAccountConfig().pools![0].enabled, true);
  });

  test("add rejects unauthenticated members and adds once authenticated", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account add personal");
    authenticateAll(env);
    await env.handler("pool create prod work");

    env.auth["openai-codex-3"] = { configured: false };
    await env.handler("pool add prod personal");
    assert.ok(lastNotify(env).includes("not authenticated"));
    assert.deepEqual(loadGlobalAccountConfig().pools![0].credentialIds, ["openai-codex-2"], "member not added");

    env.auth["openai-codex-3"] = { configured: true };
    await env.handler("pool add prod personal");
    assert.deepEqual(loadGlobalAccountConfig().pools![0].credentialIds, ["openai-codex-2", "openai-codex-3"]);
    await env.handler("pool remove prod personal");
    assert.deepEqual(loadGlobalAccountConfig().pools![0].credentialIds, ["openai-codex-2"]);
  });

  test("delete removes the pool", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    authenticateAll(env);
    await env.handler("pool create prod work");
    await env.handler("pool delete prod");
    assert.equal(loadGlobalAccountConfig().pools?.length ?? 0, 0);
  });

  test("use round-robin activates the next eligible member and advances the pointer", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    await env.handler("account add personal");
    authenticateAll(env);
    await env.handler("pool create prod work personal");

    await env.handler("pool use prod");
    let cfg = loadGlobalAccountConfig();
    assert.equal(env.setModelCalls.length, 1);
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2", "first eligible member");
    assert.equal(cfg.pools![0].lastUsedIndex, 0);
    assert.equal(cfg.activeAccountId, cfg.accounts.find((a) => a.credentialId === "openai-codex-2")?.id);

    await env.handler("pool use prod");
    cfg = loadGlobalAccountConfig();
    assert.equal(env.setModelCalls[1].provider, "openai-codex-3", "rotates to the next member");
    assert.equal(cfg.pools![0].lastUsedIndex, 1);
  });

  test("use with no eligible member warns without switching", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    authenticateAll(env);
    await env.handler("pool create prod work");
    env.auth = {}; // member becomes unavailable again
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls.length, 0);
    assert.ok(lastNotify(env).includes("No eligible member"));
  });

  test("use on a disabled pool is blocked", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    authenticateAll(env);
    await env.handler("pool create prod work");
    await env.handler("pool disable prod");
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls.length, 0);
    assert.ok(lastNotify(env).includes("disabled"));
  });

  test("pool subcommand errors notify clearly", async () => {
    const env = makeEnv();
    await env.handler("pool use nope");
    assert.ok(lastNotify(env).includes("not found"));
  });
});

describe("/codex account quota", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  function stubUsage(usedPercent: number): void {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        rate_limit: {
          primary_window: { limit_window_seconds: 5 * 3600, used_percent: usedPercent, reset_at: Math.floor(Date.now() / 1000) + 3600 },
        },
      }),
    })) as unknown as typeof fetch;
  }

  function writeCredential(id: string): void {
    const dir = join(tmpHome, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ [id]: { type: "oauth", access: "tok", expires: Math.floor(Date.now() / 1000) + 7200 } }));
  }

  test("reports quota windows for authenticated accounts", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    writeCredential("openai-codex-2");
    stubUsage(32);
    await env.handler("account quota");
    const sent = env.sent[env.sent.length - 1];
    assert.equal(sent.customType, "codex-accounts");
    assert.ok(sent.content.includes("work"));
    assert.ok(sent.content.includes("5h 32% used"), "window usage shown");
    assert.ok(sent.content.includes("healthy"));
  });

  test("reports an actionable reason when no credential exists", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    let called = false;
    globalThis.fetch = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
    await env.handler("account quota");
    const sent = env.sent[env.sent.length - 1];
    assert.ok(sent.content.includes("unavailable: not authenticated"));
    assert.equal(called, false, "no fetch without a credential");
  });

  test("network failures surface as unavailable without breaking the command", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    writeCredential("openai-codex-2");
    globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    await env.handler("account quota");
    const sent = env.sent[env.sent.length - 1];
    assert.ok(sent.content.includes("unavailable: usage endpoint unreachable"));
  });

  test("project-restricted accounts are reported without fetching", async () => {
    const env = makeEnv();
    await env.handler("account add work");
    const restricted = join(tmpProject, "..", "other-proj");
    const dir = join(tmpHome, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    const originalCwd = env.ctx.cwd;
    env.ctx.cwd = restricted;
    const projDir = join(restricted, ".pi");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "beautiful-pi.json"), JSON.stringify({ accounts: { allowedCredentialIds: ["openai-codex"] } }));
    let called = false;
    globalThis.fetch = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
    await env.handler("account quota");
    const sent = env.sent[env.sent.length - 1];
    assert.ok(sent.content.includes("restricted in this project"));
    assert.equal(called, false);
    env.ctx.cwd = originalCwd;
  });
});

describe("/codex pool strategy/schedule/selector", () => {
  async function withPool(env: FakeEnv & { handler: (a: string) => Promise<void> }): Promise<void> {
    await env.handler("account add work");
    await env.handler("account add personal");
    env.auth["openai-codex-2"] = { configured: true };
    env.auth["openai-codex-3"] = { configured: true };
    await env.handler("pool create prod work personal");
  }

  test("strategy sets and persists the pool strategy", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod quota-first");
    assert.equal(loadGlobalAccountConfig().pools![0].strategy, "quota-first");
    await env.handler("pool strategy prod round-robin");
    assert.equal(loadGlobalAccountConfig().pools![0].strategy, undefined, "round-robin is the implicit default");
  });

  test("strategy rejects unknown values", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod quantum");
    assert.ok(lastNotify(env).includes("invalid strategy"));
  });

  test("scheduled without a schedule warns to configure one", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod scheduled");
    assert.ok(env.notifications.some((n) => n.msg.includes("/codex pool schedule prod")), "setup hint shown");
  });

  test("custom without a selector warns to configure one", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod custom");
    assert.ok(env.notifications.some((n) => n.msg.includes("/codex pool selector prod")), "setup hint shown");
  });

  test("schedule parses windows, days, dates, and roles", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool schedule prod 09:00-17:00,21:00-23:00 days mon-fri from 2026-01-01 to 2026-12-31 roles work=primary personal=backup");
    const pool = loadGlobalAccountConfig().pools![0];
    assert.deepEqual(pool.schedule?.days, [1, 2, 3, 4, 5]);
    assert.deepEqual(pool.schedule?.dateRange, { start: "2026-01-01", end: "2026-12-31" });
    assert.deepEqual(pool.schedule?.memberRoles, { "openai-codex-2": "primary", "openai-codex-3": "backup" });
    assert.ok(lastNotify(env).includes("Schedule for pool"));
  });

  test("schedule rejects bad windows, days, and roles without saving", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool schedule prod 25:99-17:00");
    assert.ok(lastNotify(env).includes("invalid time window"));
    await env.handler("pool schedule prod 09:00-17:00 days xyz");
    assert.ok(lastNotify(env).includes("unknown day"));
    await env.handler("pool schedule prod 09:00-17:00 roles stranger=primary");
    assert.ok(lastNotify(env).includes("unknown member"));
    await env.handler("pool schedule prod 09:00-17:00 roles work=king");
    assert.ok(lastNotify(env).includes("invalid role"));
    const pool = loadGlobalAccountConfig().pools![0];
    assert.equal(pool.schedule, undefined, "no partial schedule persisted");
  });

  test("schedule clear removes the schedule", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool schedule prod 09:00-17:00");
    assert.ok(loadGlobalAccountConfig().pools![0].schedule);
    await env.handler("pool schedule clear prod");
    assert.equal(loadGlobalAccountConfig().pools![0].schedule, undefined);
  });

  test("selector stores a command and clear removes it", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool selector prod ./pick.sh --json");
    assert.equal(loadGlobalAccountConfig().pools![0].selector, "./pick.sh --json");
    await env.handler("pool selector clear prod");
    assert.equal(loadGlobalAccountConfig().pools![0].selector, undefined);
  });
});

describe("/codex pool use with strategies", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  function stubUsageByAccount(map: Record<string, number>): void {
    globalThis.fetch = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      const token = init.headers["Authorization"].replace("Bearer ", "");
      const used = map[token] ?? 50;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          rate_limit: {
            primary_window: { limit_window_seconds: 5 * 3600, used_percent: used, reset_at: Math.floor(Date.now() / 1000) + 3600 },
          },
        }),
      };
    }) as unknown as typeof fetch;
  }

  function writeCredential(id: string, token: string): void {
    const dir = join(tmpHome, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "auth.json");
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(require("node:fs").readFileSync(path, "utf-8")); } catch {}
    existing[id] = { type: "oauth", access: token, expires: Math.floor(Date.now() / 1000) + 7200 };
    require("node:fs").writeFileSync(path, JSON.stringify(existing));
  }

  async function withPool(env: FakeEnv & { handler: (a: string) => Promise<void> }): Promise<void> {
    await env.handler("account add work");
    await env.handler("account add personal");
    env.auth["openai-codex-2"] = { configured: true };
    env.auth["openai-codex-3"] = { configured: true };
    await env.handler("pool create prod work personal");
    env.models = [
      { id: "gpt-5.5", provider: "openai-codex-2" },
      { id: "gpt-5.5", provider: "openai-codex-3" },
    ];
  }

  test("round-robin is the default and rotates to the next member", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool use prod");
    const cfg = loadGlobalAccountConfig();
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2", "fresh pool starts at the first member");
    assert.equal(cfg.pools![0].lastUsedIndex, 0, "pointer advanced to the used member");
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls[1].provider, "openai-codex-3", "second use rotates forward");
    assert.equal(loadGlobalAccountConfig().pools![0].lastUsedIndex, 1);
  });

  test("quota-first picks the healthiest account", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod quota-first");
    // work has 90% used (health 10), personal 10% used (health 90)
    writeCredential("openai-codex-2", "tok-work");
    writeCredential("openai-codex-3", "tok-personal");
    stubUsageByAccount({ "tok-work": 90, "tok-personal": 10 });
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-3", "healthiest member activated");
    assert.ok(lastNotify(env).includes("personal"));
  });

  test("quota-first falls back to round-robin when no quota data exists", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod quota-first");
    // no auth.json credentials → every report unauthenticated → no quota data
    stubUsageByAccount({});
    await env.handler("pool use prod");
    assert.ok(
      env.notifications.some((n) => n.msg.includes("fell back to round-robin")),
      "fallback warning shown (before the success notify)",
    );
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2", "still routes deterministically");
  });

  test("quota-first warns when every account is exhausted but still routes", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod quota-first");
    writeCredential("openai-codex-2", "tok-work");
    writeCredential("openai-codex-3", "tok-personal");
    stubUsageByAccount({ "tok-work": 100, "tok-personal": 100 });
    await env.handler("pool use prod");
    assert.ok(env.notifications.some((n) => n.msg.includes("every account is at quota")), "exhaustion warning shown");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2", "round-robin fallback still routes");
  });

  test("scheduled prefers the primary member inside the window", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod scheduled");
    await env.handler("pool schedule prod 00:00-23:59 roles personal=primary work=backup");
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-3", "primary (personal) selected over backup");
  });

  test("scheduled degrades to round-robin outside the window", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod scheduled");
    const hour = new Date().getHours();
    const farStart = String((hour + 2) % 24).padStart(2, "0") + ":00";
    const farEnd = String((hour + 3) % 24).padStart(2, "0") + ":00";
    await env.handler(`pool schedule prod ${farStart}-${farEnd} roles personal=primary work=backup`);
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2", "backup used when schedule inactive");
  });

  test("custom selector picks the member it outputs", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod custom");
    await env.handler("pool selector prod echo openai-codex-2");
    await env.handler("pool use prod");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2");
    assert.ok(lastNotify(env).includes("work"));
  });

  test("custom selector falls back when it returns an ineligible member", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod custom");
    await env.handler("pool selector prod echo ghost");
    await env.handler("pool use prod");
    assert.ok(env.notifications.some((n) => n.msg.includes("ineligible member")), "fallback warning shown");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2", "round-robin fallback still routes");
  });

  test("custom selector falls back when no selector is configured", async () => {
    const env = makeEnv();
    await withPool(env);
    await env.handler("pool strategy prod custom");
    await env.handler("pool use prod");
    assert.ok(env.notifications.some((n) => n.msg.includes("no selector configured")), "warning shown");
    assert.equal(env.setModelCalls[0].provider, "openai-codex-2");
  });
});
