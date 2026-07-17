import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "./test-helpers.ts";

describe("extension wiring", () => {
  test("all 8 features wire without exception", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    // Should have session_start and input events
    const sessionStart = pi.events.get("session_start") ?? [];
    const input = pi.events.get("input") ?? [];
    assert.ok(sessionStart.length >= 1, "session_start handler(s) registered");
    assert.ok(input.length >= 1, "input handler(s) registered");

    // Settings registers /beautiful-pi command
    assert.ok(pi.commands.has("beautiful-pi"), "/beautiful-pi command registered");
  });
});
