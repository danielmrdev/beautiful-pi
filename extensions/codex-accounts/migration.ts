/**
 * Legacy pi-multi-pass configuration migration.
 *
 * Clean-room: reads the legacy config *data format* (global
 * `~/.pi/agent/multi-pass.json`, project `.pi/multi-pass.json`) and writes the
 * new account namespace. No pi-multi-pass source is used.
 *
 * Safety contract:
 * - A backup copy is created before the legacy file is changed (renamed to
 *   `*.migrated` once migration succeeded).
 * - Reruns are idempotent: the `.migrated` marker file and/or a migration
 *   marker short-circuit.
 * - Malformed files are left untouched (no backup, no rename) so a fixed file
 *   can migrate on a later run. Unknown/malformed entries are skipped with
 *   warnings; they never corrupt valid account configuration.
 * - pi's auth.json credential store is never read-write-touched here.
 */
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
import {
  copyFile,
  loadGlobalAccountConfig,
  loadProjectAccountConfig,
  renameFile,
  saveGlobalAccountConfig,
  saveProjectAccountConfig,
  addAccount,
  agentDirPath,
} from "./store.ts";
import { isSuffixedCodexId } from "./provider.ts";
import type { AccountConfig, CodexAccount } from "./types.ts";

export interface MigrationSummary {
  global: "none" | "already" | "migrated" | "skipped-malformed" | "failed";
  project: "none" | "already" | "migrated" | "skipped-malformed" | "skipped-untrusted" | "failed";
  accountsCreated: number;
  warnings: string[];
}

interface LegacySubscription {
  provider?: unknown;
  index?: unknown;
  label?: unknown;
}

interface LegacyConfig {
  subscriptions?: unknown;
  allowedSubs?: unknown;
}

type LegacyOpen =
  | { kind: "none" }
  | { kind: "already" }
  | { kind: "malformed" }
  | { kind: "failed" }
  | { kind: "ready"; parsed: LegacyConfig };

const OPEN_STATUS: Record<Exclude<LegacyOpen["kind"], "ready">, "none" | "already" | "skipped-malformed" | "failed"> = {
  none: "none",
  already: "already",
  malformed: "skipped-malformed",
  failed: "failed",
};

function emptySummary(): MigrationSummary {
  return { global: "none", project: "none", accountsCreated: 0, warnings: [] };
}

function readLegacyJson(path: string): { parsed: LegacyConfig | null } {
  try {
    if (!existsSync(path)) return { parsed: null };
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return {
      parsed:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as LegacyConfig)
          : null,
    };
  } catch {
    return { parsed: null };
  }
}

/**
 * Shared legacy-file handling: idempotency checks, tolerant parse, backup.
 * Malformed files are NOT consumed — they stay in place so a later fix can
 * migrate. Returns "none" (no file), "already" (consumed or marked before),
 * "malformed" (unparseable, untouched), "failed" (backup error), or "ready"
 * with a fresh backup in place.
 */
function openLegacy(
  path: string,
  migratedPath: string,
  markerPresent: boolean,
  warnings: string[],
): LegacyOpen {
  if (!existsSync(path)) return { kind: "none" };
  if (existsSync(migratedPath)) return { kind: "already" };
  if (markerPresent) {
    // Marker set but the file still exists (e.g. restored from backup):
    // consume it without re-migrating.
    renameFile(path, migratedPath);
    return { kind: "already" };
  }
  const { parsed } = readLegacyJson(path);
  if (!parsed) {
    warnings.push(`legacy ${path} is not valid JSON; left unchanged`);
    return { kind: "malformed" };
  }
  const backupPath = `${path}.bak-${Date.now()}`;
  if (!copyFile(path, backupPath)) {
    warnings.push(`could not create backup at ${backupPath}`);
    return { kind: "failed" };
  }
  return { kind: "ready", parsed };
}

