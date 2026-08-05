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
import type {
  AccountConfig,
  ChainTarget,
  CodexAccount,
  CodexChain,
  CodexPool,
  CodexPreset,
  PoolSchedule,
  PoolStrategy,
  ProjectAccountConfig,
  ProjectPoolOverride,
  ProjectChainOverride,
  ScheduleDateRange,
  ScheduleTimeWindow,
} from "./types.ts";
import { DATE_RE, TIME_RE } from "./schedule.ts";

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

// Schedule grammar (TIME_RE/DATE_RE) lives in schedule.ts — the CLI parser
// and the scheduled strategy import the same constants.

export const POOL_STRATEGIES: readonly PoolStrategy[] = [
  "round-robin",
  "quota-first",
  "scheduled",
  "custom",
];

export function isPoolStrategy(value: unknown): value is PoolStrategy {
  return typeof value === "string" && (POOL_STRATEGIES as readonly string[]).includes(value);
}

/** Tolerant schedule normalization: invalid entries are dropped, not fatal. */
function normalizeSchedule(raw: unknown): PoolSchedule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const schedule: PoolSchedule = {};
  if (Array.isArray(entry.timeWindows)) {
    const windows = entry.timeWindows
      .map((w): ScheduleTimeWindow | null => {
        if (!w || typeof w !== "object") return null;
        const win = w as Record<string, unknown>;
        if (typeof win.start !== "string" || typeof win.end !== "string") return null;
        if (!TIME_RE.test(win.start) || !TIME_RE.test(win.end)) return null;
        return { start: win.start, end: win.end };
      })
      .filter((w): w is ScheduleTimeWindow => w !== null);
    if (windows.length > 0) schedule.timeWindows = windows;
  }
  if (Array.isArray(entry.days)) {
    const days = entry.days.filter(
      (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
    );
    if (days.length > 0) schedule.days = [...new Set(days)].sort();
  }
  const dr = entry.dateRange;
  if (dr && typeof dr === "object" && !Array.isArray(dr)) {
    const range = dr as Record<string, unknown>;
    const dateRange: ScheduleDateRange = {};
    if (typeof range.start === "string" && DATE_RE.test(range.start)) dateRange.start = range.start;
    if (typeof range.end === "string" && DATE_RE.test(range.end)) dateRange.end = range.end;
    if (dateRange.start || dateRange.end) schedule.dateRange = dateRange;
  }
  const roles = entry.memberRoles;
  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    const memberRoles: Record<string, "primary" | "backup"> = {};
    for (const [id, role] of Object.entries(roles)) {
      if (role === "primary" || role === "backup") memberRoles[id] = role;
    }
    if (Object.keys(memberRoles).length > 0) schedule.memberRoles = memberRoles;
  }
  return Object.keys(schedule).length > 0 ? schedule : undefined;
}

function normalizePool(raw: unknown): CodexPool | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  if (typeof entry.name !== "string" || !entry.name) return null;
  if (!Array.isArray(entry.credentialIds)) return null;
  const schedule = normalizeSchedule(entry.schedule);
  return {
    id: entry.id,
    name: entry.name,
    credentialIds: entry.credentialIds.filter((v): v is string => typeof v === "string" && v.length > 0),
    enabled: entry.enabled !== false,
    cooldownSeconds:
      typeof entry.cooldownSeconds === "number" && entry.cooldownSeconds > 0
        ? entry.cooldownSeconds
        : 60,
    lastUsedIndex: typeof entry.lastUsedIndex === "number" && entry.lastUsedIndex >= -1 ? entry.lastUsedIndex : -1,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    ...(isPoolStrategy(entry.strategy) && entry.strategy !== "round-robin" ? { strategy: entry.strategy } : {}),
    ...(schedule ? { schedule } : {}),
    ...(typeof entry.selector === "string" && entry.selector.trim() ? { selector: entry.selector.trim() } : {}),
  };
}

function normalizeChainTarget(raw: unknown): ChainTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.kind === "pool" && typeof t.poolId === "string" && t.poolId) {
    return { kind: "pool", poolId: t.poolId };
  }
  if (t.kind === "account" && typeof t.credentialId === "string" && t.credentialId) {
    return { kind: "account", credentialId: t.credentialId };
  }
  return null;
}

