import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "../test-helpers.ts";

describe("banner extension", () => {
  test("registers session_start and input handlers", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);

    assert.ok(pi.events.has("session_start"), "session_start handler");
    assert.ok(pi.events.has("input"), "input handler");
  });

  test("does not throw on registration", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    assert.doesNotThrow(() => mod.default(pi));
  });

  test("reads the installed beautiful-pi version", async () => {
    const mod = await import("./index.ts");
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    assert.equal(mod.getBeautifulPiVersion(), packageJson.version);
  });
});
