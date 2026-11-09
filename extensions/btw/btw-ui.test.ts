import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { loadSettings } from "../shared/settings.ts";
import { BtwOverlayController, showBtwOverlay } from "./btw-ui.ts";

test("btw renders prompt and answer with role rails and backgrounds", () => {
  const foregrounds: string[] = [];
  const railTokens: string[] = [];
  const backgrounds: Array<{ token: string; text: string }> = [];
  const theme = {
    fg(token: string, text: string) {
      foregrounds.push(token);
      if (text === "┃") railTokens.push(token);
      return text;
    },
    bg(token: string, text: string) { backgrounds.push({ token, text }); return text; },
  } as Theme;
  const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
  const dialog = new BtwOverlayController("prompt", [], theme, tui, () => {}, new AbortController(), () => {});
  dialog.setAnswer("response");

  const rows = dialog.render(40);
  const promptRow = rows.findIndex((row) => row.includes("/btw prompt"));
  const responseRow = rows.findIndex((row) => row.includes("response"));
  const footerRow = rows.findIndex((row) => row.includes("↑/↓ to scroll"));
  const settings = loadSettings();

  assert.ok(promptRow > 0);
  const promptStartRow = rows[promptRow - 1];
  const promptEndRow = rows[promptRow + 1];
  const separatorRow = rows[promptRow + 2];
  const answerEndRow = rows[responseRow + 1];
  const footerEndRow = rows[footerRow + 1];
  assert.equal(responseRow, promptRow + 3);
  assert.equal(footerRow, responseRow + 2);
  const styledRows = [
    promptStartRow,
    rows[promptRow],
    promptEndRow,
    separatorRow,
    rows[responseRow],
    answerEndRow,
    rows[footerRow],
    footerEndRow,
  ];
  for (const row of styledRows) {
    assert.ok(row.startsWith("┃ "));
    assert.ok(backgrounds.some(({ token, text }) => token === "userMessageBg" && text === row));
  }
  for (const row of [promptStartRow, promptEndRow, separatorRow, answerEndRow, footerEndRow]) {
    assert.equal(row.slice(2).trim(), "");
  }
  assert.ok(rows[footerRow].includes("Esc to dismiss"));
  assert.deepEqual(railTokens, [
    settings.userRailColor,
    settings.userRailColor,
    settings.userRailColor,
    settings.toolRailColor,
    settings.toolRailColor,
    settings.toolRailColor,
    settings.toolRailColor,
    settings.toolRailColor,
  ]);
  assert.ok(backgrounds.every(({ token }) => token === "userMessageBg"));
  assert.ok(foregrounds.includes(settings.userRailColor));
  assert.ok(foregrounds.includes(settings.toolRailColor));
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
