/**
 * /reload-models — refresh model listings from provider APIs.
 *
 * Discovers which providers have credentials (auth.json + env vars + models.json),
 * fetches their model lists from the provider's API, and registers them with pi.
 *
 * No more waiting for pi releases to get new models.
 *
 * Usage:
 *   /reload-models                — refresh all configured providers
 *   /reload-models anthropic openai — refresh specific providers only
 *   /reload-models -list          — show detected providers (dry-run, no fetch)
 *
 * To auto-refresh on session start, uncomment the `session_start` event at the bottom.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────

/** Pi model config shape — subset of ProviderModelConfig. */
interface ModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  baseUrl?: string;
  api?: string;
}

/** A provider known to the model-list fetcher. */
interface ProviderDef {
  /** Pi provider ID, e.g. "anthropic", "openai". */
  id: string;
  /** Display label for status messages. */
  label: string;
  /** API base URL (must end without trailing slash). */
  baseUrl: string;
  /** Path for the model-list endpoint, relative to baseUrl. */
  modelsPath: string;
  /** Pi streaming API type. */
  api: string;
  /** How to authenticate the model-list request. */
  authType: "bearer" | "x-api-key" | "query-key";
  /** Header name for the auth token (default depends on authType). */
  authHeader?: string;
  /** Extra headers always sent with the request. */
  extraHeaders?: Record<string, string>;
  /** Dynamic header builder — called with resolved apiKey before fetch. */
  prepareHeaders?: (apiKey: string) => Record<string, string>;
  /** Parse the full API response body → array of raw model objects. */
  parseList: (json: any) => any[];
  /** Transform one raw model object → ModelDef. */
  transform: (raw: any) => ModelDef;
}

// ── Provider registry ────────────────────────────────────────────────────

