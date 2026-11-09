import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { loadSettings } from "../shared/settings.ts";
import { BtwOverlayController, showBtwOverlay } from "./btw-ui.ts";

test("btw renders prompt and answer with role rails and backgrounds", () => {
  const foregrounds: string[] = [];
  const backgrounds: string[] = [];
  const theme = {
    fg(token: string, text: string) { foregrounds.push(token); return text; },
    bg(token: string, text: string) { backgrounds.push(token); return text; },
  } as Theme;
  const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
  const dialog = new BtwOverlayController("prompt", [], theme, tui, () => {}, new AbortController(), () => {});
  dialog.setAnswer("response");

  const rows = dialog.render(40);
  const promptRow = rows.findIndex((row) => row.includes("/btw prompt"));
  const responseRow = rows.findIndex((row) => row.includes("response"));
  const settings = loadSettings();

  assert.ok(promptRow >= 0);
  assert.equal(responseRow, promptRow + 1);
  assert.ok(rows[promptRow].startsWith("┃ "));
  assert.ok(rows[responseRow].startsWith("┃ "));
  assert.ok(backgrounds.includes("userMessageBg"));
  assert.ok(backgrounds.includes("customMessageBg"));
  assert.ok(foregrounds.includes(settings.userRailColor));
  assert.ok(foregrounds.includes(settings.agentRailColor));
  assert.ok(!rows.some((row) => /[╭╮╰╯├┤─]/.test(row)));
});

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
