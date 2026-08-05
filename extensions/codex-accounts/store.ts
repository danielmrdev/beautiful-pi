/**
 * Account configuration store.
 *
 * Accounts live under the `accounts` key of beautiful-pi's settings file
 * (`~/.pi/agent/beautiful-pi.json`), sharing the file with UI settings.
 * Project-level restrictions live in `.pi/beautiful-pi.json` next to the
 * project. pi's auth.json credential store is never written here.
 */
const { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
import type { AccountConfig, CodexAccount, ProjectAccountConfig } from "./types.ts";

/** The settings-file key that holds the account namespace. */
export const ACCOUNTS_SECTION = "accounts";

// ── Paths (lazy so tests can override process.env.HOME after import) ─────────

export function agentDirPath(): string {
  return join(process.env["HOME"] ?? "", ".pi", "agent");
}

/** pi's OAuth credential store (auth.json) — read-only for this extension. */
export function authFilePath(): string {
  return join(agentDirPath(), "auth.json");
}

function globalSettingsPath(): string {
  return join(agentDirPath(), "beautiful-pi.json");
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "beautiful-pi.json");
}

// ── Low-level JSON helpers (tolerant, never throw) ───────────────────────────

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  } catch {
    // Silently ignore permission or I/O errors (e.g. read-only filesystem)
  }
}

export function copyFile(path: string, dest: string): boolean {
  try {
    copyFileSync(path, dest);
    return true;
  } catch {
    return false;
  }
}

export function renameFile(path: string, dest: string): boolean {
  try {
    renameSync(path, dest);
    return true;
  } catch {
    return false;
  }
}

// ── Account config normalization ─────────────────────────────────────────────

function normalizeAccount(raw: unknown): CodexAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  if (typeof entry.credentialId !== "string" || !entry.credentialId) return null;
  const provider = typeof entry.provider === "string" && entry.provider ? entry.provider : "openai-codex";
  const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : entry.credentialId;
  const legacy = entry.legacy && typeof entry.legacy === "object"
    ? {
        ...(typeof (entry.legacy as Record<string, unknown>).index === "number"
          ? { index: (entry.legacy as Record<string, unknown>).index as number }
          : {}),
        source: "multi-pass" as const,
      }
    : undefined;
  return {
    id: entry.id,
    provider,
    credentialId: entry.credentialId,
    label,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    ...(typeof entry.lastUsedAt === "string" ? { lastUsedAt: entry.lastUsedAt } : {}),
    ...(entry.active === true ? { active: true } : {}),
    ...(legacy ? { legacy } : {}),
  };
}

function normalizeConfig(raw: Record<string, unknown> | null): AccountConfig {
  const cfg: AccountConfig = { version: 1, accounts: [] };
  if (!raw) return cfg;
  const accounts = raw.accounts;
  if (Array.isArray(accounts)) {
    cfg.accounts = accounts
      .map(normalizeAccount)
      .filter((a): a is CodexAccount => a !== null);
  }
  if (typeof raw.activeAccountId === "string" && raw.activeAccountId) {
    cfg.activeAccountId = raw.activeAccountId;
  }
  const migration = raw.migration;
  if (migration && typeof migration === "object") {
    const m = migration as Record<string, unknown>;
    if (typeof m.globalMigratedAt === "string") {
      cfg.migration = { globalMigratedAt: m.globalMigratedAt };
    }
  }
  return cfg;
}

// ── Global account config ────────────────────────────────────────────────────

export function loadGlobalAccountConfig(filePath?: string): AccountConfig {
  const raw = readJson(filePath ?? globalSettingsPath());
  // The `accounts` key of the settings file holds the whole AccountConfig.
  const section = raw && typeof raw.accounts === "object" && !Array.isArray(raw.accounts)
    ? (raw.accounts as Record<string, unknown>)
    : null;
  return normalizeConfig(section);
}

/** Write only the `accounts` key, preserving all other settings keys. */
export function saveGlobalAccountConfig(cfg: AccountConfig, filePath?: string): void {
  const path = filePath ?? globalSettingsPath();
  const existing = readJson(path) ?? {};
  existing[ACCOUNTS_SECTION] = cfg;
  writeJson(path, existing);
}

// ── Project account config ───────────────────────────────────────────────────

