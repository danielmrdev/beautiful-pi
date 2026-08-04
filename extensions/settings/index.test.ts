import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "../test-helpers.ts";

describe("settings extension", () => {
  test("registers /bpi and /beautiful-pi commands", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.commands.has("bpi"), "/bpi command registered");
    assert.ok(pi.commands.has("beautiful-pi"), "/beautiful-pi alias registered");
  });
});