const PROVIDERS: ProviderDef[] = [
  // ── OpenAI ──────────────────────────────────────────────────────────
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    modelsPath: "/v1/models",
    api: "openai-responses",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => {
      const id = m.id;
      const isReasoning = /\b(o[13]|o[34]-mini|o4-mini)\b/i.test(id);
      return {
        id,
        name: id,
        reasoning: isReasoning,
        input: detectMultimodal(id),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      };
    },
  },

  // ── Anthropic ───────────────────────────────────────────────────────
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    modelsPath: "/v1/models",
    api: "anthropic-messages",
    authType: "x-api-key",
    authHeader: "x-api-key",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    parseList: (j) => j.data ?? [],
    transform: (m) => {
      const id = m.id;
      const name = m.display_name ?? id;
      // claude-3-haiku and claude-3-sonnet don't support thinking
      const isReasoning = !/\b(claude-3-haiku|claude-3-sonnet)\b/i.test(id);
      // claude-3-opus-4 and claude-sonnet-4+ have 200K context, older models have 100K or 200K
      return {
        id,
        name,
        reasoning: isReasoning,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      };
    },
  },

  // ── Google Gemini ───────────────────────────────────────────────────
  {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsPath: "/models",
    api: "google-generative-ai",
    authType: "query-key",
    parseList: (j) => j.models ?? [],
    transform: (m) => {
      const parts = m.name.split("/");
      const id = parts[parts.length - 1] ?? m.name;
      return {
        id,
        name: m.displayName ?? id,
        reasoning: true,
        input: detectMultimodal(id),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.inputTokenLimit ?? 128000,
        maxTokens: m.outputTokenLimit ?? 8192,
      };
    },
  },

  // ── DeepSeek ────────────────────────────────────────────────────────
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    modelsPath: "/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => {
      const id = m.id;
      const isReasoning = /reasoner|deepthink/i.test(id);
      return {
        id,
        name: id,
        reasoning: isReasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // deepseek-chat = 1M, deepseek-reasoner = 128K
        contextWindow: /deepseek-chat/i.test(id) ? 1_000_000 : 128000,
        maxTokens: 8192,
      };
    },
  },

  // ── xAI (Grok) ──────────────────────────────────────────────────────
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai",
    modelsPath: "/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: /\bgrok-3\b/i.test(m.id),
      input: /\bvision\b/i.test(m.id) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 16384,
    }),
  },

  // ── Groq ────────────────────────────────────────────────────────────
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: /\b(reasoning|deepseek-r1)\b/i.test(m.id),
      input: /\bvision\b/i.test(m.id) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },

  // ── Mistral ─────────────────────────────────────────────────────────
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai",
    modelsPath: "/v1/models",
    api: "mistral-conversations",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },

  // ── Cerebras ────────────────────────────────────────────────────────
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai",
    modelsPath: "/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },

  // ── Together ────────────────────────────────────────────────────────
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.ai",
    modelsPath: "/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: /\b(reasoning|deepseek-r1|deepseek-v3)\b/i.test(m.id),
      input: /\bvision\b/i.test(m.id) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },

  // ── Fireworks ───────────────────────────────────────────────────────
  {
    id: "fireworks",
    label: "Fireworks",
    baseUrl: "https://api.fireworks.ai",
    modelsPath: "/inference/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: /\b(reasoning|deepseek-r1)\b/i.test(m.id),
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },

  // ── NVIDIA NIM ─────────────────────────────────────────────────────
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com",
    modelsPath: "/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },

  // ── OpenRouter (special: includes pricing) ──────────────────────────
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai",
    modelsPath: "/api/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => {
      const id = m.id;
      const contextLength = m.context_length ?? 128000;
      const modality = m.architecture?.modality ?? "";
      const hasImage = /image/i.test(modality);
      const isReasoning = /\b(reasoning|deepseek-r1|claude-sonnet-4)\b/i.test(id);

      // OpenRouter pricing is per-token (e.g. "3e-06"). Convert to $/M tokens.
      const pricing = m.pricing ?? {};
      const toCost = (val: string | number | undefined): number => {
        if (val == null || val === "0") return 0;
        const n = typeof val === "string" ? parseFloat(val) : val;
        return isNaN(n) ? 0 : Math.round(n * 1_000_000 * 100) / 100;
      };

      return {
        id,
        name: m.name ?? id,
        reasoning: isReasoning,
        input: hasImage ? ["text", "image"] : ["text"],
        cost: {
          input: toCost(pricing.prompt),
          output: toCost(pricing.completion),
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: contextLength,
        maxTokens: 16384,
      };
    },
  },

  // ── OpenCode Zen ────────────────────────────────────────────────────
  // Each model has its own baseUrl/api depending on the upstream:
  //   claude-* → anthropic-messages @ https://opencode.ai/zen
  //   gemini-* → google-generative-ai @ https://opencode.ai/zen
  //   rest     → openai-completions   @ https://opencode.ai/zen/v1
  {
    id: "opencode",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai",
    modelsPath: "/zen/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => {
      const id = m.id;
      const isClaude = /^claude-/i.test(id);
      const isGemini = /^gemini-/i.test(id);
      return {
        id,
        name: id,
        reasoning: /\b(claude-opus-4|claude-sonnet-4|deepseek|gpt-[45]|o[13]|big-pickle)\b/i.test(id),
        input: /\b(vision|claude|gpt-4[o1]|gpt-5|multimodal)\b/i.test(id)
          ? ["text", "image"]
          : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
        baseUrl: isClaude || isGemini
          ? "https://opencode.ai/zen"
          : "https://opencode.ai/zen/v1",
        api: isClaude
          ? "anthropic-messages"
          : isGemini
            ? "google-generative-ai"
            : "openai-completions",
      };
    },
  },

  // ── OpenCode Zen Go ────────────────────────────────────────────────
  // Most models use openai-completions @ /zen/go/v1, but some
  // (minimax-m3, qwen3.7-max/plus) use anthropic-messages @ /zen/go.
  {
    id: "opencode-go",
    label: "OpenCode Zen Go",
    baseUrl: "https://opencode.ai",
    modelsPath: "/zen/go/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => {
      const id = m.id;
      // Models routed through Anthropic-compatible endpoint
      const isAnthropic =
        /^minimax-m3/i.test(id) ||
        /^qwen3\.7-(max|plus)/i.test(id);
      return {
        id,
        name: id,
        reasoning: /\b(deepseek|reasoning)\b/i.test(id) || isAnthropic,
        input: isAnthropic ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: isAnthropic ? 512000 : 1_000_000,
        maxTokens: 131072,
        baseUrl: isAnthropic
          ? "https://opencode.ai/zen/go"
          : "https://opencode.ai/zen/go/v1",
        api: isAnthropic
          ? "anthropic-messages"
          : "openai-completions",
      };
    },
  },

  // ── OpenAI Codex (ChatGPT subscription via OAuth) ────────────────
  // Requires chatgpt-account-id header extracted from the OAuth JWT.
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    baseUrl: "https://chatgpt.com",
    modelsPath: "/backend-api/models",
    api: "openai-codex-responses",
    authType: "bearer",
    prepareHeaders: (apiKey) => ({
      "chatgpt-account-id": jwtAccountId(apiKey) ?? "",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": "pi/1.0",
    }),
    parseList: (j) => j.models ?? j.data ?? [],
    transform: (m) => {
      const id = m.slug ?? m.id;
      const name = m.title ?? m.name ?? id;
      const hasVision = !!(m.capabilities?.vision ?? /vision|image/i.test(m.id ?? ""));
      const isReasoning = !/gpt-4[^o1]|gpt-3\.5/i.test(id);
      return {
        id,
        name,
        reasoning: isReasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.max_context ?? m.contextWindow ?? 128000,
        maxTokens: m.capabilities?.max_tokens ?? 128000,
      };
    },
  },

  // ── Hugging Face ────────────────────────────────────────────────────
  {
    id: "huggingface",
    label: "Hugging Face",
    baseUrl: "https://router.huggingface.co",
    modelsPath: "/v1/models",
    api: "openai-completions",
    authType: "bearer",
    parseList: (j) => j.data ?? [],
    transform: (m) => ({
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }),
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function detectMultimodal(id: string): ("text" | "image")[] {
  // Common vision/reasoning model patterns
  if (
    /\b(vision|multimodal|gemini|claude|gpt-4[o1]|gpt-5)\b/i.test(id) &&
    !/\b(audio|embed)\b/i.test(id)
  ) {
    return ["text", "image"];
  }
  return ["text"];
}

function piConfigDir(): string {
  const env = process.env["PI_CONFIG_DIR"];
  if (env) return env;
  return join(homedir(), ".pi", "agent");
}

// ── Auth detection ───────────────────────────────────────────────────────

interface AuthEntry {
  key: string;
  source: string; // "auth.json" | "env"
  providerId: string;
}

/** Env var → provider ID mapping (from pi's env-api-keys.ts). */
const ENV_TO_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  ANTHROPIC_OAUTH_TOKEN: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "google",
  DEEPSEEK_API_KEY: "deepseek",
  XAI_API_KEY: "xai",
  GROQ_API_KEY: "groq",
  MISTRAL_API_KEY: "mistral",
  CEREBRAS_API_KEY: "cerebras",
  OPENROUTER_API_KEY: "openrouter",
  TOGETHER_API_KEY: "together",
  FIREWORKS_API_KEY: "fireworks",
  NVIDIA_API_KEY: "nvidia",
  AZURE_OPENAI_API_KEY: "azure-openai-responses",
  AI_GATEWAY_API_KEY: "vercel-ai-gateway",
  ZAI_API_KEY: "zai",
  ZAI_CODING_CN_API_KEY: "zai-coding-cn",
  MINIMAX_API_KEY: "minimax",
  MINIMAX_CN_API_KEY: "minimax-cn",
  MOONSHOT_API_KEY: "moonshotai",
  HF_TOKEN: "huggingface",
  KIMI_API_KEY: "kimi-coding",
  COPILOT_GITHUB_TOKEN: "github-copilot",
  XIAOMI_API_KEY: "xiaomi",
  OPENCODE_API_KEY: "opencode",
};