function normalizeChain(raw: unknown): CodexChain | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  if (typeof entry.name !== "string" || !entry.name) return null;
  if (!Array.isArray(entry.targets)) return null;
  const targets = entry.targets
    .map(normalizeChainTarget)
    .filter((t): t is ChainTarget => t !== null);
  return {
    id: entry.id,
    name: entry.name,
    enabled: entry.enabled !== false,
    targets,
    lastUsedTargetIndex:
      typeof entry.lastUsedTargetIndex === "number" && entry.lastUsedTargetIndex >= -1
        ? entry.lastUsedTargetIndex
        : -1,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
  };
}

function normalizePreset(raw: unknown): CodexPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  if (typeof entry.name !== "string" || !entry.name) return null;
  if (typeof entry.poolId !== "string" || !entry.poolId) return null;
  return {
    id: entry.id,
    name: entry.name,
    enabled: entry.enabled !== false,
    poolId: entry.poolId,
    ...(typeof entry.model === "string" && entry.model.trim() ? { model: entry.model.trim() } : {}),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
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
  if (Array.isArray(raw.pools)) {
    cfg.pools = raw.pools
      .map(normalizePool)
      .filter((p): p is CodexPool => p !== null);
  }
  if (Array.isArray(raw.chains)) {
    cfg.chains = raw.chains
      .map(normalizeChain)
      .filter((c): c is CodexChain => c !== null);
  }
  if (Array.isArray(raw.presets)) {
    cfg.presets = raw.presets
      .map(normalizePreset)
      .filter((p): p is CodexPreset => p !== null);
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
  const poolOverrides = normalizeOverrideRecord<ProjectPoolOverride>(
    accounts.poolOverrides,
    normalizePoolOverride,
  );
  if (poolOverrides) cfg.poolOverrides = poolOverrides;
  const chainOverrides = normalizeOverrideRecord<ProjectChainOverride>(
    accounts.chainOverrides,
    normalizeChainOverride,
  );
  if (chainOverrides) cfg.chainOverrides = chainOverrides;
  if (typeof accounts.migratedFromLegacyAt === "string") {
    cfg.migratedFromLegacyAt = accounts.migratedFromLegacyAt;
  }
  return Object.keys(cfg).length > 0 ? cfg : null;
}

function normalizeOverrideRecord<T>(
  raw: unknown,
  normalize: (v: unknown) => T | null,
): Record<string, T> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, T> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalize(value);
    if (normalized && name) out[name] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePoolOverride(raw: unknown): ProjectPoolOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const out: ProjectPoolOverride = {};
  if (entry.enabled === true || entry.enabled === false) out.enabled = entry.enabled;
  if (Array.isArray(entry.credentialIds)) {
    const ids = entry.credentialIds.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (ids.length > 0) out.credentialIds = ids;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeChainOverride(raw: unknown): ProjectChainOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const out: ProjectChainOverride = {};
  if (entry.enabled === true || entry.enabled === false) out.enabled = entry.enabled;
  if (Array.isArray(entry.targets)) {
    const targets = entry.targets
      .map(normalizeChainTarget)
      .filter((t): t is ChainTarget => t !== null);
    if (targets.length > 0) out.targets = targets;
  }
  return Object.keys(out).length > 0 ? out : null;
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

// ── Pool operations ──────────────────────────────────────────────────────────

/** Resolve a pool by id or name. */
export function resolvePool(cfg: AccountConfig, ref: string): CodexPool | undefined {
  if (!ref) return undefined;
  return (cfg.pools ?? []).find((p) => p.id === ref || p.name === ref.trim());
}

export function listPools(cfg: AccountConfig): CodexPool[] {
  return [...(cfg.pools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve member refs (id/credentialId/label) to credential ids. */
function resolveMemberIds(cfg: AccountConfig, refs: string[]): { ids: string[]; errors: string[] } {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const account = resolveAccount(cfg, ref.trim());
    if (account) {
      if (!ids.includes(account.credentialId)) ids.push(account.credentialId);
    } else {
      errors.push(ref.trim());
    }
  }
  return { ids, errors };
}

export interface CreatePoolResult {
  cfg: AccountConfig;
  pool?: CodexPool;
  created: boolean;
  errors: string[];
}

/**
 * Create an enabled pool from member refs. Unknown refs are rejected and no
 * pool is created. The pool name must be unique.
 */
export function createPool(
  cfg: AccountConfig,
  name: string,
  memberRefs: string[],
  options: { cooldownSeconds?: number } = {},
): CreatePoolResult {
  const trimmed = name.trim();
  const errors: string[] = [];
  if (!trimmed) {
    errors.push("pool name required");
    return { cfg, created: false, errors };
  }
  if (resolvePool(cfg, trimmed)) {
    errors.push(`pool "${trimmed}" already exists`);
    return { cfg, created: false, errors };
  }
  const { ids, errors: memberErrors } = resolveMemberIds(cfg, memberRefs);
  if (memberErrors.length > 0) {
    errors.push(...memberErrors);
    return { cfg, created: false, errors };
  }
  const pool: CodexPool = {
    id: randomUUID(),
    name: trimmed,
    credentialIds: ids,
    enabled: true,
    cooldownSeconds: options.cooldownSeconds ?? 60,
    lastUsedIndex: -1,
    createdAt: new Date().toISOString(),
  };
  return {
    cfg: { ...cfg, pools: [...(cfg.pools ?? []), pool] },
    pool,
    created: true,
    errors: [],
  };
}

export function deletePool(cfg: AccountConfig, ref: string): AccountConfig {
  const pool = resolvePool(cfg, ref);
  if (!pool) return cfg;
  return { ...cfg, pools: (cfg.pools ?? []).filter((p) => p.id !== pool.id) };
}

export function setPoolEnabled(cfg: AccountConfig, ref: string, enabled: boolean): AccountConfig {
  const pool = resolvePool(cfg, ref);
  if (!pool) return cfg;
  return {
    ...cfg,
    pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, enabled } : p)),
  };
}

export function addPoolMembers(
  cfg: AccountConfig,
  ref: string,
  memberRefs: string[],
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  const { ids, errors } = resolveMemberIds(cfg, memberRefs);
  const merged = [...new Set([...pool.credentialIds, ...ids])];
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, credentialIds: merged } : p)),
    },
    ok: true,
    errors,
  };
}

