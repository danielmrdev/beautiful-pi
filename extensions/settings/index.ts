/**
 * /bpi command — SettingsList TUI for configuring beautiful-pi.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { SettingsList, truncateToWidth, visibleWidth, Input, matchesKey } from "@earendil-works/pi-tui";
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

type TabDef = { label: string; items: SettingItem[] };

function buildTabs(s: BeautifulPiSettings): TabDef[] {
  return [
    {
      label: "Layout",
      items: [
        { id: "showBanner",    label: "Banner",          currentValue: b(s.showBanner),    values: ON_OFF },
        { id: "showFooter",    label: "Footer",          currentValue: b(s.showFooter),    values: ON_OFF },
        { id: "sessionTitle",  label: "Session title",   currentValue: b(s.sessionTitle),  values: ON_OFF },
        { id: "toolsOneLine",  label: "Tools one-line",  currentValue: b(s.toolsOneLine),  values: ON_OFF },
        { id: "indentLevel",   label: "Indent level",    currentValue: String(s.indentLevel), values: INDENT_OPTIONS },
      ],
    },
    {
      label: "Colors",
      items: [
        { id: "agentRailColor",         label: "Agent rail color",       currentValue: s.agentRailColor,         values: COLOR_OPTIONS },
        { id: "userRailColor",          label: "User rail color",        currentValue: s.userRailColor,          values: COLOR_OPTIONS },
        { id: "thinkingRailColor",      label: "Thinking rail color",    currentValue: s.thinkingRailColor,      values: COLOR_OPTIONS },
        { id: "thinkingTextColor",      label: "Thinking text color",    currentValue: s.thinkingTextColor,      values: COLOR_OPTIONS },
        { id: "dimThinkingText",        label: "Dim thinking text",      currentValue: b(s.dimThinkingText),     values: ON_OFF },
        { id: "toolRailColor",          label: "Tools rail color",       currentValue: s.toolRailColor,          values: COLOR_OPTIONS },
        { id: "dimToolsText",           label: "Dim tools text",         currentValue: b(s.dimToolsText),        values: ON_OFF },
        { id: "customMessageRailColor", label: "Custom rail color",      currentValue: s.customMessageRailColor, values: COLOR_OPTIONS },
        { id: "dimCustomMessages",      label: "Dim custom messages",    currentValue: b(s.dimCustomMessages),   values: ON_OFF },
      ],
    },
    {
      label: "Credentials",
      items: [
        { id: "opencodeGoWorkspaceId", label: "OCGo workspace ID", currentValue: s.opencodeGoWorkspaceId ?? "(not set)", submenu: textSubmenu(() => s.opencodeGoWorkspaceId ?? "", "wrk_... from opencode.ai URL") },
        { id: "opencodeGoAuthCookie",  label: "OCGo auth cookie",  currentValue: s.opencodeGoAuthCookie ? "****" : "(not set)",       submenu: textSubmenu(() => s.opencodeGoAuthCookie ?? "", "auth cookie from opencode.ai") },
      ],
    },
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
    case "thinkingTextColor":      current.thinkingTextColor      = value; break;
    case "dimThinkingText":        current.dimThinkingText        = value === "on"; break;
    case "toolRailColor":          current.toolRailColor          = value; break;
    case "dimToolsText":           current.dimToolsText           = value === "on"; break;
    case "customMessageRailColor": current.customMessageRailColor = value; break;
    case "dimCustomMessages":      current.dimCustomMessages      = value === "on"; break;
    case "opencodeGoWorkspaceId":   current.opencodeGoWorkspaceId   = value; break;
    case "opencodeGoAuthCookie":    current.opencodeGoAuthCookie    = value; break;
  }
}

/** Build SettingsList instances from current settings, reusing existing lists when possible. */
function buildTabLists(
  tabs: TabDef[],
  themeAdapter: any,
  current: BeautifulPiSettings,
  onChange: (id: string, newValue: string) => void,
  onCancel: () => void,
  existing: (SettingsList | null)[],
): SettingsList[] {
  return tabs.map((tab, i) => {
    const prev = existing[i];
    if (prev) {
      // Refresh values in existing list
      for (const item of tab.items) {
        prev.updateValue(item.id, item.currentValue);
      }
      return prev;
    }
    return new SettingsList(
      tab.items,
      Math.min(tab.items.length, 12),
      themeAdapter,
      onChange,
      onCancel,
      { enableSearch: true },
    );
  });
}

