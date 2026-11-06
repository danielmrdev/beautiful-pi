import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakePi, type FakePi } from "../test-helpers.ts";

const ORIGINAL_ENV = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HC_TERMINAL_ID: process.env.HC_TERMINAL_ID,
};

interface HerdrFakePi extends FakePi {
  execCalls: Array<[string, string[]]>;
}

function herdrPi(): HerdrFakePi {
  const pi = fakePi() as HerdrFakePi;
  const execCalls: Array<[string, string[]]> = [];
  pi.exec = (_cmd: string, args: string[]) => {
    execCalls.push([_cmd, args]);
    return Promise.resolve({ code: 0 } as any);
  };
  pi.execCalls = execCalls;
  return pi;
}

function useHerdrApp(): void {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  process.env.HC_TERMINAL_ID = "t-app";
}

describe("herdr pane sync extension", () => {
  beforeEach(() => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w9:pB";
    delete process.env.HC_TERMINAL_ID;
  });

  afterEach(() => {
    if (ORIGINAL_ENV.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = ORIGINAL_ENV.HERDR_ENV;
    if (ORIGINAL_ENV.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = ORIGINAL_ENV.HERDR_PANE_ID;
    if (ORIGINAL_ENV.HC_TERMINAL_ID === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = ORIGINAL_ENV.HC_TERMINAL_ID;
  });

  test("registers handlers in herdr-app", async () => {
    useHerdrApp();
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.events.has("session_info_changed"));
    assert.ok(pi.events.has("session_start"));
    assert.ok(pi.events.has("session_shutdown"));
  });

  test("registers handlers in legacy Herdr", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.events.has("session_info_changed"));
    assert.ok(pi.events.has("session_start"));
    assert.ok(pi.events.has("session_shutdown"));
  });

  test("registers nothing outside Herdr", async () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HC_TERMINAL_ID;
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.equal(pi.events.has("session_info_changed"), false);
    assert.equal(pi.events.has("session_start"), false);
    assert.equal(pi.events.has("session_shutdown"), false);
  });

  test("sets herdr-app terminal label on session_info_changed", async () => {
    useHerdrApp();
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_info_changed", { type: "session_info_changed", name: "✨ Add dark mode toggle" });

    assert.deepEqual(pi.execCalls, [
      ["hc", ["label", "t-app", "pi.session=✨ Add dark mode toggle"]],
    ]);
  });

  test("prefers herdr-app terminal id when both environments exist", async () => {
    process.env.HC_TERMINAL_ID = "t-app";
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_info_changed", { type: "session_info_changed", name: "🌱 Keep label" });

    assert.deepEqual(pi.execCalls, [
      ["hc", ["label", "t-app", "pi.session=🌱 Keep label"]],
    ]);
  });

  test("ignores session_info_changed without a name", async () => {
    useHerdrApp();
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_info_changed", { type: "session_info_changed", name: "" });

    assert.deepEqual(pi.execCalls, []);
  });

  for (const [flow, reason] of [
    ["/resume", "resume"],
    ["pi -c", "startup"],
    ["pi --session <id>", "startup"],
  ] as const) {
    test(`activates loaded session label for ${flow}`, async () => {
      useHerdrApp();
      const pi = herdrPi();
      pi.getSessionName = () => "🔧 Fix issue 28";
      const mod = await import("./index.ts");
      mod.default(pi);

      pi.events.emit("session_start", { type: "session_start", reason });

      assert.deepEqual(pi.execCalls, [
        ["hc", ["label", "t-app", "pi.session=🔧 Fix issue 28"]],
      ]);
    });
  }

  test("clears stale herdr-app label when loaded session has no name", async () => {
    useHerdrApp();
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_start", { type: "session_start", reason: "startup" });

    assert.deepEqual(pi.execCalls, [
      ["hc", ["label", "t-app", "pi.session="]],
    ]);
  });

  test("falls back to legacy Herdr pane rename", async () => {
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_info_changed", { type: "session_info_changed", name: "✨ Add dark mode toggle" });

    assert.deepEqual(pi.execCalls, [
      ["herdr", ["pane", "rename", "w9:pB", "✨ Add dark mode toggle"]],
    ]);
  });

  test("clears herdr-app label on quit", async () => {
    useHerdrApp();
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    assert.deepEqual(pi.execCalls, [
      ["hc", ["label", "t-app", "pi.session="]],
    ]);
  });

  test("does not clear label on non-quit shutdown", async () => {
    useHerdrApp();
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    assert.deepEqual(pi.execCalls, []);
  });

  test("clears legacy label on quit", async () => {
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    assert.deepEqual(pi.execCalls, [
      ["herdr", ["pane", "rename", "w9:pB", "--clear"]],
    ]);
  });

  test("does not throw on registration", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    assert.doesNotThrow(() => mod.default(pi));
  });
});
