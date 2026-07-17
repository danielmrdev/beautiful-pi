import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "../test-helpers.ts";

describe("settings extension", () => {
  test("registers /beautiful-pi command", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.commands.has("beautiful-pi"), "command registered");
  });
});