export function removePoolMembers(
  cfg: AccountConfig,
  ref: string,
  memberRefs: string[],
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  const { ids, errors } = resolveMemberIds(cfg, memberRefs);
  if (errors.length > 0) return { cfg, ok: false, errors };
  const keep = pool.credentialIds.filter((id) => !ids.includes(id));
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, credentialIds: keep } : p)),
    },
    ok: true,
    errors: [],
  };
}

// ── Pool strategy operations ─────────────────────────────────────────────────

export function setPoolStrategy(
  cfg: AccountConfig,
  ref: string,
  strategy: string,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  if (!isPoolStrategy(strategy)) {
    return { cfg, ok: false, errors: [`invalid strategy "${strategy}" (round-robin, quota-first, scheduled, custom)`] };
  }
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) =>
        p.id === pool.id ? { ...p, ...(strategy === "round-robin" ? { strategy: undefined } : { strategy }) } : p
      ),
    },
    ok: true,
    errors: [],
  };
}

export function setPoolSchedule(
  cfg: AccountConfig,
  ref: string,
  schedule: PoolSchedule,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  const normalized = normalizeSchedule(schedule);
  if (!normalized) return { cfg, ok: false, errors: [`no valid schedule constraints given`] };
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, schedule: normalized } : p)),
    },
    ok: true,
    errors: [],
  };
}

export function clearPoolSchedule(
  cfg: AccountConfig,
  ref: string,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, schedule: undefined } : p)),
    },
    ok: true,
    errors: [],
  };
}

export function setPoolSelector(
  cfg: AccountConfig,
  ref: string,
  selector: string,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  const trimmed = selector.trim();
  if (!trimmed) return { cfg, ok: false, errors: [`selector command required`] };
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, selector: trimmed } : p)),
    },
    ok: true,
    errors: [],
  };
}

export function clearPoolSelector(
  cfg: AccountConfig,
  ref: string,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const pool = resolvePool(cfg, ref);
  if (!pool) return { cfg, ok: false, errors: [`pool "${ref}" not found`] };
  return {
    cfg: {
      ...cfg,
      pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, selector: undefined } : p)),
    },
    ok: true,
    errors: [],
  };
}

// ── Chain operations ─────────────────────────────────────────────────────────

/** Resolve a chain by id or name. */
export function resolveChain(cfg: AccountConfig, ref: string): CodexChain | undefined {
  if (!ref) return undefined;
  return (cfg.chains ?? []).find((c) => c.id === ref || c.name === ref.trim());
}

/** Resolve a pool by exact id (chains store pool ids). */
export function resolvePoolById(cfg: AccountConfig, poolId: string): CodexPool | undefined {
  return (cfg.pools ?? []).find((p) => p.id === poolId);
}