function renderTabsRow(
  tabs: TabDef[],
  activeIndex: number,
  inner: number,
  theme: any,
): string {
  const tabLabels = tabs.map((t, i) => {
    const prefix = i === activeIndex ? " " : "";
    const suffix = i === activeIndex ? " " : "";
    const label = prefix + t.label + suffix;
    return i === activeIndex
      ? theme.fg("accent", label)
      : theme.fg("muted", label);
  });
  const row = tabLabels.join(theme.fg("border", " │ "));
  const rowLen = visibleWidth(row);
  const pad = Math.max(0, inner - rowLen);
  return row + " ".repeat(pad);
}

export default function settingsExtension(pi: ExtensionAPI): void {
  const handler = async (_args: string, ctx: ExtensionCommandContext) => {
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

      let tabs = buildTabs(current);
      let activeTab = 0;
      const handleChange = (id: string, newValue: string) => {
        applyChange(current, id, newValue);
        saveSettings(current);
        // Rebuild tabs with fresh values
        tabs = buildTabs(current);
        tabLists = buildTabLists(tabs, themeAdapter, current, handleChange, () => done(undefined), tabLists);
      };

      let tabLists: SettingsList[] = buildTabLists(
        tabs, themeAdapter, current, handleChange, () => done(undefined), [],
      );

      // ── Complete bordered wrapper with tabs ────────────────────────────────
      const TITLE = "bpi settings";
      const HINT  = "←→/Tab tabs  ↑↓ nav  / search  Space change  Esc close";

      return {
        render(width: number): string[] {
          const safeWidth = Math.max(4, Math.floor(width));
          const inner = safeWidth - 2;
          const bc = (s: string) => theme.fg("border", s);
          const ac = (s: string) => theme.fg("accent", s);
          const dc = (s: string) => theme.fg("dim", s);
          const fit = (s: string) => truncateToWidth(s, inner, "", false);
          const padSafe = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
          const horizontal = (left: string, right: string) =>
            bc(left + "─".repeat(inner) + right);
          const framed = (content: string) =>
            bc("│") + padSafe(content) + bc("│");
          const centered = (text: string, color: (s: string) => string) => {
            const fitted = fit(text);
            const remaining = Math.max(0, inner - visibleWidth(fitted));
            const left = Math.floor(remaining / 2);
            return " ".repeat(left) + color(fitted) + " ".repeat(remaining - left);
          };

          const top = horizontal("╭", "╮");
          const title = framed(centered(TITLE, ac));
          const divider = horizontal("├", "┤");
          const tabsLine = framed(renderTabsRow(tabs, activeTab, inner, theme));

          const activeList = tabLists[activeTab];
          const content = activeList ? activeList.render(inner) : [];
          const rows = content.map((line) => framed(fit(line)));
          const hint = framed(centered(HINT, dc));
          const bottom = horizontal("╰", "╯");

          return [top, title, divider, tabsLine, ...rows, divider, hint, bottom];
        },
        invalidate() {
          for (const list of tabLists) list.invalidate();
        },
        handleInput(data: string) {
          // Use pi-tui matcher: supports CSI, SS3 and Kitty key protocols.
          const isLeft = matchesKey(data, "left");
          const isRight = matchesKey(data, "right");

          // Tab switching: ← or Shift+Tab = previous, → or Tab = next
          if (isLeft || matchesKey(data, "shift+tab")) {
            if (activeTab > 0) activeTab--;
            tui.requestRender();
            return;
          }
          if (isRight || matchesKey(data, "tab")) {
            if (activeTab < tabs.length - 1) activeTab++;
            tui.requestRender();
            return;
          }

          // Delegate to active tab's list
          const activeList = tabLists[activeTab];
          if (activeList) activeList.handleInput(data);
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: { anchor: "center", width: 62, maxHeight: "85%" } });

    ctx.ui.notify("Run /reload to apply changes", "info");
  };

  pi.registerCommand("bpi", {
    description: "Configure beautiful-pi colours, layout and features",
    handler,
  });
  // Legacy alias
  pi.registerCommand("beautiful-pi", {
    description: "Configure beautiful-pi (alias for /bpi)",
    handler,
  });
}
