const DASHBOARD_BASE = "https://opencode.ai/workspace";

export interface OpenCodeGoWindow {
	usagePercent: number;
	resetInSec: number;
}

export interface OpenCodeGoUsage {
	rolling: OpenCodeGoWindow;  // 5h, $12 limit
	weekly: OpenCodeGoWindow;   // 7d, $30 limit
	monthly: OpenCodeGoWindow;  // 30d, $60 limit
}

// ── HTML scraping ────────────────────────────────────────────────────────────

const ENTITY_REPLACEMENTS: Array<[RegExp, string]> = [
	[/&quot;/g, '"'],
	[/&#34;/g, '"'],
	[/&#x27;/g, "'"],
	[/&#39;/g, "'"],
	[/&amp;/g, '&'],
	[/\\"/g, '"'],
	[/\\u0022/g, '"'],
];

function normalizeHTML(html: string): string {
	let text = html;
	for (const [pattern, replacement] of ENTITY_REPLACEMENTS) {
		text = text.replace(pattern, replacement);
	}
	return text;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNumber(text: string, fieldName: string): number | null {
	const pattern = new RegExp(
		`["']?${escapeRegex(fieldName)}["']?\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`,
	);
	const match = text.match(pattern);
	if (!match) return null;
	const val = parseFloat(match[1]!);
	return isNaN(val) ? null : val;
}

function extractUsageWindow(text: string, fieldName: string): OpenCodeGoWindow | null {
	const objectPattern = new RegExp(
		`["']?${escapeRegex(fieldName)}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^}]*)\\}`,
		"s",
	);
	const match = text.match(objectPattern);
	if (!match) return null;

	const body = match[1]!;
	const usagePercent = extractNumber(body, "usagePercent");
	const resetInSec = extractNumber(body, "resetInSec");

	if (usagePercent === null || resetInSec === null) return null;
	if (usagePercent < 0 || usagePercent > 100) return null;

	return {
		usagePercent,
		resetInSec: Math.max(0, Math.round(resetInSec)),
	};
}

function parseDashboardHTML(html: string): OpenCodeGoUsage | null {
	const text = normalizeHTML(html);

	const rolling = extractUsageWindow(text, "rollingUsage");
	const weekly = extractUsageWindow(text, "weeklyUsage");
	const monthly = extractUsageWindow(text, "monthlyUsage");

	if (!rolling && !weekly && !monthly) return null;

	return {
		rolling: rolling ?? { usagePercent: 0, resetInSec: 0 },
		weekly: weekly ?? { usagePercent: 0, resetInSec: 0 },
		monthly: monthly ?? { usagePercent: 0, resetInSec: 0 },
	};
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function fetchOpenCodeGoUsage(
	workspaceId: string,
	authCookie: string,
	signal?: AbortSignal,
): Promise<OpenCodeGoUsage | null> {
	if (!workspaceId || !authCookie) return null;

	const url = `${DASHBOARD_BASE}/${encodeURIComponent(workspaceId)}/go`;
	const cookieHeader = authCookie.includes("auth=") ? authCookie : `auth=${authCookie}`;

	const controller = new AbortController();
	const linkedSignal = signal
		? (() => {
				if (signal.aborted) {
					controller.abort();
					return signal;
				}
				signal.addEventListener("abort", () => controller.abort(), { once: true });
				return controller.signal;
			})()
		: controller.signal;
	const timeoutId = signal ? undefined : setTimeout(() => controller.abort(), 10_000);

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "text/html,application/xhtml+xml",
				Cookie: cookieHeader,
				"User-Agent":
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
			},
			signal: linkedSignal,
		});

		if (!response.ok) return null;
		const html = await response.text();
		return parseDashboardHTML(html);
	} catch {
		return null;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
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

export interface OpenCodeGoSegment {
	text: string;
	overBudget: boolean;
}

/**
 * One segment per tier. `fetchedAt` is when the usage data was fetched;
 * remaining time drifts from it.
 *
 * Over-budget means actual usage exceeds the *expected* usage for this
 * moment: the share of the cap a perfectly linear spend would have consumed
 * by now.
 */
export function openCodeGoUsageSegments(
	usage: OpenCodeGoUsage,
	fetchedAt = Date.now(),
): OpenCodeGoSegment[] {
	const now = Date.now();
	const driftMs = now - fetchedAt;
	const parts: OpenCodeGoSegment[] = [];

	for (const key of ["rolling", "weekly", "monthly"] as const) {
		const w = usage[key];
		const windowSeconds = OCG_WINDOW_SECONDS[key];
		const remaining = Math.max(0, w.resetInSec - driftMs / 1000);
		const elapsed = windowSeconds - remaining;
		const expectedPercent = (elapsed / windowSeconds) * 100;
		parts.push({
			text: `${Math.round(w.usagePercent)}% ${formatResetSeconds(remaining)}`,
			overBudget: elapsed > 0 && w.usagePercent > expectedPercent,
		});
	}

	return parts;
}

export function formatOpenCodeGoUsage(usage: OpenCodeGoUsage, now = Date.now()): string {
	return openCodeGoUsageSegments(usage, now).map((s) => s.text).join(" | ");
}