/**
 * Resolve a CLI target token to a chain target: a pool ref (id/name) wins,
 * then an account ref (id/credentialId/label). Undefined when unknown.
 */
export function resolveTargetRef(cfg: AccountConfig, ref: string): ChainTarget | undefined {
  const pool = resolvePool(cfg, ref);
  if (pool) return { kind: "pool", poolId: pool.id };
  const account = resolveAccount(cfg, ref);
  if (account) return { kind: "account", credentialId: account.credentialId };
  return undefined;
}

function sameTarget(a: ChainTarget, b: ChainTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "pool"
    ? a.poolId === (b as { poolId: string }).poolId
    : a.credentialId === (b as { credentialId: string }).credentialId;
}

export { sameTarget };

function hasTarget(targets: ChainTarget[], target: ChainTarget): boolean {
  return targets.some((t) => sameTarget(t, target));
}

function resolveTargetRefs(
  cfg: AccountConfig,
  refs: string[],
): { targets: ChainTarget[]; errors: string[] } {
  const targets: ChainTarget[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const target = resolveTargetRef(cfg, ref.trim());
    if (target) {
      if (!hasTarget(targets, target)) targets.push(target);
    } else {
      errors.push(ref.trim());
    }
  }
  return { targets, errors };
}

export interface CreateChainResult {
  cfg: AccountConfig;
  chain?: CodexChain;
  created: boolean;
  errors: string[];
}

/**
 * Create an enabled chain from ordered target refs. Unknown refs are rejected
 * and no chain is created. The chain name must be unique.
 */
export function createChain(
  cfg: AccountConfig,
  name: string,
  targetRefs: string[],
): CreateChainResult {
  const trimmed = name.trim();
  const errors: string[] = [];
  if (!trimmed) {
    errors.push("chain name required");
    return { cfg, created: false, errors };
  }
  if (resolveChain(cfg, trimmed)) {
    errors.push(`chain "${trimmed}" already exists`);
    return { cfg, created: false, errors };
  }
  if (targetRefs.length === 0) {
    errors.push("at least one target required (a pool or account ref)");
    return { cfg, created: false, errors };
  }
  const { targets, errors: targetErrors } = resolveTargetRefs(cfg, targetRefs);
  if (targetErrors.length > 0) {
    errors.push(...targetErrors.map((t) => `unknown target "${t}"`));
    return { cfg, created: false, errors };
  }
  const chain: CodexChain = {
    id: randomUUID(),
    name: trimmed,
    enabled: true,
    targets,
    lastUsedTargetIndex: -1,
    createdAt: new Date().toISOString(),
  };
  return {
    cfg: { ...cfg, chains: [...(cfg.chains ?? []), chain] },
    chain,
    created: true,
    errors: [],
  };
}

export function deleteChain(cfg: AccountConfig, ref: string): AccountConfig {
  const chain = resolveChain(cfg, ref);
  if (!chain) return cfg;
  return { ...cfg, chains: (cfg.chains ?? []).filter((c) => c.id !== chain.id) };
}

export function setChainEnabled(
  cfg: AccountConfig,
  ref: string,
  enabled: boolean,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const chain = resolveChain(cfg, ref);
  if (!chain) return { cfg, ok: false, errors: [`chain "${ref}" not found`] };
  return {
    cfg: {
      ...cfg,
      chains: (cfg.chains ?? []).map((c) => (c.id === chain.id ? { ...c, enabled } : c)),
    },
    ok: true,
    errors: [],
  };
}

export function addChainTargets(
  cfg: AccountConfig,
  ref: string,
  targetRefs: string[],
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const chain = resolveChain(cfg, ref);
  if (!chain) return { cfg, ok: false, errors: [`chain "${ref}" not found`] };
  if (targetRefs.length === 0) return { cfg, ok: false, errors: ["at least one target required"] };
  const { targets, errors } = resolveTargetRefs(cfg, targetRefs);
  if (errors.length > 0) return { cfg, ok: false, errors: errors.map((t) => `unknown target "${t}"`) };
  const merged = [...chain.targets];
  for (const target of targets) {
    if (!hasTarget(merged, target)) merged.push(target);
  }
  return {
    cfg: {
      ...cfg,
      chains: (cfg.chains ?? []).map((c) => (c.id === chain.id ? { ...c, targets: merged } : c)),
    },
    ok: true,
    errors: [],
  };
}

