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
	const fiveHour = parseWindow(windows.primary_window, FIVE_HOURS);
	const sevenDay = parseWindow(windows.secondary_window, SEVEN_DAYS);
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
	if (!apiKey) return null;

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
		if (!response.ok) return null;
		return parseOpenAIUsage(await response.json());
	} catch {
		return null;
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

export function formatOpenAIUsage(usage: OpenAIUsage, now = Date.now()): string {
	const parts: string[] = [];
	if (usage.fiveHour) {
		parts.push(`${Math.round(usage.fiveHour.usedPercent)}% ${formatReset(usage.fiveHour, now)}`);
	}
	if (usage.sevenDay) {
		parts.push(`${Math.round(usage.sevenDay.usedPercent)}% ${formatReset(usage.sevenDay, now)}`);
	}
	return parts.join(" | ");
}
