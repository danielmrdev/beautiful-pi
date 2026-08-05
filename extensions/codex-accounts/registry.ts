/**
 * Provider adapter registry — the seam for future account providers.
 *
 * Codex is the first adapter. Future providers (e.g. opencode-go) register
 * their own adapter and inherit the account command surface.
 */
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Credential, Model, Provider } from "@earendil-works/pi-ai";
import type { AccountAuthStatus, ProviderAccountAdapter } from "./types.ts";

const adapters = new Map<string, ProviderAccountAdapter>();

export function registerProviderAdapter(adapter: ProviderAccountAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getProviderAdapter(id: string): ProviderAccountAdapter | undefined {
  return adapters.get(id);
}

// ── Codex adapter ────────────────────────────────────────────────────────────

function remapModels(base: Provider, credentialId: string): Model<any>[] {
  return base.getModels().map((model) => ({ ...model, provider: credentialId }));
}

function formatExpiry(credential: Credential | undefined): string {
  if (!credential || credential.type !== "oauth") return "";
  const expires = credential.expires;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) return "";
  const when = new Date(expires * 1000);
  if (Number.isNaN(when.getTime())) return "";
  return `expires ${when.toISOString().slice(0, 10)}`;
}

const codexAdapter: ProviderAccountAdapter = {
  id: "openai-codex",
  displayName: "OpenAI Codex",
  credentialType: "oauth",
  buildProvider(credentialId: string, label?: string): Provider | undefined {
    try {
      // Pi's extension loader aliases the pi-ai root to the compat entrypoint
      // and only whitelists specific subpaths (providers/all, compat, oauth);
      // per-provider subpaths like providers/openai-codex are NOT aliased, so
      // the base provider is looked up through the supported builtins entry.
      const base = builtinProviders().find((p) => p.id === "openai-codex");
      if (!base) return undefined;
      return {
        ...base,
        id: credentialId,
        name: label ? `${label} (Codex)` : base.name,
        getModels: () => remapModels(base, credentialId),
      };
    } catch {
      return undefined;
    }
  },
  statusLine(status: AccountAuthStatus | undefined, credential: Credential | undefined): string {
    if (!status?.configured) return "not authenticated";
    const expiry = formatExpiry(credential);
    return expiry ? `authenticated (${expiry})` : "authenticated";
  },
};

registerProviderAdapter(codexAdapter);
