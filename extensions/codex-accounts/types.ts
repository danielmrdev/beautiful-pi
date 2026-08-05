/**
 * Shared types for the codex-accounts-pool foundation.
 *
 * Clean-room design: account lifecycle and config migration for Codex
 * subscriptions, keyed on pi's existing OAuth credential store (auth.json).
 */
import type { Credential, Provider } from "@earendil-works/pi-ai";

/** A managed Codex subscription. `credentialId` is the auth.json provider key. */
export interface CodexAccount {
  /** Stable account id (does not change when credential id or label changes). */
  id: string;
  /** Provider adapter id (e.g. "openai-codex"). */
  provider: string;
  /** auth.json credential key (e.g. "openai-codex", "openai-codex-2"). */
  credentialId: string;
  /** Human label. */
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Single active account per scope. */
  active?: boolean;
  /** Provenance when created by migration. */
  legacy?: {
    index?: number;
    source: "multi-pass";
  };
}

/** Global migration bookkeeping inside the account namespace. */
export interface AccountMigrationState {
  globalMigratedAt?: string;
}

/**
 * A Codex pool: an ordered group of accounts for round-robin routing and
 * rate-limit failover. `credentialIds` order is the rotation order.
 */
export interface CodexPool {
  id: string;
  /** Unique display name. */
  name: string;
  /** Member credential ids, in rotation order. */
  credentialIds: string[];
  enabled: boolean;
  /** Seconds an exhausted member is skipped after a rate limit. */
  cooldownSeconds: number;
  /** Round-robin pointer (index into credentialIds of the last used member). */
  lastUsedIndex: number;
  createdAt: string;
  /**
   * Member selection strategy for `/codex pool use`. Absent/"round-robin" is
   * the deterministic rotation pointer scan; the others are advanced selection.
   * Rate-limit failover always uses round-robin.
   */
  strategy?: PoolStrategy;
  /** Schedule + member roles used by the "scheduled" strategy. */
  schedule?: PoolSchedule;
  /** Shell command invoked by the "custom" strategy to pick a member. */
  selector?: string;
}

/** Member selection strategy for a pool. */
export type PoolStrategy = "round-robin" | "quota-first" | "scheduled" | "custom";

/** "HH:MM" (24h) inclusive window in the pool's local timezone. */
export interface ScheduleTimeWindow {
  start: string;
  end: string;
}

/** "YYYY-MM-DD" inclusive date range. */
export interface ScheduleDateRange {
  start?: string;
  end?: string;
}

/**
 * The "scheduled" strategy config. Empty constraints match everything;
 * members not listed in `memberRoles` act as primary.
 */
export interface PoolSchedule {
  /** Empty/absent = no time constraint. An overnight window wraps past midnight. */
  timeWindows?: ScheduleTimeWindow[];
  /** Day-of-week filter, 0=Sunday..6=Saturday. Empty/absent = every day. */
  days?: number[];
  /** Date range filter (inclusive). */
  dateRange?: ScheduleDateRange;
  /** Per-member role; "backup" members are only used when no primary is eligible. */
  memberRoles?: Record<string, "primary" | "backup">;
}

/** Beautiful-pi account namespace (the `accounts` key of the settings file). */
export interface AccountConfig {
  version: 1;
  accounts: CodexAccount[];
  activeAccountId?: string;
  migration?: AccountMigrationState;
  pools?: CodexPool[];
}

/**
 * Project-level account configuration (`.pi/beautiful-pi.json`).
 * `migratedFromLegacyAt` is the per-project idempotency marker set when the
 * project's legacy `.pi/multi-pass.json` was consumed.
 */
export interface ProjectAccountConfig {
  /** Credential ids allowed in this project; absent/undefined means allow all. */
  allowedCredentialIds?: string[];
  migratedFromLegacyAt?: string;
}

/** Structural mirror of pi's AuthStatus (not exported by pi-coding-agent). */
export interface AccountAuthStatus {
  configured: boolean;
  source?: string;
  label?: string;
}

/**
 * Provider adapter seam. Future providers (e.g. opencode-go) register their
 * own adapter instead of re-implementing account, command, and status logic.
 */
export interface ProviderAccountAdapter {
  /** Provider id in pi's model registry (e.g. "openai-codex"). */
  id: string;
  displayName: string;
  credentialType: "oauth" | "apiKey";
  /**
   * Build a pi-ai Provider for a suffixed credential id so that pi's built-in
   * `/login` can authenticate it and its models become selectable. Returns
   * undefined when the adapter cannot build a provider (e.g. base catalog
   * unavailable).
   */
  buildProvider(credentialId: string, label?: string): Provider | undefined;
  /** Short human status line for an account row. */
  statusLine(status: AccountAuthStatus | undefined, credential: Credential | undefined): string;
}
