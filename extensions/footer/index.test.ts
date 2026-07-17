import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "../test-helpers.ts";

describe("footer extension", () => {
  test("registers session_start handler", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.events.has("session_start"), "session_start handler registered");
  });

  test("does not throw on registration", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    assert.doesNotThrow(() => mod.default(pi));
  });
});
