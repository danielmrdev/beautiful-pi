import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakePi, type FakePi } from "../test-helpers.ts";

const ORIGINAL_ENV = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
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

describe("herdr pane sync extension", () => {
  beforeEach(() => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w9:pB";
  });

  afterEach(() => {
    if (ORIGINAL_ENV.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = ORIGINAL_ENV.HERDR_ENV;
    if (ORIGINAL_ENV.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = ORIGINAL_ENV.HERDR_PANE_ID;
  });

  test("registers handlers when inside herdr", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.events.has("session_info_changed"), "session_info_changed handler");
    assert.ok(pi.events.has("session_start"), "session_start handler");
    assert.ok(pi.events.has("session_shutdown"), "session_shutdown handler");
  });

  test("registers nothing when not inside herdr", async () => {
    delete process.env.HERDR_ENV;
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.equal(pi.events.has("session_info_changed"), false);
    assert.equal(pi.events.has("session_start"), false);
    assert.equal(pi.events.has("session_shutdown"), false);
  });

  test("renames pane on session_info_changed", async () => {
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_info_changed", { type: "session_info_changed", name: "✨ Add dark mode toggle" });

    assert.deepEqual(pi.execCalls, [
      ["herdr", ["pane", "rename", "w9:pB", "✨ Add dark mode toggle"]],
    ]);
  });

  test("ignores session_info_changed without a name", async () => {
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_info_changed", { type: "session_info_changed", name: "" });

    assert.deepEqual(pi.execCalls, []);
  });

  test("syncs existing name on session_start (resume/reload/fork)", async () => {
    const pi = herdrPi();
    pi.getSessionName = () => "🔧 Fix issue 28";
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_start", { type: "session_start" });

    assert.deepEqual(pi.execCalls, [
      ["herdr", ["pane", "rename", "w9:pB", "🔧 Fix issue 28"]],
    ]);
  });

  test("clears label on quit", async () => {
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    assert.deepEqual(pi.execCalls, [
      ["herdr", ["pane", "rename", "w9:pB", "--clear"]],
    ]);
  });

  test("does not clear label on non-quit shutdown", async () => {
    const pi = herdrPi();
    const mod = await import("./index.ts");
    mod.default(pi);

    pi.events.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    assert.deepEqual(pi.execCalls, []);
  });

  test("does not throw on registration", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    assert.doesNotThrow(() => mod.default(pi));
  });
});
