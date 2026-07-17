import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "../test-helpers.ts";

describe("assistant style extension", () => {
  test("registers session_start and before_agent_start handlers", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.events.has("session_start"), "session_start handler registered");
    assert.ok(pi.events.has("before_agent_start"), "before_agent_start handler registered");
  });

  test("does not throw on registration", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    assert.doesNotThrow(() => mod.default(pi));
  });
});