export function loadProjectAccountConfig(cwd: string): ProjectAccountConfig | null {
  const raw = readJson(projectSettingsPath(cwd));
  if (!raw) return null;
  const section = raw[ACCOUNTS_SECTION];
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const accounts = section as Record<string, unknown>;
  const cfg: ProjectAccountConfig = {};
  const allowed = accounts.allowedCredentialIds;
  if (Array.isArray(allowed)) {
    const ids = allowed.filter((v): v is string => typeof v === "string" && v.length > 0);
    cfg.allowedCredentialIds = ids;
  }
  if (typeof accounts.migratedFromLegacyAt === "string") {
    cfg.migratedFromLegacyAt = accounts.migratedFromLegacyAt;
  }
  return Object.keys(cfg).length > 0 ? cfg : null;
}

export function saveProjectAccountConfig(
  cwd: string,
  cfg: ProjectAccountConfig,
): void {
  const path = projectSettingsPath(cwd);
  const existing = readJson(path) ?? {};
  existing[ACCOUNTS_SECTION] = cfg;
  writeJson(path, existing);
}

/** True when the project restriction blocks the given credential id. */
export function isCredentialAllowed(cwd: string, credentialId: string): boolean {
  const project = loadProjectAccountConfig(cwd);
  if (!project?.allowedCredentialIds || project.allowedCredentialIds.length === 0) return true;
  return project.allowedCredentialIds.includes(credentialId);
}

/** Provider ids currently stored in pi's auth.json (keys only, never values). */
export function storedCredentialIds(): string[] {
  try {
    const raw = JSON.parse(readFileSync(authFilePath(), "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return Object.keys(raw).filter((k) => k.length > 0);
    }
  } catch {
    // missing or unreadable auth.json
  }
  return [];
}

// ── Pure account operations ──────────────────────────────────────────────────

export interface AddAccountInput {
  provider: string;
  credentialId: string;
  label: string;
}

/**
 * Add an account. The first account in an empty config is automatically made
 * the active account. Idempotent: adding an existing credentialId only
 * refreshes its label.
 */
export function addAccount(cfg: AccountConfig, input: AddAccountInput): { cfg: AccountConfig; account: CodexAccount; created: boolean } {
  const existing = cfg.accounts.find((a) => a.credentialId === input.credentialId);
  if (existing) {
    const updated: AccountConfig = {
      ...cfg,
      accounts: cfg.accounts.map((a) =>
        a.id === existing.id ? { ...a, label: input.label || a.label } : a
      ),
    };
    return { cfg: updated, account: existing, created: false };
  }
  const account: CodexAccount = {
    id: randomUUID(),
    provider: input.provider,
    credentialId: input.credentialId,
    label: input.label || input.credentialId,
    createdAt: new Date().toISOString(),
  };
  const isFirst = cfg.accounts.length === 0 && !cfg.activeAccountId;
  const next: AccountConfig = {
    ...cfg,
    accounts: [...cfg.accounts, account],
  };
  const promoted = isFirst ? setActiveAccount(next, account.id) : next;
  return {
    cfg: promoted,
    account: promoted.accounts.find((a) => a.id === account.id) ?? account,
    created: true,
  };
}

/**
 * Remove an account. When the active account is removed, the first remaining
 * account is promoted to active.
 */
export function removeAccount(cfg: AccountConfig, id: string): AccountConfig {
  const removed = cfg.accounts.find((a) => a.id === id);
  if (!removed) return cfg;
  const remaining = cfg.accounts.filter((a) => a.id !== id);
  let next: AccountConfig = { ...cfg, accounts: remaining };
  if (cfg.activeAccountId === id || removed.active) {
    next = { ...next, activeAccountId: undefined, accounts: remaining.map((a) => ({ ...a, active: undefined })) };
    if (remaining.length > 0) next = setActiveAccount(next, remaining[0].id);
  }
  return next;
}

export function setActiveAccount(cfg: AccountConfig, id: string): AccountConfig {
  return {
    ...cfg,
    activeAccountId: id,
    accounts: cfg.accounts.map((a) => ({ ...a, ...(a.id === id ? { active: true, lastUsedAt: new Date().toISOString() } : { active: undefined }) })),
  };
}

/** Resolve an account by id, label, or credentialId. */
export function resolveAccount(cfg: AccountConfig, ref: string): CodexAccount | undefined {
  if (!ref) return undefined;
  const needle = ref.trim().toLowerCase();
  return cfg.accounts.find(
    (a) =>
      a.id === ref ||
      a.credentialId === ref ||
      a.credentialId.toLowerCase() === needle ||
      a.label.toLowerCase() === needle,
  );
}
