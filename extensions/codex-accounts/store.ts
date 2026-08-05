/**
 * Account configuration store.
 *
 * Accounts live under the `accounts` key of beautiful-pi's settings file
 * (`~/.pi/agent/beautiful-pi.json`), sharing the file with UI settings.
 * Project-level restrictions live in `.pi/beautiful-pi.json` next to the
 * project. pi's auth.json credential store is never touched here.
 */
const { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
import type { AccountConfig, CodexAccount, ProjectAccountConfig } from "./types.ts";

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
    cfg.migration = {
      ...(typeof m.globalMigratedAt === "string" ? { globalMigratedAt: m.globalMigratedAt } : {}),
      ...(typeof m.projectMigratedAt === "string" ? { projectMigratedAt: m.projectMigratedAt } : {}),
      ...(typeof m.globalSourceHash === "string" ? { globalSourceHash: m.globalSourceHash } : {}),
      ...(typeof m.projectSourceHash === "string" ? { projectSourceHash: m.projectSourceHash } : {}),
    };
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
  existing["accounts"] = cfg;
  writeJson(path, existing);
}

// ── Project account config ───────────────────────────────────────────────────

export function loadProjectAccountConfig(cwd: string): ProjectAccountConfig | null {
  const raw = readJson(projectSettingsPath(cwd));
  if (!raw) return null;
  const accounts = raw["accounts"];
  if (!accounts || typeof accounts !== "object") return null;
  const allowed = (accounts as Record<string, unknown>).allowedCredentialIds;
  if (!Array.isArray(allowed)) return null;
  const ids = allowed.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length > 0 ? { allowedCredentialIds: ids } : { allowedCredentialIds: [] };
}

export function saveProjectAccountConfig(
  cwd: string,
  cfg: ProjectAccountConfig,
): void {
  const path = projectSettingsPath(cwd);
  const existing = readJson(path) ?? {};
  existing["accounts"] = cfg;
  writeJson(path, existing);
}

/** True when the project restriction blocks the given credential id. */
export function isCredentialAllowed(cwd: string, credentialId: string): boolean {
  const project = loadProjectAccountConfig(cwd);
  if (!project?.allowedCredentialIds || project.allowedCredentialIds.length === 0) return true;
  return project.allowedCredentialIds.includes(credentialId);
}

// ── Pure account operations ──────────────────────────────────────────────────

export interface AddAccountInput {
  provider: string;
  credentialId: string;
  label: string;
  active?: boolean;
}

export function addAccount(cfg: AccountConfig, input: AddAccountInput): { cfg: AccountConfig; account: CodexAccount; created: boolean } {
  const existing = cfg.accounts.find((a) => a.credentialId === input.credentialId);
  if (existing) {
    // Idempotent add: update label only.
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
    ...(input.active ? { active: true } : {}),
  };
  return {
    cfg: { ...cfg, accounts: [...cfg.accounts, account] },
    account,
    created: true,
  };
}

export function removeAccount(cfg: AccountConfig, id: string): AccountConfig {
  const removed = cfg.accounts.find((a) => a.id === id);
  if (!removed) return cfg;
  return {
    ...cfg,
    accounts: cfg.accounts.filter((a) => a.id !== id),
    ...(cfg.activeAccountId === id ? { activeAccountId: undefined } : {}),
  };
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
