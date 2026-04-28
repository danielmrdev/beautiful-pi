/**
 * /beautiful-pi command — SettingsList TUI for configuring the package.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SettingsList, Container } from "@mariozechner/pi-tui";
import {
  loadSettings,
  saveSettings,
  type BeautifulPiSettings,
} from "../shared/settings.ts";

const COLOR_OPTIONS = [
  "accent", "muted", "dim", "text", "thinkingText",
  "success", "error", "warning",
  "syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxType",
  "mdHeading", "mdLink", "mdCode",
  "customMessageLabel", "toolTitle",
];

const INDENT_OPTIONS = ["0", "2", "4", "6", "8", "10", "12", "14", "16"];

function buildSettingItems(settings: BeautifulPiSettings) {
  return [
    { id: "userRailColor", label: "User rail color", currentValue: settings.userRailColor, values: COLOR_OPTIONS },
    { id: "thinkingRailColor", label: "Thinking rail color", currentValue: settings.thinkingRailColor, values: COLOR_OPTIONS },
    { id: "thinkingTextColor", label: "Thinking text color", currentValue: settings.thinkingTextColor, values: COLOR_OPTIONS },
    { id: "toolRailColor", label: "Tool rail color", currentValue: settings.toolRailColor, values: COLOR_OPTIONS },
    { id: "indentLevel", label: "Indent level", currentValue: String(settings.indentLevel), values: INDENT_OPTIONS },
    { id: "toolsOneLine", label: "Tools one-line", currentValue: settings.toolsOneLine ? "on" : "off", values: ["on", "off"] },
    { id: "showBanner", label: "Show banner", currentValue: settings.showBanner ? "on" : "off", values: ["on", "off"] },
    { id: "showFooter", label: "Show footer", currentValue: settings.showFooter ? "on" : "off", values: ["on", "off"] },
  ];
}

export default function settingsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("beautiful-pi", {
    description: "Configure beautiful-pi colours, layout and features",
    async handler(_args, ctx: ExtensionContext) {
      if (!ctx.hasUI) {
        return;
      }

      const settings = loadSettings();
      let current = { ...settings };

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const container = new Container();

        const themeAdapter = {
          label: (text: string, selected: boolean) =>
            selected ? theme.fg("accent", text) : theme.fg("text", text),
          value: (text: string, selected: boolean) =>
            selected ? theme.fg("accent", text) : theme.fg("muted", text),
          description: (text: string) => theme.fg("dim", text),
          cursor: theme.fg("accent", ">"),
          hint: (text: string) => theme.fg("dim", text),
        };

        const items = buildSettingItems(current);

        const settingsList = new SettingsList(
          items,
          Math.min(items.length, 10),
          themeAdapter,
          (id, newValue) => {
            // Update in-memory
            if (id === "indentLevel") {
              current.indentLevel = parseInt(newValue, 10);
            } else if (id === "toolsOneLine") {
              current.toolsOneLine = newValue === "on";
            } else if (id === "showBanner") {
              current.showBanner = newValue === "on";
            } else if (id === "showFooter") {
              current.showFooter = newValue === "on";
            } else if (id === "userRailColor") {
              current.userRailColor = newValue;
            } else if (id === "thinkingRailColor") {
              current.thinkingRailColor = newValue;
            } else if (id === "thinkingTextColor") {
              current.thinkingTextColor = newValue;
            } else if (id === "toolRailColor") {
              current.toolRailColor = newValue;
            }
            // Persist immediately
            saveSettings(current);
            // Refresh displayed values
            const updated = buildSettingItems(current);
            for (const item of updated) {
              settingsList.updateValue(item.id, item.currentValue);
            }
          },
          () => {
            done(undefined);
          },
          { enableSearch: false }
        );

        container.addChild(settingsList);
        return container;
      }, { overlay: true });

      ctx.ui.notify("Run /reload to apply changes", "info");
    },
  });
}
