/**
 * Provider registration for managed accounts.
 *
 * pi's built-in `/login` only lists providers whose auth.oauth is registered,
 * so each suffixed account gets its own provider clone (id `openai-codex-N`)
 * whose OAuth flow is the same lazy Codex flow pi itself uses. The base
 * `openai-codex` provider is never touched.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getProviderAdapter } from "./registry.ts";
import type { CodexAccount } from "./types.ts";

const SUFFIXED_RE = /^openai-codex-(\d+)$/;

export function isSuffixedCodexId(credentialId: string): boolean {
  return SUFFIXED_RE.test(credentialId);
}

/** Next free credential id. The base `openai-codex` counts as slot 1. */
export function nextCodexCredentialId(existingIds: string[]): string {
  let max = 1; // base openai-codex
  for (const id of existingIds) {
    const match = SUFFIXED_RE.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `openai-codex-${max + 1}`;
}

/**
 * Register (or re-register) the provider for an account so that `/login` can
 * authenticate it and its models are selectable. Idempotent: re-registration
 * overwrites the previous registration.
 */
export function registerAccountProvider(
  modelRegistry: ModelRegistry,
  account: CodexAccount,
): boolean {
  const adapter = getProviderAdapter(account.provider);
  if (!adapter) return false;
  // The base provider is registered by pi itself; only suffixed ids need ours.
  if (!isSuffixedCodexId(account.credentialId)) return false;
  const provider = adapter.buildProvider(account.credentialId, account.label);
  if (!provider) return false;
  try {
    modelRegistry.registerProvider(provider);
    return true;
  } catch {
    return false;
  }
}

/** Re-register providers for every suffixed account (e.g. after /reload). */
export function registerAllAccountProviders(
  modelRegistry: ModelRegistry,
  accounts: CodexAccount[],
): number {
  let registered = 0;
  for (const account of accounts) {
    if (registerAccountProvider(modelRegistry, account)) registered++;
  }
  return registered;
}
