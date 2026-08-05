/**
 * Settings loader + safe color helpers for beautiful-pi.
 */

import { ACCOUNTS_SECTION } from "../codex-accounts/store.ts";

const { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } = require("node:fs");
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
  agentRailColor: string;
  userRailColor: string;
  thinkingRailColor: string;
  thinkingTextColor: string;
  dimThinkingText: boolean;
  toolRailColor: string;
  dimToolsText: boolean;
  customMessageRailColor: string;
  dimCustomMessages: boolean;
  indentLevel: number;
  toolsOneLine: boolean;
  showBanner: boolean;
  showFooter: boolean;
  sessionTitle: boolean;
  syncHerdrPaneLabel: boolean;
  opencodeGoWorkspaceId?: string;
  opencodeGoAuthCookie?: string;
}

const DEFAULTS: BeautifulPiSettings = (() => {
  try {
    return JSON.parse(readFileSync(getDefaultsPath(), "utf-8"));
  } catch {
    // Fallback if JSON file can't be resolved (e.g. different runtime path)
    return {
      agentRailColor: "accent",
      userRailColor: "mdLink",
      thinkingRailColor: "mdHeading",
      thinkingTextColor: "muted",
      dimThinkingText: true,
      toolRailColor: "success",
      dimToolsText: true,
      customMessageRailColor: "borderMuted",
      dimCustomMessages: true,
      indentLevel: 4,
      toolsOneLine: true,
      showBanner: true,
      showFooter: true,
      sessionTitle: true,
      syncHerdrPaneLabel: true,
    };
  }
})();

// ── Load / merge ──────────────────────────────────────────────────────────────

function loadUserOverrides(): Partial<BeautifulPiSettings> {
  if (!existsSync(USER_SETTINGS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // The `accounts` namespace is managed by the codex-accounts store, not by
    // the settings UI — strip it so it never leaks into loadSettings().
    const { [ACCOUNTS_SECTION]: _accounts, ...rest } = raw as Record<string, unknown>;
    return rest as Partial<BeautifulPiSettings>;
  } catch {
    return {};
  }
}

// ── Settings cache ────────────────────────────────────────────────────────────

let _cachedSettings: BeautifulPiSettings | null = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 500; // 500ms TTL — fast enough for /reload, cheap enough for renders

export function invalidateSettingsCache(): void {
  _cachedSettings = null;
  _cacheTimestamp = 0;
}

export function loadSettings(): BeautifulPiSettings {
  const now = Date.now();
  if (_cachedSettings && now - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedSettings;
  }
  const user = loadUserOverrides();
  _cachedSettings = { ...DEFAULTS, ...user };
  _cacheTimestamp = now;
  return _cachedSettings;
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
  // Persist optional credential keys (not in DEFAULTS)
  if (settings.opencodeGoWorkspaceId) {
    toSave.opencodeGoWorkspaceId = settings.opencodeGoWorkspaceId;
  }
  if (settings.opencodeGoAuthCookie) {
    toSave.opencodeGoAuthCookie = settings.opencodeGoAuthCookie;
  }

  // Preserve the `accounts` namespace owned by the codex-accounts store.
  let accounts: unknown;
  try {
    if (existsSync(USER_SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw) && ACCOUNTS_SECTION in raw) {
        accounts = (raw as Record<string, unknown>)[ACCOUNTS_SECTION];
      }
    }
  } catch {
    // corrupt file: treat as no accounts
  }

  // When everything matches defaults, delete the stale file (if any) instead
  // of leaving it on disk where it would be re-read after /reload. Unless the
  // account namespace is present — then keep the file and rewrite only settings.
  if (Object.keys(toSave).length === 0 && accounts === undefined) {
    try { unlinkSync(USER_SETTINGS_PATH); } catch { /* file may not exist */ }
    invalidateSettingsCache();
    return;
  }

  try {
    mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
    const out: Record<string, unknown> = { ...toSave };
    if (accounts !== undefined) out[ACCOUNTS_SECTION] = accounts;
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify(out, null, 2) + "\n");
  } catch {
    // Silently ignore permission or I/O errors (e.g. read-only filesystem)
  }
  invalidateSettingsCache();
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
