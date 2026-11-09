import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showBtwOverlay } from "./btw-ui.ts";

test("btw opens in a centered dialog with bounded width and height", () => {
  let options: unknown;
  const ctx = {
    ui: {
      custom(_component: unknown, overlayOptions: unknown) {
        options = overlayOptions;
        return Promise.resolve();
      },
    },
  } as unknown as ExtensionCommandContext;

  showBtwOverlay({
    ctx,
    question: "Why?",
    history: [],
    controller: new AbortController(),
    onClearHistory() {},
  });

  assert.deepEqual(options, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "75%",
      maxHeight: "70%",
    },
  });
});
