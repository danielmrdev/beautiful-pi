/**
 * Settings loader + safe color helpers for beautiful-pi.
 */

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

// ── Paths ─────────────────────────────────────────────────────────────────────

const USER_SETTINGS_PATH = join(process.env["HOME"] ?? "", ".pi", "agent", "beautiful-pi.json");

function getDefaultsPath(): string {
  // Resolve relative to this file (extensions/shared/settings.ts)
  // -> ../../settings/defaults.json
  const thisDir = dirname(__filename);
  return join(thisDir, "..", "settings", "defaults.json");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BeautifulPiSettings {
  userRailColor: string;
  thinkingRailColor: string;
  thinkingTextColor: string;
  toolRailColor: string;
  indentLevel: number;
  toolsOneLine: boolean;
  showBanner: boolean;
  showFooter: boolean;
}

const DEFAULTS: BeautifulPiSettings = (() => {
  try {
    return JSON.parse(readFileSync(getDefaultsPath(), "utf-8"));
  } catch {
    // Fallback if JSON file can't be resolved (e.g. different runtime path)
    return {
      userRailColor: "syntaxKeyword",
      thinkingRailColor: "mdHeading",
      thinkingTextColor: "muted",
      toolRailColor: "success",
      indentLevel: 4,
      toolsOneLine: true,
      showBanner: true,
      showFooter: true,
    };
  }
})();

// ── Load / merge ──────────────────────────────────────────────────────────────

function loadUserOverrides(): Partial<BeautifulPiSettings> {
  if (!existsSync(USER_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(USER_SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function loadSettings(): BeautifulPiSettings {
  const user = loadUserOverrides();
  return { ...DEFAULTS, ...user };
}

// ── Save ──────────────────────────────────────────────────────────────────────

export function saveSettings(settings: Partial<BeautifulPiSettings>): void {
  // Only persist values that differ from defaults
  const toSave: Partial<BeautifulPiSettings> = {};
  for (const key of Object.keys(DEFAULTS) as Array<keyof BeautifulPiSettings>) {
    if ((settings as any)[key] !== DEFAULTS[key]) {
      (toSave as any)[key] = (settings as any)[key];
    }
  }

  // Skip writing an empty file when everything matches defaults
  if (Object.keys(toSave).length === 0) return;

  try {
    mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify(toSave, null, 2) + "\n");
  } catch {
    // Silently ignore permission or I/O errors (e.g. read-only filesystem)
  }
}

// ── Safe color helpers ────────────────────────────────────────────────────────

export function safeFg(
  theme: any,
  token: string | undefined,
  fallback: string,
  text: string
): string {
  if (!theme || typeof theme.fg !== "function") return text;
  try {
    return theme.fg(token ?? fallback, text);
  } catch {
    try {
      return theme.fg(fallback, text);
    } catch {
      return text;
    }
  }
}

export function safeBg(
  theme: any,
  token: string | undefined,
  fallback: string,
  text: string
): string {
  if (!theme || typeof theme.bg !== "function") return text;
  try {
    return theme.bg(token ?? fallback, text);
  } catch {
    try {
      return theme.bg(fallback, text);
    } catch {
      return text;
    }
  }
}
