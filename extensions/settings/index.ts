/**
 * /beautiful-pi command — SettingsList TUI for configuring the package.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, visibleWidth, Input } from "@earendil-works/pi-tui";
import {
  loadSettings,
  saveSettings,
  type BeautifulPiSettings,
} from "../shared/settings.ts";

const COLOR_OPTIONS = [
  "accent",
  "border", "borderAccent", "borderMuted",
  "muted", "dim", "text", "thinkingText",
  "success", "error", "warning",
  "syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxType",
  "mdHeading", "mdLink", "mdCode",
  "customMessageLabel", "toolTitle",
];

const INDENT_OPTIONS = ["0", "2", "4", "6", "8", "10", "12", "14", "16"];
const ON_OFF = ["on", "off"];

function b(v: boolean): string { return v ? "on" : "off"; }

function buildSettingItems(s: BeautifulPiSettings) {
  return [
    // ── Layout / features ──────────────────────────────────────────────────
    { id: "showBanner",             label: "Banner",               currentValue: b(s.showBanner),            values: ON_OFF },
    { id: "showFooter",             label: "Footer",               currentValue: b(s.showFooter),            values: ON_OFF },
    { id: "sessionTitle",           label: "Session title",        currentValue: b(s.sessionTitle),          values: ON_OFF },
    { id: "toolsOneLine",           label: "Tools one-line",       currentValue: b(s.toolsOneLine),          values: ON_OFF },
    { id: "indentLevel",            label: "Indent level",         currentValue: String(s.indentLevel),      values: INDENT_OPTIONS },
    // ── Agent ──────────────────────────────────────────────────────────────
    { id: "agentRailColor",         label: "Agent rail color",     currentValue: s.agentRailColor,           values: COLOR_OPTIONS },
    // ── User ──────────────────────────────────────────────────────────────
    { id: "userRailColor",          label: "User rail color",      currentValue: s.userRailColor,            values: COLOR_OPTIONS },
    // ── Thinking ──────────────────────────────────────────────────────────
    { id: "thinkingRailColor",      label: "Thinking rail color",  currentValue: s.thinkingRailColor,        values: COLOR_OPTIONS },
    { id: "dimThinkingText",        label: "Dim thinking text",    currentValue: b(s.dimThinkingText),       values: ON_OFF },
    // ── Tools ─────────────────────────────────────────────────────────────
    { id: "toolRailColor",          label: "Tools rail color",     currentValue: s.toolRailColor,            values: COLOR_OPTIONS },
    { id: "dimToolsText",           label: "Dim tools text",       currentValue: b(s.dimToolsText),          values: ON_OFF },
    // ── Custom messages ───────────────────────────────────────────────────
    { id: "customMessageRailColor", label: "Custom rail color",    currentValue: s.customMessageRailColor,   values: COLOR_OPTIONS },
    { id: "dimCustomMessages",      label: "Dim custom messages",  currentValue: b(s.dimCustomMessages),     values: ON_OFF },
    // ── OpenCode Go credentials ───────────────────────────────────────────
    { id: "opencodeGoWorkspaceId",  label: "OCGo workspace ID",    currentValue: s.opencodeGoWorkspaceId ?? "(not set)",  submenu: textSubmenu(() => s.opencodeGoWorkspaceId ?? "", "wrk_... from opencode.ai URL")  },
    { id: "opencodeGoAuthCookie",   label: "OCGo auth cookie",    currentValue: s.opencodeGoAuthCookie ? "****" : "(not set)",  submenu: textSubmenu(() => s.opencodeGoAuthCookie ?? "", "auth cookie from opencode.ai") },
  ];
}

function textSubmenu(getValue: () => string, description: string) {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    const input = new Input();
    input.setValue(getValue());
    input.focused = true;
    input.onSubmit = (v) => { input.focused = false; done(v); };
    input.onEscape = () => { input.focused = false; done(undefined); };
    return {
      render(width: number): string[] {
        const descLine = `  \x1b[2m${description}\x1b[22m`;
        const inputLines = input.render(width);
        return [descLine, ...inputLines];
      },
      invalidate() {},
      handleInput(data: string): void { input.handleInput(data); },
    };
  };
}

function applyChange(current: BeautifulPiSettings, id: string, value: string): void {
  switch (id) {
    case "showBanner":             current.showBanner             = value === "on"; break;
    case "showFooter":             current.showFooter             = value === "on"; break;
    case "sessionTitle":           current.sessionTitle           = value === "on"; break;
    case "toolsOneLine":           current.toolsOneLine           = value === "on"; break;
    case "indentLevel":            current.indentLevel            = parseInt(value, 10); break;
    case "agentRailColor":         current.agentRailColor         = value; break;
    case "userRailColor":          current.userRailColor          = value; break;
    case "thinkingRailColor":      current.thinkingRailColor      = value; break;
    case "dimThinkingText":        current.dimThinkingText        = value === "on"; break;
    case "toolRailColor":          current.toolRailColor          = value; break;
    case "dimToolsText":           current.dimToolsText           = value === "on"; break;
    case "customMessageRailColor": current.customMessageRailColor = value; break;
    case "dimCustomMessages":      current.dimCustomMessages      = value === "on"; break;
    case "opencodeGoWorkspaceId":   current.opencodeGoWorkspaceId   = value; break;
    case "opencodeGoAuthCookie":    current.opencodeGoAuthCookie    = value; break;
  }
}

export default function settingsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("beautiful-pi", {
    description: "Configure beautiful-pi colours, layout and features",
    async handler(_args, ctx: ExtensionContext) {
      if (!ctx.hasUI) return;

      const settings = loadSettings();
      let current = { ...settings };

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const themeAdapter = {
          label:       (text: string, selected: boolean) =>
                         selected ? theme.fg("accent", text) : theme.fg("text", text),
          value:       (text: string, selected: boolean) =>
                         selected ? theme.fg("accent", text) : theme.fg("muted", text),
          description: (text: string) => theme.fg("dim", text),
          cursor:      theme.fg("accent", ">"),
          hint:        (text: string) => theme.fg("dim", text),
        };

        const items = buildSettingItems(current);

        const settingsList = new SettingsList(
          items,
          Math.min(items.length, 12),
          themeAdapter,
          (id, newValue) => {
            applyChange(current, id, newValue);
            saveSettings(current);
            // Refresh all displayed values so cycling is consistent.
            for (const item of buildSettingItems(current)) {
              settingsList.updateValue(item.id, item.currentValue);
            }
          },
          () => done(undefined),
          { enableSearch: false },
        );

        // ── Bordered wrapper ───────────────────────────────────────────────
        const TITLE = " beautiful-pi settings ";
        const HINT  = " ↑↓ navigate  Space/Enter change  Esc close ";
        return {
          render(width: number): string[] {
            const safeWidth = Math.max(1, Math.floor(width));
            const inner = Math.max(1, safeWidth - 2);
            const bc = (s: string) => theme.fg("border", s);
            const ac = (s: string) => theme.fg("accent", s);
            const dc = (s: string) => theme.fg("dim", s);
            const fit = (s: string) => truncateToWidth(s, inner, "", true);
            const fitVisible = (s: string) => visibleWidth(fit(s));
            const padSafe = (s: string) => s + " ".repeat(Math.max(0, inner - fitVisible(s)));

            // Fit title/hint before drawing borders; repeat() must never receive
            // negative widths when terminal is narrower than overlay copy.
            const title = fit(TITLE);
            const titleLen = visibleWidth(title);
            const side = Math.max(0, Math.floor((inner - titleLen) / 2));
            const extraR = Math.max(0, inner - titleLen - side * 2);
            const top = bc("╭" + "─".repeat(side)) + ac(title) + bc("─".repeat(side + extraR) + "╮");

            const content = settingsList.render(inner);
            const rows = content.map((line) => bc("│") + padSafe(fit(line)) + bc("│"));

            const hint = fit(HINT);
            const hintLen = visibleWidth(hint);
            const hSide = Math.max(0, Math.floor((inner - hintLen) / 2));
            const hExtra = Math.max(0, inner - hintLen - hSide * 2);
            const bottom = bc("╰" + "─".repeat(hSide)) + dc(hint) + bc("─".repeat(hSide + hExtra) + "╯");

            return [top, ...rows, bottom].map((line) => truncateToWidth(line, safeWidth, "", true));
          },
          invalidate() { settingsList.invalidate(); },
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      }, { overlay: true, overlayOptions: { anchor: "center", width: 60, maxHeight: "85%" } });

      ctx.ui.notify("Run /reload to apply changes", "info");
    },
  });
}
