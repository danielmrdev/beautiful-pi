import {
	formatUsagePaceBar,
	isOverBudgetLinear,
	type UsageSegment,
} from "../shared/openai-usage.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export interface OpenCodeGoWindow {
	usagePercent: number;
	resetInSec: number;
}

export interface OpenCodeGoUsage {
	rolling: OpenCodeGoWindow;  // 5h, $12 limit
	weekly: OpenCodeGoWindow;   // 7d, $30 limit
	monthly: OpenCodeGoWindow;  // 30d, $60 limit
}

// ── API parsing ──────────────────────────────────────────────────────────────

function parseWindow(value: unknown, now: number): OpenCodeGoWindow | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;

	const percent = raw.percent;
	if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
	if (percent < 0 || percent > 100) return null;

	const resetAt = typeof raw.resetsAt === "string" ? Date.parse(raw.resetsAt) : NaN;
	if (!Number.isFinite(resetAt)) return null;

	return {
		usagePercent: percent,
		resetInSec: Math.max(0, Math.round((resetAt - now) / 1000)),
	};
}

/** Parse `/zen/go/v1/usage` without trusting its schema blindly. */
export function parseOpenCodeGoUsage(body: unknown, now = Date.now()): OpenCodeGoUsage | null {
	const usage = (body as { usage?: unknown } | null)?.usage;
	if (!usage || typeof usage !== "object") return null;
	const windows = usage as Record<string, unknown>;

	const rolling = parseWindow(windows.rolling, now);
	const weekly = parseWindow(windows.weekly, now);
	const monthly = parseWindow(windows.monthly, now);

	if (!rolling && !weekly && !monthly) return null;

	return {
		rolling: rolling ?? { usagePercent: 0, resetInSec: 0 },
		weekly: weekly ?? { usagePercent: 0, resetInSec: 0 },
		monthly: monthly ?? { usagePercent: 0, resetInSec: 0 },
	};
}

// ── Fetch ────────────────────────────────────────────────────────────────────

export async function fetchOpenCodeGoUsage(apiKey: string): Promise<OpenCodeGoUsage | null> {
	if (!apiKey) return null;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10_000);

	try {
		const response = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: controller.signal,
		});

		if (!response.ok) return null;
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return null;
		}
		return parseOpenCodeGoUsage(body);
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatResetSeconds(seconds: number): string {
	if (seconds < 0) return "0s";
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

const OCG_WINDOW_SECONDS: Record<keyof OpenCodeGoUsage, number> = {
	rolling: 5 * 3600,
	weekly: 7 * 24 * 3600,
	monthly: 30 * 24 * 3600,
};

/**
 * One segment per tier. `fetchedAt` is when the usage data was fetched;
 * remaining time drifts from it.
 *
 * Over-budget means actual usage exceeds the *expected* usage for this
 * moment: the share of the cap a perfectly linear spend would have consumed
 * by now. The segment shape and the linear-spend formula are shared with the
 * OpenAI usage monitor (shared/openai-usage.ts).
 */
export function openCodeGoUsageSegments(
	usage: OpenCodeGoUsage,
	fetchedAt = Date.now(),
): UsageSegment[] {
	const now = Date.now();
	const driftMs = now - fetchedAt;
	const parts: UsageSegment[] = [];

	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const w = usage[key];
		const windowSeconds = OCG_WINDOW_SECONDS[key];
		const remaining = Math.max(0, w.resetInSec - driftMs / 1000);
		const elapsed = windowSeconds - remaining;
		parts.push({
			text: `${Math.round(w.usagePercent)}% ${formatResetSeconds(remaining)}`,
			paceBar: formatUsagePaceBar(w.usagePercent, elapsed, windowSeconds),
			overBudget: isOverBudgetLinear(w.usagePercent, elapsed, windowSeconds),
			exhausted: w.usagePercent >= 100,
		});
	}

	return parts;
}
