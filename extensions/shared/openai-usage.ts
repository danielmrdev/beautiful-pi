const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOURS = 5 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

export interface UsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
	resetAfterSeconds?: number;
}

export interface OpenAIUsage {
	fiveHour?: UsageWindow;
	sevenDay?: UsageWindow;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function accountIdFromToken(token: string): string | undefined {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) return undefined;
		const payload = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function parseWindow(value: unknown, expectedSeconds: number): UsageWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const windowSeconds = asFiniteNumber(raw.limit_window_seconds);
	const usedPercent = asFiniteNumber(raw.used_percent);
	if (windowSeconds !== expectedSeconds || usedPercent === undefined) return undefined;
	if (usedPercent < 0 || usedPercent > 100) return undefined;

	const resetAt = asFiniteNumber(raw.reset_at);
	const resetAfterSeconds = asFiniteNumber(raw.reset_after_seconds);
	return {
		usedPercent,
		windowSeconds,
		...(resetAt !== undefined && resetAt > 0 ? { resetAt } : {}),
		...(resetAfterSeconds !== undefined && resetAfterSeconds >= 0
			? { resetAfterSeconds }
			: {}),
	};
}

/** Parse private ChatGPT/Codex usage response without trusting its schema blindly. */
export function parseOpenAIUsage(body: unknown): OpenAIUsage | null {
	if (!body || typeof body !== "object") return null;
	const rateLimit = (body as Record<string, unknown>).rate_limit;
	if (!rateLimit || typeof rateLimit !== "object") return null;
	const windows = rateLimit as Record<string, unknown>;
	const candidates = [windows.primary_window, windows.secondary_window];
	const fiveHour = candidates
		.map((window) => parseWindow(window, FIVE_HOURS))
		.find((window): window is UsageWindow => window !== undefined);
	const sevenDay = candidates
		.map((window) => parseWindow(window, SEVEN_DAYS))
		.find((window): window is UsageWindow => window !== undefined);
	if (!fiveHour && !sevenDay) return null;
	return {
		...(fiveHour ? { fiveHour } : {}),
		...(sevenDay ? { sevenDay } : {}),
	};
}

export async function fetchOpenAIUsage(
	apiKey: string,
	authHeaders?: Record<string, string>,
): Promise<OpenAIUsage | null> {
	const result = await fetchOpenAIUsageDetailed(apiKey, authHeaders);
	return result.ok ? result.usage : null;
}

/** Why a usage fetch produced no usable quota data. */
export type UsageFetchError =
	| "unauthenticated"
	| "expired"
	| "unauthorized"
	| "network"
	| "http"
	| "malformed";

export type UsageFetchResult =
	| { ok: true; usage: OpenAIUsage | null }
	| { ok: false; reason: UsageFetchError };

/**
 * Fetch + classify usage data with an actionable failure reason.
 * `expires` (epoch seconds) is checked upfront so an expired OAuth token is
 * reported without a network round-trip. 2xx responses that carry no
 * recognizable windows are "malformed" (the endpoint returned something we
 * cannot route on).
 */
export async function fetchOpenAIUsageDetailed(
	apiKey: string,
	authHeaders?: Record<string, string>,
	expires?: number,
): Promise<UsageFetchResult> {
	if (!apiKey) return { ok: false, reason: "unauthenticated" };
	if (typeof expires === "number" && expires > 0 && expires * 1000 <= Date.now()) {
		return { ok: false, reason: "expired" };
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/json",
	};
	const accountHeader = Object.entries(authHeaders ?? {})
		.find(([key]) => key.toLowerCase() === "chatgpt-account-id");
	const accountId = accountHeader?.[1] ?? accountIdFromToken(apiKey);
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(OPENAI_USAGE_URL, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: "unauthorized" };
		}
		if (!response.ok) return { ok: false, reason: "http" };
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return { ok: false, reason: "malformed" };
		}
		const usage = parseOpenAIUsage(body);
		if (!usage) return { ok: false, reason: "malformed" };
		return { ok: true, usage };
	} catch {
		return { ok: false, reason: "network" };
	} finally {
		clearTimeout(timeout);
	}
}

function resetSeconds(window: UsageWindow, now: number): number | undefined {
	if (window.resetAt !== undefined) {
		return Math.max(0, window.resetAt - now / 1000);
	}
	if (window.resetAfterSeconds !== undefined) return window.resetAfterSeconds;
	return undefined;
}

export function formatReset(window: UsageWindow, now = Date.now()): string {
	const seconds = resetSeconds(window, now);
	if (seconds === undefined) return "?";
	const total = Math.ceil(seconds);
	const days = Math.floor(total / 86400);
	const hours = Math.floor((total % 86400) / 3600);
	if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) {
		const minutes = Math.floor((total % 3600) / 60);
		return `${hours}:${String(minutes).padStart(2, "0")}h`;
	}
	const minutes = Math.floor(total / 60);
	if (minutes > 0) return `${minutes}m`;
	return `${total}s`;
}

export interface UsageSegment {
	text: string;
	overBudget: boolean;
}

/** Seconds elapsed inside the window at `now`, or undefined when unknowable. */
function windowElapsed(window: UsageWindow, now: number, driftMs: number): number | undefined {
	if (window.resetAt !== undefined) {
		return now / 1000 - (window.resetAt - window.windowSeconds);
	}
	if (window.resetAfterSeconds !== undefined) {
		return window.windowSeconds - window.resetAfterSeconds + driftMs / 1000;
	}
	return undefined;
}

/**
 * True when actual usage exceeds the *expected* usage for this moment: the
 * share of the cap a perfectly linear spend would have consumed by now.
 */
function overBudget(window: UsageWindow, now: number, driftMs: number): boolean {
	const elapsed = windowElapsed(window, now, driftMs);
	if (elapsed === undefined || elapsed <= 0) return false;
	const expectedPercent = (elapsed / window.windowSeconds) * 100;
	return window.usedPercent > expectedPercent;
}

/**
 * One segment per usage window. `fetchedAt` is when the usage data was
 * fetched; time-based windows (resetAfterSeconds) drift from it.
 */
export function openAIUsageSegments(
	usage: OpenAIUsage,
	fetchedAt = Date.now(),
): UsageSegment[] {
	const now = Date.now();
	const driftMs = now - fetchedAt;
	const parts: UsageSegment[] = [];
	if (usage.fiveHour) {
		parts.push({
			text: `${Math.round(usage.fiveHour.usedPercent)}% ${formatReset(usage.fiveHour, now)}`,
			overBudget: overBudget(usage.fiveHour, now, driftMs),
		});
	}
	if (usage.sevenDay) {
		parts.push({
			text: `${Math.round(usage.sevenDay.usedPercent)}% ${formatReset(usage.sevenDay, now)}`,
			overBudget: overBudget(usage.sevenDay, now, driftMs),
		});
	}
	return parts;
}

export function formatOpenAIUsage(usage: OpenAIUsage, now = Date.now()): string {
	return openAIUsageSegments(usage, now).map((s) => s.text).join(" | ");
}
