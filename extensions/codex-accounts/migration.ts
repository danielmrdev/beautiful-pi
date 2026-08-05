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
 * - Reruns are idempotent: the `.migrated` marker file and/or the migration
 *   marker in the account config short-circuit.
 * - Malformed files and unknown/malformed entries are skipped with warnings;
 *   they never corrupt valid account configuration.
 * - pi's auth.json credential store is never read-write-touched here.
 */
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
import { copyFile, loadGlobalAccountConfig, loadProjectAccountConfig, renameFile, saveGlobalAccountConfig, saveProjectAccountConfig, addAccount, agentDirPath } from "./store.ts";
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

function readLegacyJson(path: string): { content: string; parsed: LegacyConfig | null } {
  try {
    if (!existsSync(path)) return { content: "", parsed: null };
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    return {
      content,
      parsed:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as LegacyConfig)
          : null,
    };
  } catch {
    return { content: "", parsed: null };
  }
}

function sourceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function backupPath(path: string): string {
  return `${path}.bak-${Date.now()}`;
}

export interface MigrateOptions {
  /** Override "now" for deterministic tests. */
  now?: number;
}

/**
 * Migrate the global legacy file into the account config. Returns a summary;
 * never throws for malformed input.
 */
export function migrateGlobalLegacy(agentDir: string, opts: MigrateOptions = {}): MigrationSummary {
  const summary: MigrationSummary = { global: "none", project: "none", accountsCreated: 0, warnings: [] };
  const legacyPath = join(agentDir, "multi-pass.json");
  const migratedPath = `${legacyPath}.migrated`;
  const settingsPath = join(agentDir, "beautiful-pi.json");

  if (!existsSync(legacyPath)) return summary;

  const cfg = loadGlobalAccountConfig(settingsPath);

  // Already renamed by a previous run — nothing to do.
  if (existsSync(migratedPath)) {
    summary.global = "already";
    return summary;
  }

  // Backup before changing the legacy file.
  const backup = backupPath(legacyPath);
  if (!copyFile(legacyPath, backup)) {
    summary.global = "failed";
    summary.warnings.push(`could not create backup at ${backup}`);
    return summary;
  }

  const { content, parsed } = readLegacyJson(legacyPath);

  // Marker exists but the rename did not land (e.g. user restored the file).
  if (cfg.migration?.globalMigratedAt) {
    renameFile(legacyPath, migratedPath);
    summary.global = "already";
    return summary;
  }

  if (!parsed) {
    renameFile(legacyPath, migratedPath);
    summary.global = "skipped-malformed";
    summary.warnings.push(`legacy ${legacyPath} was not valid JSON; left as-is in ${migratedPath}`);
    return summary;
  }

  const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
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
    const result = addAccount(nextCfg, {
      provider: "openai-codex",
      credentialId,
      label,
      active: !nextCfg.activeAccountId && nextCfg.accounts.length === 0,
    });
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
    migration: {
      ...nextCfg.migration,
      globalMigratedAt: new Date(opts.now ?? Date.now()).toISOString(),
      globalSourceHash: sourceHash(content),
    },
  };
  if (!nextCfg.activeAccountId && nextCfg.accounts.length > 0) {
    const first = nextCfg.accounts.find((a) => a.active) ?? nextCfg.accounts[0];
    nextCfg = { ...nextCfg, activeAccountId: first.id };
  }
  saveGlobalAccountConfig(nextCfg, settingsPath);

  // Mark the legacy file as consumed so pi-multi-pass cannot double-apply.
  renameFile(legacyPath, migratedPath);

  summary.global = "migrated";
  summary.accountsCreated = created;
  return summary;
}

/** Migrate a project-level legacy file into `.pi/beautiful-pi.json`. */
export function migrateProjectLegacy(cwd: string, opts: MigrateOptions = {}): MigrationSummary {
  const summary: MigrationSummary = { global: "none", project: "none", accountsCreated: 0, warnings: [] };
  const legacyPath = join(cwd, ".pi", "multi-pass.json");
  const migratedPath = `${legacyPath}.migrated`;

  if (!existsSync(legacyPath)) return summary;

  if (existsSync(migratedPath)) {
    summary.project = "already";
    return summary;
  }

  const backup = backupPath(legacyPath);
  if (!copyFile(legacyPath, backup)) {
    summary.project = "failed";
    summary.warnings.push(`could not create backup at ${backup}`);
    return summary;
  }

  const { parsed } = readLegacyJson(legacyPath);
  if (!parsed) {
    renameFile(legacyPath, migratedPath);
    summary.project = "skipped-malformed";
    summary.warnings.push(`legacy ${legacyPath} was not valid JSON; left as-is in ${migratedPath}`);
    return summary;
  }

  const allowedSubs = Array.isArray(parsed.allowedSubs) ? parsed.allowedSubs : [];
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

  if (valid.length > 0) {
    const existing = loadProjectAccountConfig(cwd);
    const merged = [...new Set([...(existing?.allowedCredentialIds ?? []), ...valid])];
    saveProjectAccountConfig(cwd, { allowedCredentialIds: merged });
    summary.project = "migrated";
  } else {
    summary.project = "skipped-malformed";
    summary.warnings.push("legacy project config had no valid Codex allowedSubs; nothing migrated");
  }

  renameFile(legacyPath, migratedPath);

  // Record project migration time in the global account config.
  const cfg = loadGlobalAccountConfig();
  const now = new Date(opts.now ?? Date.now()).toISOString();
  if (cfg.migration?.projectMigratedAt !== now) {
    saveGlobalAccountConfig({
      ...cfg,
      migration: { ...cfg.migration, projectMigratedAt: now },
    }, join(agentDirPath(), "beautiful-pi.json"));
  }

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

function emptySummary(): MigrationSummary {
  return { global: "none", project: "none", accountsCreated: 0, warnings: [] };
}
