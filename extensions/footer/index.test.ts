import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakePi } from "../test-helpers.ts";
import { renderTitleLine } from "./index.ts";

// Pass-through theme: the indent/truncation logic is what's under test, not
// colouring. Literal tags would be counted as visible width by truncateToWidth.
const theme: any = {
	fg: (_token: string, text: string) => text,
};

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

describe("renderTitleLine (narrow-mode session title)", () => {
  test("indents title with a single leading space", () => {
    const line = renderTitleLine("✨ Add dark mode", 40, theme);
    assert.equal(line.startsWith(" "), true, "one leading space");
    assert.equal(line.startsWith("  "), false, "no double space");
    assert.equal(line.includes("✨ Add dark mode"), true);
  });

  test("keeps the title within width when truncated", () => {
    const long = "🔥 A very long session title that will not fit at all";
    const line = renderTitleLine(long, 20, theme);
    assert.equal(line.endsWith("…"), true, "truncated with ellipsis");
    assert.equal(line.startsWith(" "), true);
    assert.ok(line.length <= 20, `fits width (${line.length} <= 20)`);
  });

  test("does not truncate when title fits", () => {
    const line = renderTitleLine("Short", 20, theme);
    assert.equal(line.includes("…"), false);
    assert.equal(line, " Short");
  });
});