/** Read auth.json → { providerId: key } */
function readAuthJson(): Record<string, string> {
  const p = join(piConfigDir(), "auth.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const result: Record<string, string> = {};
    for (const [providerId, cred] of Object.entries(raw)) {
      if (cred && typeof cred === "object" && "type" in cred) {
        const c = cred as any;
        if (c.type === "api_key" && typeof c.key === "string" && c.key.length > 0) {
          result[providerId] = c.key;
        }
        // OAuth credentials: store access token for model-list fetch
        if (c.type === "oauth") {
          if (typeof c.access === "string" && c.access.length > 0) {
            result[providerId] = c.access; // actual JWT for Bearer auth
          } else {
            result[providerId] = "<oauth>"; // placeholder when refresh needed
          }
        }
      }
    }
    return result;
  } catch (e) {
    return {};
  }
}

/** Get API key for a provider from env vars (reverse of ENV_TO_PROVIDER). */
function findEnvApiKey(providerId: string): string | undefined {
  for (const [envVar, pid] of Object.entries(ENV_TO_PROVIDER)) {
    if (pid === providerId) {
      const val = process.env[envVar];
      if (val && val.length > 0) return val;
    }
  }
  return undefined;
}

/** Scan all credential sources and return list of (providerId, apiKey?) pairs. */
function detectConfiguredProviders(): Map<string, string | undefined> {
  const configured = new Map<string, string | undefined>();

  // 1. auth.json — both api_key and oauth
  const authJson = readAuthJson();
  for (const [providerId, key] of Object.entries(authJson)) {
    // Treat OAuth as configured but without a usable key for model-list fetch
    configured.set(providerId, key === "<oauth>" ? undefined : key);
  }

  // 2. Environment variables — only for providers not already in auth.json
  for (const [envVar, providerId] of Object.entries(ENV_TO_PROVIDER)) {
    if (configured.has(providerId)) continue; // auth.json takes priority
    const val = process.env[envVar];
    if (val && val.length > 0) {
      configured.set(providerId, val);
    }
  }

  return configured;
}

