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

export interface AccountMigrationState {
  globalMigratedAt?: string;
  projectMigratedAt?: string;
  globalSourceHash?: string;
  projectSourceHash?: string;
}

/** Beautiful-pi account namespace (the `accounts` key of the settings file). */
export interface AccountConfig {
  version: 1;
  accounts: CodexAccount[];
  activeAccountId?: string;
  migration?: AccountMigrationState;
}

/** Project-level account restriction (`.pi/beautiful-pi.json`). */
export interface ProjectAccountConfig {
  /** Credential ids allowed in this project; absent/undefined means allow all. */
  allowedCredentialIds?: string[];
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

export type { Credential, Provider };
