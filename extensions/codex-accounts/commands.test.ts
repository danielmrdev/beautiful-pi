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

  test("non-account section shows usage", async () => {
    const env = makeEnv();
    await env.handler("pool list");
    assert.ok(lastNotify(env).includes("subcommand"));
  });
});