/** Resolve the actual API key for a provider, checking env var aliases. */
function resolveApiKey(providerId: string, preferredKey?: string): string | undefined {
  if (preferredKey && preferredKey !== "<oauth>") return preferredKey;
  // Try env vars
  return findEnvApiKey(providerId);
}

// ── Helpers: JWT decode for Codex OAuth ───────────────────────────────

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Decode a JWT payload (no signature verification) and return the accountId. */
function jwtAccountId(jwt: string): string | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return undefined;
    const payload = parts[1]!;
    const decoded = JSON.parse(atob(payload));
    const auth = decoded?.[JWT_CLAIM_PATH];
    return auth?.chatgpt_account_id;
  } catch (e) {
    return undefined;
  }
}

/** Decode JWT payload and return exp timestamp (seconds), or 0 if unreadable. */
function jwtExpiry(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return 0;
    const decoded = JSON.parse(atob(parts[1]!));
    return (decoded.exp as number) ?? 0;
  } catch {
    return 0;
  }
}

/** True if the JWT's exp is in the past (with 5 min grace period). */
function isJwtExpired(jwt: string): boolean {
  const exp = jwtExpiry(jwt);
  if (exp === 0) return true; // can't decode → treat as expired
  // 5 min grace to avoid races with near-expiry tokens
  return Date.now() / 1000 >= exp - 300;
}

/**
 * Refresh OAuth tokens for openai-codex providers in auth.json.
 * Scans all entries matching "openai-codex" or "openai-codex-N",
 * checks expiry, and refreshes via the OAuth refresh_token grant.
 * Writes updated auth.json in-place.
 */
