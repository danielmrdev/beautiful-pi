import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BRAIN_ICON, getThinkingText } from "./icons.ts";

function withNerdFonts(value: "0" | "1", fn: () => void): void {
  const previous = process.env["POWERLINE_NERD_FONTS"];
  process.env["POWERLINE_NERD_FONTS"] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env["POWERLINE_NERD_FONTS"];
    else process.env["POWERLINE_NERD_FONTS"] = previous;
  }
}

describe("thinking level labels", () => {
  test("renders all pi levels in ASCII mode", () => {
    withNerdFonts("0", () => {
      assert.deepEqual(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(getThinkingText),
        ["off", "min", "low", "med", "high", "xhigh", "max"],
      );
    });
  });

  test("renders extended levels with Nerd Fonts", () => {
    withNerdFonts("1", () => {
      assert.equal(getThinkingText("xhigh"), `${BRAIN_ICON} xhigh`);
      assert.equal(getThinkingText("max"), `${BRAIN_ICON} max`);
    });
  });

  test("shows unknown levels instead of hiding them", () => {
    withNerdFonts("0", () => {
      assert.equal(getThinkingText("future-level"), "future-level");
    });
  });
});