export function removeChainTargets(
  cfg: AccountConfig,
  ref: string,
  targetRefs: string[],
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const chain = resolveChain(cfg, ref);
  if (!chain) return { cfg, ok: false, errors: [`chain "${ref}" not found`] };
  const { targets, errors } = resolveTargetRefs(cfg, targetRefs);
  if (errors.length > 0) return { cfg, ok: false, errors: errors.map((t) => `unknown target "${t}"`) };
  const keep = chain.targets.filter((t) => !hasTarget(targets, t));
  return {
    cfg: {
      ...cfg,
      chains: (cfg.chains ?? []).map((c) => (c.id === chain.id ? { ...c, targets: keep } : c)),
    },
    ok: true,
    errors: [],
  };
}

// ── Preset operations ────────────────────────────────────────────────────────

/** Resolve a preset by id or name. */
export function resolvePreset(cfg: AccountConfig, ref: string): CodexPreset | undefined {
  if (!ref) return undefined;
  return (cfg.presets ?? []).find((p) => p.id === ref || p.name === ref.trim());
}

export interface CreatePresetResult {
  cfg: AccountConfig;
  preset?: CodexPreset;
  created: boolean;
  errors: string[];
}

/**
 * Create an enabled preset for a pool. The pool ref must resolve to an
 * existing pool; unknown refs are rejected without touching the config.
 */
export function createPreset(
  cfg: AccountConfig,
  name: string,
  poolRef: string,
  model: string | undefined,
): CreatePresetResult {
  const trimmed = name.trim();
  const errors: string[] = [];
  if (!trimmed) {
    errors.push("preset name required");
    return { cfg, created: false, errors };
  }
  if (resolvePreset(cfg, trimmed)) {
    errors.push(`preset "${trimmed}" already exists`);
    return { cfg, created: false, errors };
  }
  const pool = resolvePool(cfg, poolRef);
  if (!pool) {
    errors.push(`pool "${poolRef}" not found`);
    return { cfg, created: false, errors };
  }
  const preset: CodexPreset = {
    id: randomUUID(),
    name: trimmed,
    enabled: true,
    poolId: pool.id,
    ...(model && model.trim() ? { model: model.trim() } : {}),
    createdAt: new Date().toISOString(),
  };
  return {
    cfg: { ...cfg, presets: [...(cfg.presets ?? []), preset] },
    preset,
    created: true,
    errors: [],
  };
}

export function deletePreset(cfg: AccountConfig, ref: string): AccountConfig {
  const preset = resolvePreset(cfg, ref);
  if (!preset) return cfg;
  return { ...cfg, presets: (cfg.presets ?? []).filter((p) => p.id !== preset.id) };
}

export function setPresetEnabled(
  cfg: AccountConfig,
  ref: string,
  enabled: boolean,
): { cfg: AccountConfig; ok: boolean; errors: string[] } {
  const preset = resolvePreset(cfg, ref);
  if (!preset) return { cfg, ok: false, errors: [`preset "${ref}" not found`] };
  return {
    cfg: {
      ...cfg,
      presets: (cfg.presets ?? []).map((p) => (p.id === preset.id ? { ...p, enabled } : p)),
    },
    ok: true,
    errors: [],
  };
}

// ── Effective config (global + trusted project overrides) ───────────────────

/**
 * Merge trusted project overrides onto the global config: a project
 * pool/chain override keyed by the global entry's name replaces the overridden
 * fields. Global entries without an override are kept as-is (global config is
 * the fallback). Returns a NEW config; nothing is persisted.
 */
export function resolveEffectiveConfig(
  global: AccountConfig,
  project: ProjectAccountConfig | null,
): AccountConfig {
  if (!project) return global;
  let pools = global.pools ?? [];
  if (project.poolOverrides) {
    pools = pools.map((pool) => {
      const override = project.poolOverrides![pool.name];
      if (!override) return pool;
      return {
        ...pool,
        ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
        ...(override.credentialIds !== undefined ? { credentialIds: override.credentialIds } : {}),
      };
    });
  }
  let chains = global.chains ?? [];
  if (project.chainOverrides) {
    chains = chains.map((chain) => {
      const override = project.chainOverrides![chain.name];
      if (!override) return chain;
      return {
        ...chain,
        ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
        ...(override.targets !== undefined ? { targets: override.targets } : {}),
      };
    });
  }
  return { ...global, pools, chains };
}