/** Migrate the global legacy file into the account config. Never throws. */
export function migrateGlobalLegacy(agentDir: string): MigrationSummary {
  const summary = emptySummary();
  const legacyPath = join(agentDir, "multi-pass.json");
  const migratedPath = `${legacyPath}.migrated`;
  const settingsPath = join(agentDir, "beautiful-pi.json");
  const cfg = loadGlobalAccountConfig(settingsPath);

  const opened = openLegacy(legacyPath, migratedPath, !!cfg.migration?.globalMigratedAt, summary.warnings);
  if (opened.kind !== "ready") {
    summary.global = OPEN_STATUS[opened.kind];
    return summary;
  }

  const subscriptions = Array.isArray(opened.parsed.subscriptions) ? opened.parsed.subscriptions : [];
  let nextCfg: AccountConfig = cfg;
  let created = 0;

  for (const raw of subscriptions) {
    if (!raw || typeof raw !== "object") {
      summary.warnings.push("skipped subscription entry that was not an object");
      continue;
    }
    const sub = raw as LegacySubscription;
    if (typeof sub.provider !== "string" || !sub.provider) {
      summary.warnings.push("skipped subscription without a provider");
      continue;
    }
    if (sub.provider !== "openai-codex" && !isSuffixedCodexId(sub.provider)) {
      summary.warnings.push(`skipped unknown provider "${sub.provider}"`);
      continue;
    }
    // The legacy provider field is the auth.json credential id.
    const credentialId = sub.provider;
    if (nextCfg.accounts.some((a) => a.credentialId === credentialId)) {
      summary.warnings.push(`account for "${credentialId}" already exists; skipped duplicate`);
      continue;
    }
    const label =
      typeof sub.label === "string" && sub.label.trim() ? sub.label.trim() : sub.provider;
    const legacy: CodexAccount["legacy"] = {
      ...(typeof sub.index === "number" ? { index: sub.index } : {}),
      source: "multi-pass",
    };
    const result = addAccount(nextCfg, { provider: "openai-codex", credentialId, label });
    if (result.created) {
      nextCfg = {
        ...result.cfg,
        accounts: result.cfg.accounts.map((a) =>
          a.id === result.account.id ? { ...a, legacy } : a
        ),
      };
      created++;
    }
  }

  nextCfg = {
    ...nextCfg,
    migration: { globalMigratedAt: new Date().toISOString() },
  };
  saveGlobalAccountConfig(nextCfg, settingsPath);

  // Mark the legacy file as consumed so pi-multi-pass cannot double-apply.
  renameFile(legacyPath, migratedPath);

  summary.global = "migrated";
  summary.accountsCreated = created;
  return summary;
}

/** Migrate a project-level legacy file into `.pi/beautiful-pi.json`. */
export function migrateProjectLegacy(cwd: string): MigrationSummary {
  const summary = emptySummary();
  const legacyPath = join(cwd, ".pi", "multi-pass.json");
  const migratedPath = `${legacyPath}.migrated`;
  const existing = loadProjectAccountConfig(cwd);

  const opened = openLegacy(legacyPath, migratedPath, !!existing?.migratedFromLegacyAt, summary.warnings);
  if (opened.kind !== "ready") {
    summary.project = OPEN_STATUS[opened.kind];
    return summary;
  }

  const allowedSubs = Array.isArray(opened.parsed.allowedSubs) ? opened.parsed.allowedSubs : [];
  const valid: string[] = [];
  for (const raw of allowedSubs) {
    if (typeof raw !== "string" || !raw) {
      summary.warnings.push("skipped empty allowedSubs entry");
      continue;
    }
    if (raw !== "openai-codex" && !isSuffixedCodexId(raw)) {
      summary.warnings.push(`skipped unknown allowedSub "${raw}"`);
      continue;
    }
    valid.push(raw);
  }

  const merged = [...new Set([...(existing?.allowedCredentialIds ?? []), ...valid])];
  const migratedAt = new Date().toISOString();
  saveProjectAccountConfig(cwd, {
    ...(merged.length > 0 ? { allowedCredentialIds: merged } : {}),
    migratedFromLegacyAt: migratedAt,
  });

  renameFile(legacyPath, migratedPath);

  summary.project = valid.length > 0 ? "migrated" : "skipped-malformed";
  return summary;
}

/** Run both migrations; project is only attempted when the project is trusted. */
export function runMigration(
  agentDir: string,
  cwd: string,
  options: { trusted: boolean },
): MigrationSummary {
  const global = migrateGlobalLegacy(agentDir);
  const project = options.trusted
    ? migrateProjectLegacy(cwd)
    : { ...emptySummary(), project: "skipped-untrusted" as const };
  return {
    global: global.global,
    project: project.project,
    accountsCreated: global.accountsCreated,
    warnings: [...global.warnings, ...project.warnings],
  };
}
