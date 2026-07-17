import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compact, prettyPath, readRange, truncate } from "./shared.ts";

describe("tools-one-line helpers", () => {
  test("compact collapses whitespace", () => {
    assert.equal(compact("npm   install  express"), "npm install express");
  });

  test("compact handles undefined", () => {
    assert.equal(compact(undefined), "");
  });

  test("prettyPath replaces HOME with ~", () => {
    const home = process.env.HOME!;
    assert.equal(prettyPath(`${home}/project/file.ts`), "~/project/file.ts");
  });

  test("prettyPath leaves non-home paths alone", () => {
    assert.equal(prettyPath("/usr/bin/node"), "/usr/bin/node");
  });

  test("readRange returns correct ranges", () => {
    assert.equal(readRange(10, 20), ":10–29");
    assert.equal(readRange(5), ":5");
    assert.equal(readRange(undefined, 10), ":1–10");
    assert.equal(readRange(), "");
  });

  test("truncate shortens string with ellipsis", () => {
    const result = truncate("hello world how are you", 10);
    assert.ok(result.length > 0, "result should not be empty");
    assert.ok(result.includes("…"), "result should contain ellipsis");
  });

  test("truncate returns empty for zero width", () => {
    assert.equal(truncate("hello", 0), "");
  });

  test("truncate returns full string when under limit", () => {
    assert.equal(truncate("hi", 10), "hi");
  });
});
