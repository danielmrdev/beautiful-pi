/**
 * Codex quota inspection.
 *
 * Reuses the private ChatGPT usage endpoint (`/backend-api/wham/usage`) that
 * the footer's usage monitor already talks to. Per-account quota is derived
 * from the account's own OAuth credential (auth.json is read-only): the
 * access token doubles as the Bearer token, and the `chatgpt-account-id`
 * header is derived from the token's JWT payload when needed.
 *
 * Quota data is normalized into a deterministic status (healthy/low/
 * exhausted), remaining headroom, and reset time so that both the
 * `/codex account quota` command and the quota-first pool strategy can route
 * on it. Failures (missing/expired credentials, network, HTTP, malformed
 * bodies) are classified into actionable reasons and never break routing —
 * the caller falls back to round-robin.
 */
import type { Credential } from "@earendil-works/pi-ai";
import {
  fetchOpenAIUsageDetailed,
  type OpenAIUsage,
  type UsageFetchError,
} from "../shared/openai-usage.ts";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { authFilePath } from "./store.ts";
import type { CodexAccount } from "./types.ts";

/** Deterministic quota status derived from the usage windows. */
export type QuotaStatus = "healthy" | "low" | "exhausted";

/** One normalized usage window with remaining headroom. */
export interface QuotaWindow {
  windowSeconds: number;
  usedPercent: number;
  /** 100 - usedPercent, clamped to 0..100. */
  remainingHeadroom: number;
  resetAt?: number;
  resetAfterSeconds?: number;
}

/** Normalized quota for one account. */
export interface AccountQuota {
  status: QuotaStatus;
  /** Remaining headroom of the most-constrained window (0..100), or undefined when unknown. */
  health?: number;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
}

/**
 * Why an account has no usable quota data. Reuses the shared usage-fetch
 * classification (missing credential, expired token, network, HTTP,
 * malformed) — the account layer adds no reason of its own.
 */
export type QuotaUnavailableReason = UsageFetchError;

export interface QuotaReport {
  account: CodexAccount;
  quota?: AccountQuota;
  unavailableReason?: QuotaUnavailableReason;
}

// ── Normalization (pure) ─────────────────────────────────────────────────────

const EXHAUSTED_PERCENT = 100;
const LOW_PERCENT = 80;

function normalizeWindow(window: OpenAIUsage["fiveHour"]): QuotaWindow | undefined {
  if (!window) return undefined;
  const headroom = Math.max(0, Math.min(100, 100 - window.usedPercent));
  return {
    windowSeconds: window.windowSeconds,
    usedPercent: window.usedPercent,
    remainingHeadroom: headroom,
    ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
    ...(window.resetAfterSeconds !== undefined ? { resetAfterSeconds: window.resetAfterSeconds } : {}),
  };
}

/**
 * Normalize a raw usage payload into deterministic quota status.
 * Returns null when there are no recognizable windows at all.
 * - exhausted: any window at 100% used
 * - low: any window at >= 80% used
 * - healthy: otherwise
 * Health = remaining headroom of the most-constrained window (min headroom);
 * the quota-first strategy compares accounts on this number.
 */
export function normalizeAccountQuota(usage: OpenAIUsage | null): AccountQuota | null {
  if (!usage) return null;
  const fiveHour = normalizeWindow(usage.fiveHour);
  const sevenDay = normalizeWindow(usage.sevenDay);
  if (!fiveHour && !sevenDay) return null;

  const windows = [fiveHour, sevenDay].filter((w): w is QuotaWindow => w !== undefined);
  const minHeadroom = Math.min(...windows.map((w) => w.remainingHeadroom));
  const exhausted = windows.some((w) => w.usedPercent >= EXHAUSTED_PERCENT);
  const low = windows.some((w) => w.usedPercent >= LOW_PERCENT);
  const status: QuotaStatus = exhausted ? "exhausted" : low ? "low" : "healthy";

  return {
    status,
    health: minHeadroom,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

// ── Per-account fetch ────────────────────────────────────────────────────────

function accessTokenOf(credential: Credential | undefined): { token?: string; expires?: number } {
  if (!credential) return {};
  if (credential.type === "oauth") return { token: credential.access, expires: credential.expires };
  return { token: credential.key };
}

/**
 * Fetch + normalize quota for one account. Never throws. An account without
 * a stored credential is reported as unauthenticated; expired OAuth tokens
 * are classified by the shared fetcher without a network round-trip.
 */
export async function fetchAccountQuotaReport(account: CodexAccount): Promise<QuotaReport> {
  let credential: Credential | undefined;
  try {
    credential = readStoredCredential(account.credentialId, authFilePath());
  } catch {
    credential = undefined;
  }
  const { token, expires } = accessTokenOf(credential);
  if (!token) return { account, unavailableReason: "unauthenticated" };
  const result = await fetchOpenAIUsageDetailed(token, undefined, expires);
  if (!result.ok) return { account, unavailableReason: result.reason };
  const quota = normalizeAccountQuota(result.usage);
  if (!quota) return { account, unavailableReason: "malformed" };
  return { account, quota };
}

/** Human-readable reason, e.g. for the quota command surface. */
export function formatUnavailableReason(reason: QuotaUnavailableReason): string {
  switch (reason) {
    case "unauthenticated": return "not authenticated";
    case "expired": return "credential expired — re-login with /login or a model call refreshes it";
    case "unauthorized": return "usage endpoint rejected the credential (401/403)";
    case "network": return "usage endpoint unreachable (network error)";
    case "http": return "usage endpoint returned an HTTP error";
    case "malformed": return "usage endpoint returned no recognizable quota windows";
  }
}

/** One-line quota summary: "healthy · 5h 32% used (reset 1h45m) · 7d 18% used". */
export function formatAccountQuota(quota: AccountQuota, now: number = Date.now()): string {
  const parts: string[] = [quota.status];
  if (quota.fiveHour) parts.push(formatWindow("5h", quota.fiveHour, now));
  if (quota.sevenDay) parts.push(formatWindow("7d", quota.sevenDay, now));
  return parts.join(" · ");
}

function formatWindow(label: string, window: QuotaWindow, now: number): string {
  const reset = resetLabel(window, now);
  return `${label} ${Math.round(window.usedPercent)}% used${reset ? ` (reset ${reset})` : ""}`;
}

function resetLabel(window: QuotaWindow, now: number): string | undefined {
  let seconds: number | undefined;
  if (window.resetAt !== undefined) seconds = Math.max(0, window.resetAt - now / 1000);
  else if (window.resetAfterSeconds !== undefined) seconds = window.resetAfterSeconds;
  if (seconds === undefined) return undefined;
  const total = Math.ceil(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${Math.floor((total % 3600) / 60)}m`;
  return `${Math.floor(total / 60)}m`;
}