async function refreshCodexOAuthTokens(): Promise<{ refreshed: string[]; failed: string[] }> {
  const authPath = join(piConfigDir(), "auth.json");
  if (!existsSync(authPath)) return { refreshed: [], failed: [] };

  const raw: Record<string, any> = JSON.parse(readFileSync(authPath, "utf-8"));
  const refreshed: string[] = [];
  const failed: string[] = [];

  for (const [providerId, cred] of Object.entries(raw)) {
    // Match "openai-codex" or "openai-codex-2", "openai-codex-3", etc.
    if (!/^openai-codex(-\d+)?$/.test(providerId)) continue;
    if (!cred || typeof cred !== "object" || cred.type !== "oauth") continue;
    if (typeof cred.access !== "string" || typeof cred.refresh !== "string") continue;

    // Skip if still fresh
    if (!isJwtExpired(cred.access)) continue;

    // Attempt refresh
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cred.refresh,
        client_id: CODEX_CLIENT_ID,
      });

      const res = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json: any = await res.json();
      if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
        throw new Error("response missing access_token/refresh_token/expires_in");
      }

      // Extract accountId from new token
      const accountId = jwtAccountId(json.access_token) ?? cred.accountId;

      raw[providerId] = {
        type: "oauth",
        access: json.access_token,
        refresh: json.refresh_token,
        expires: Date.now() + json.expires_in * 1000,
        accountId,
      };
      refreshed.push(providerId);
    } catch (err) {
      failed.push(providerId);
    }
  }

  if (refreshed.length > 0 || failed.length > 0) {
    // Write atomically: stringify once
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(authPath, JSON.stringify(raw, null, 2), "utf-8");
  }

  return { refreshed, failed };
}

// ── Custom provider detection (models.json) ──────────────────────────

interface ModelsJsonEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  compat?: Record<string, unknown>;
}

function readModelsJson(): Record<string, ModelsJsonEntry> {
  const p = join(piConfigDir(), "models.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return (raw.providers as Record<string, ModelsJsonEntry>) ?? {};
  } catch (e) {
    return {};
  }
}

// ── HTTP fetch ────────────────────────────────────────────────────────────

async function fetchModels(def: ProviderDef, apiKey: string | undefined): Promise<ModelDef[]> {
  const url = `${def.baseUrl}${def.modelsPath}`;
  const headers: Record<string, string> = { ...def.extraHeaders };

  if (apiKey) {
    if (def.authType === "bearer") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (def.authType === "x-api-key") {
      headers[def.authHeader ?? "x-api-key"] = apiKey;
    }
    // Dynamic headers (e.g., account ID extracted from JWT)
    if (def.prepareHeaders) {
      Object.assign(headers, def.prepareHeaders(apiKey));
    }
  }

  let finalUrl = url;
  if (def.authType === "query-key" && apiKey) {
    finalUrl = `${url}?key=${encodeURIComponent(apiKey)}`;
  }

  const res = await fetch(finalUrl, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const rawList = def.parseList(json);
  if (!Array.isArray(rawList)) {
    throw new Error(`unexpected response shape (not an array)`);
  }

  return rawList.map((item) => def.transform(item));
}

// ── Main reload logic ────────────────────────────────────────────────────

interface ReloadResult {
  provider: string;
  count: number;
  ok: boolean;
  error?: string;
}

interface OAuthRefreshInfo {
  refreshed: string[];
  failed: string[];
}

async function reloadModels(
  pi: ExtensionAPI,
  providerFilter?: string[],
): Promise<{ results: ReloadResult[]; oauth: OAuthRefreshInfo }> {
  const results: ReloadResult[] = [];

  // ── 1. Detect configured providers ──────────────────────────────────
  const configured = detectConfiguredProviders();
  const customProviders = readModelsJson();

  // ── 2. Determine which providers to refresh ─────────────────────────
  const toRefresh = new Map<string, { key?: string; def?: ProviderDef; custom?: ModelsJsonEntry }>();

  // Built-in providers with credentials
  for (const [providerId, key] of configured) {
    let def = PROVIDERS.find((p) => p.id === providerId);
    // Handle openai-codex-2, openai-codex-3 etc. (secondary ChatGPT accounts)
    if (!def && /^openai-codex-\d+$/.test(providerId)) {
      def = PROVIDERS.find((p) => p.id === "openai-codex");
    }
    if (def) {
      toRefresh.set(providerId, { key, def });
    }
    // Don't store unknown provider IDs from auth.json — might be third-party
  }

  // Custom providers from models.json (only if they have baseUrl and api)
  for (const [providerName, entry] of Object.entries(customProviders)) {
    if (!entry.baseUrl || !entry.api) continue;
    // If already in the built-in list (e.g., user has an "openai" entry in models.json),
    // respect the models.json config (custom baseUrl may differ)
    if (toRefresh.has(providerName)) {
      // Replace the def with a synthetic one using the custom config
      const key = entry.apiKey ?? toRefresh.get(providerName)?.key;
      toRefresh.set(providerName, {
        key,
        custom: entry,
      });
    } else {
      // New custom provider (e.g., ollama, vllm, lm-studio)
      const key = entry.apiKey;
      toRefresh.set(providerName, { key, custom: entry });
    }
  }

  // ── 2b. Refresh expired OAuth tokens for openai-codex providers ──
  // Do this before filtering so refreshed tokens propagate into toRefresh
  const { refreshed, failed: refreshFailed } = await refreshCodexOAuthTokens();
  if (refreshed.length > 0) {
    const freshAuth = readAuthJson();
    for (const pid of refreshed) {
      if (freshAuth[pid]) {
        configured.set(pid, freshAuth[pid]);
        const existing = toRefresh.get(pid);
        if (existing) {
          toRefresh.set(pid, { ...existing, key: freshAuth[pid] });
        }
      }
    }
  }

  // Filter if specific providers requested
  const filtered = providerFilter && providerFilter.length > 0
    ? new Map([...toRefresh].filter(([name]) => providerFilter.includes(name)))
    : toRefresh;

  if (filtered.size === 0) {
    return { results, oauth: { refreshed, failed: refreshFailed } };
  }

  // ── 3. Fetch models from each provider ──────────────────────────────
  for (const [providerName, cfg] of filtered) {
    if (cfg.def) {
      // ── Built-in provider ───────────────────────────────────────────
      const apiKey = resolveApiKey(providerName, cfg.key);
      // Skip if auth is OAuth-only (no api key to fetch models)
      if (!apiKey) {
        results.push({
          provider: providerName,
          count: 0,
          ok: false,
          error: "no API key found (OAuth only? use env var or auth.json api_key)",
        });
        continue;
      }

      try {
        const models = await fetchModels(cfg.def, apiKey);
        if (models.length === 0) {
          results.push({ provider: providerName, count: 0, ok: false, error: "empty model list" });
          continue;
        }
        // Register — pi requires baseUrl + apiKey when models are provided
        pi.registerProvider(providerName, {
          baseUrl: cfg.def.baseUrl,
          api: cfg.def.api as any,
          apiKey,
          models: models as any,
        });
        results.push({ provider: providerName, count: models.length, ok: true });
      } catch (err) {
        results.push({
          provider: providerName,
          count: 0,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (cfg.custom) {
      // ── Custom provider from models.json ────────────────────────────
      const entry = cfg.custom;
      const apiDef: Partial<ProviderDef> = {
        baseUrl: entry.baseUrl!,
        modelsPath: "/models",
        api: entry.api!,
        authType: "bearer",
        parseList: (j) => j.data ?? [],
        transform: (m) => ({
          id: m.id,
          name: m.id,
          reasoning: /\b(reasoning|think|deepseek-r1)\b/i.test(m.id),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        }),
      };

      try {
        const models = await fetchModels(apiDef as ProviderDef, cfg.key);
        if (models.length === 0) {
          results.push({ provider: providerName, count: 0, ok: false, error: "empty model list" });
          continue;
        }
        // Full registration for custom providers
        pi.registerProvider(providerName, {
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          api: entry.api as any,
          compat: entry.compat as any,
          models: models as any,
        });
        results.push({ provider: providerName, count: models.length, ok: true });
      } catch (err) {
        results.push({
          provider: providerName,
          count: 0,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { results, oauth: { refreshed, failed: refreshFailed } };
}

// ── Extension entry ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ── Auto-refresh on startup (via session_start, TUI ready) ────────
  let autoRefreshed = false;
  pi.on("session_start", async (_event, ctx) => {
    if (autoRefreshed) return;
    autoRefreshed = true;
    try {
      const { results, oauth } = await reloadModels(pi);
      const ok = results.filter((r) => r.ok);
      if (ok.length > 0) {
        const parts = [ok.map((r) => `${r.provider} (${r.count})`).join(", ")];
        if (oauth.refreshed.length > 0) parts.push(`OAuth: ${oauth.refreshed.join(", ")}`);
        ctx.ui.notify(`Models: ${parts.join(" · ")}`, "info");
      }
    } catch (e) {
      // ignore
    }
  });

  pi.registerCommand("reload-models", {
    description: "Refresh model listings from all configured provider APIs",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const isList = parts.length === 1 && parts[0] === "-list";

      if (isList) {
        // ── Dry-run: show what would be refreshed ─────────────────────
        const configured = detectConfiguredProviders();
        const custom = readModelsJson();
        const lines: string[] = [];

        for (const [providerId, keyOrUndef] of configured) {
          let def = PROVIDERS.find((p) => p.id === providerId);
          if (!def && /^openai-codex-\d+$/.test(providerId)) {
            def = PROVIDERS.find((p) => p.id === "openai-codex");
          }
          const keyDesc = keyOrUndef === "<oauth>" ? "OAuth" : keyOrUndef ? "api_key" : "env";
          if (def) {
            lines.push(`  ${providerId} (${def.label}) — ${keyDesc}`);
          } else {
            lines.push(`  ${providerId} — ${keyDesc} (no known model-list endpoint)`);
          }
        }

        for (const [name, entry] of Object.entries(custom)) {
          if (entry.baseUrl && entry.api) {
            lines.push(`  ${name} (custom, ${entry.api}) — models.json`);
          }
        }

        if (lines.length === 0) {
          ctx.ui.notify("No configured providers found.", "info");
        } else {
          ctx.ui.setStatus("reload-models", `Detected providers:\n${lines.join("\n")}`);
          ctx.ui.notify(`Found ${lines.length} configured provider(s). Run /reload-models to fetch.`, "info");
        }
        return;
      }

      const filter = parts.length > 0 ? parts : undefined;
      ctx.ui.setStatus("reload-models", "Fetching model lists...");
      ctx.ui.notify("Fetching models from configured providers...", "info");

      const { results, oauth } = await reloadModels(pi, filter);

      if (results.length === 0) {
        ctx.ui.notify(
          filter
            ? `No configured providers found matching: ${filter.join(", ")}`
            : "No configured providers found. Use /reload-models -list to check what's detected.",
          "warning",
        );
        ctx.ui.setStatus("reload-models", undefined);
        return;
      }

      const ok = results.filter((r) => r.ok);
      const fail = results.filter((r) => !r.ok);

      const summary = results
        .map((r) => (r.ok ? `${r.provider} (${r.count})` : `${r.provider} ✗ ${r.error ?? ""}`))
        .join("\n");

      ctx.ui.setStatus("reload-models", summary);

      const oauthParts: string[] = [];
      if (oauth.refreshed.length > 0) oauthParts.push(`refreshed: ${oauth.refreshed.join(", ")}`);
      if (oauth.failed.length > 0) oauthParts.push(`FAILED: ${oauth.failed.join(", ")}`);
      const oauthMsg = oauthParts.length > 0 ? ` [OAuth ${oauthParts.join(" · ")}]` : "";

      ctx.ui.notify(`Updated: ${ok.map((r) => `${r.provider} (${r.count})`).join(", ")}${oauthMsg}`, "info");
      if (fail.length > 0) {
        const failMsgs = fail.map((r) => `${r.provider}: ${r.error ?? "unknown error"}`);
        ctx.ui.notify(`Failed: ${failMsgs.join(" · ")}`, "warning");
      }
    },
  });
}
