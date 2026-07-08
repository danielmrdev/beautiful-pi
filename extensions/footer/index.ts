/**
 * Pi status bars:
 *
 * ABOVE EDITOR (widget):
 *   π  model • thinking  [████░░░░░░░░] 45%  ↑12k ↓3k  $0.031  0:42
 *
 * FOOTER (below editor):
 *   ~/projects/my-project  ⎇ main ↑2 ↓1 +3 !2 ?1
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getIcons,
	getThinkingText,
	GITHUB_ICON,
	GITHUB_ICON_ASCII,
	hasNerdFonts,
	strWidth,
} from "../shared/icons.ts";
import { BorderlessTopEditor } from "./borderless-top-editor.ts";
import { loadSettings } from "../shared/settings.ts";

// ── ANSI helpers ─────────────────────────────────────────────────────────────

// Use strWidth from icons.ts for all visible-width measurements
const visibleWidth = strWidth;

function truncateToWidth(str: string, maxW: number): string {
	let w = 0;
	let inEsc = false;
	let result = "";
	for (const ch of str) {
		if (ch === "\x1b") {
			inEsc = true;
			result += ch;
			continue;
		}
		if (inEsc) {
			result += ch;
			if (/[a-zA-Z]/.test(ch)) inEsc = false;
			continue;
		}
		const cw = strWidth(ch);
		if (w + cw > maxW) break;
		result += ch;
		w += cw;
	}
	return result;
}

// ── Git state ─────────────────────────────────────────────────────────────────

interface GitState {
	branch: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	isGitHub: boolean;
}

function parseGitStatus(output: string): GitState {
	const lines = output.split("\n");
	let branch = "";
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;

	for (const line of lines) {
		if (line.startsWith("# branch.head ")) {
			branch = line.slice("# branch.head ".length).trim();
			if (branch === "(detached)") branch = "HEAD";
		} else if (line.startsWith("# branch.ab ")) {
			const m = line.match(/\+(\d+) -(\d+)/);
			if (m) {
				ahead = parseInt(m[1]!);
				behind = parseInt(m[2]!);
			}
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const xy = line.split(" ")[1] ?? "..";
			const x = xy[0] ?? "."; // index / staged
			const y = xy[1] ?? "."; // worktree / unstaged
			if (x !== "." && x !== "?") staged++;
			if (y !== ".") modified++;
		} else if (line.startsWith("? ")) {
			untracked++;
		}
	}

	return {
		branch,
		ahead,
		behind,
		staged,
		modified,
		untracked,
		isGitHub: false,
	};
}

// ── CWD formatting ────────────────────────────────────────────────────────────

function formatCwd(
	cwd: string,
	maxLen: number,
	theme: any,
): { text: string; width: number } {
	const home = process.env["HOME"] ?? "";
	const display = home ? cwd.replace(home, "~") : cwd;
	const segments = display.split("/");
	const last = segments.pop() ?? "";
	const parent = segments.length > 0 ? segments.join("/") + "/" : "";

	const icons = getIcons();
	const icon = icons.folder ? icons.folder + " " : "";
	const iconW = strWidth(icon);
	const full = parent + last;
	const fullW = strWidth(full);
	const effectiveMax = maxLen - iconW;

	if (fullW <= effectiveMax) {
		const text =
			theme.fg("dim", icon) +
			(parent ? theme.fg("dim", parent) : "") +
			theme.bold(theme.fg("muted", last || "/"));
		return { text, width: iconW + fullW };
	}

	// Truncate: "…/last"
	const ellipsis = "…/";
	const available = effectiveMax - strWidth(ellipsis);

	if (strWidth(last) <= available) {
		return {
			text:
				theme.fg("dim", icon + ellipsis) + theme.bold(theme.fg("muted", last)),
			width: iconW + strWidth(ellipsis) + strWidth(last),
		};
	}

	// Last itself too long
	const truncLast = last.slice(0, Math.max(1, available - 1)) + "…";
	return {
		text:
			theme.fg("dim", icon + ellipsis) +
			theme.bold(theme.fg("muted", truncLast)),
		width: maxLen,
	};
}

// ── Git formatting ────────────────────────────────────────────────────────────

function formatGit(
	state: GitState,
	theme: any,
): { text: string; width: number } {
	let text = "";
	let width = 0;

	const add = (str: string, color: string) => {
		text += theme.fg(color, str);
		width += strWidth(str);
	};

	const icons = getIcons();
	const gitIcon = state.isGitHub
		? hasNerdFonts()
			? GITHUB_ICON
			: GITHUB_ICON_ASCII
		: icons.git;
	const gitPrefix = gitIcon
		? ` ${gitIcon} ${icons.branch} `
		: ` ${icons.branch} `;
	add(gitPrefix + state.branch, "accent");

	if (state.ahead > 0) add(` ${icons.ahead}${state.ahead}`, "success");
	if (state.behind > 0) add(` ${icons.behind}${state.behind}`, "error");
	if (state.staged > 0) add(` ${icons.staged}${state.staged}`, "success");
	if (state.modified > 0) add(` ${icons.modified}${state.modified}`, "warning");
	if (state.untracked > 0) add(` ${icons.untracked}${state.untracked}`, "dim");

	return { text, width };
}

// ── Shared number formatter ───────────────────────────────────────────────────

function fmt(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Render a full-width line (no background) ─────────────────────────────────

function bgLine(_theme: any, content: string, width: number): string {
	const innerW = width - 2;
	const c = truncateToWidth(content, innerW);
	const cW = visibleWidth(c);
	return " " + c + (cW < innerW ? " ".repeat(innerW - cW) : "") + " ";
}

// Like bgLine but uses ─ at edges and for trailing fill (border style)
// borderFn is the editor's live borderColor function
// ── Extension ─────────────────────────────────────────────────────────────────

// Persists across /reload — only reset on true new/startup session
let _sessionStart: number = Date.now();

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event: any, ctx: ExtensionContext) => {
		const settings = loadSettings();
		if (!settings.showFooter) return;

		if (
			event.reason === "startup" ||
			event.reason === "new" ||
			event.reason === "fork"
		) {
			// Try to get actual session creation time from first entry
			const entries = ctx.sessionManager.getEntries();
			const firstTs = (entries[0] as any)?.timestamp;
			_sessionStart = typeof firstTs === "number" ? firstTs : Date.now();
		}
		const sessionStart = _sessionStart;

		// Git cache
		let gitState: GitState | null = null;
		let gitAvailable = true;

		// Returns true if the git state changed (so callers know whether to re-render)
		async function fetchGit(): Promise<boolean> {
			if (!gitAvailable) return false;
			const prev = JSON.stringify(gitState);
			try {
				const [statusR, remoteR] = await Promise.all([
					pi.exec("git", ["status", "--porcelain=v2", "--branch"], {
						cwd: ctx.cwd,
						timeout: 3000,
					}),
					pi.exec("git", ["remote", "get-url", "origin"], {
						cwd: ctx.cwd,
						timeout: 3000,
					}),
				]);
				if (statusR.code === 128) {
					gitAvailable = false;
					return prev !== "null";
				}
				if (statusR.code !== 0) {
					gitState = null;
					return prev !== "null";
				}
				const state = parseGitStatus(statusR.stdout);
				state.isGitHub =
					remoteR.code === 0 && remoteR.stdout.includes("github.com");
				gitState = state;
			} catch {
				gitState = null;
			}
			return JSON.stringify(gitState) !== prev;
		}

		fetchGit();

		// ── Custom editor: remove top border so widget merges into it ──────────
		// Keep a live reference so the stats widget can read the current borderColor
		// (which changes in bash-mode, thinking-mode, etc.)
		let editorRef: { borderColor: (s: string) => string } | null = null;
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = new BorderlessTopEditor(tui, theme, keybindings);
				editorRef = editor as any;
				return editor;
			});
		}

		// Shared Symbol for session start (readable by editor for timer in └─┘)
	const SYM_SS = Symbol.for("beautiful-pi:wgtSessionStart");
	(globalThis as any)[SYM_SS] = sessionStart;

	// ── ABOVE EDITOR: stats widget (2 lines) ─────────────────────────────

	ctx.ui.setWidget(
		"stats-bar",
		(tui: any, theme: any) => {
			const minuteTimer = setInterval(() => {
				const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
				const curMin = Math.floor(elapsed / 60);
				if (curMin !== (minuteTimer as any)._lastMin) {
					(minuteTimer as any)._lastMin = curMin;
					tui.requestRender();
				}
			}, 30_000);

			return {
				dispose() { clearInterval(minuteTimer); },
				invalidate() {},
				render(width: number): string[] {
					const icons = getIcons();
					const fullModelId = ctx.model?.id ?? "no-model";
					const modelId = fullModelId
						.replace(/^.*\//, "")
						.replace(/-\d{8}$/, "")
						.replace(/@.*$/, "") as string;

					const thinkingLevel = pi.getThinkingLevel();
					const thinkingText = thinkingLevel
						? getThinkingText(thinkingLevel)
						: undefined;

					// Context usage
					let contextPercent = 0, contextWindow = 0;
					const cu = ctx.getContextUsage();
					if (cu) {
						contextPercent = Math.round(((cu as any).percent ?? 0) * 10) / 10;
						contextWindow = (cu as any).contextWindow ?? 0;
					}

					// Progress bar
					const barTotal = 12;
					const barFilled = Math.min(barTotal, Math.round((contextPercent / 100) * barTotal));
					let barColor: string;
					if (contextPercent > 90) barColor = "error";
					else if (contextPercent > 70) barColor = "warning";
					else barColor = "success";
					const bar = theme.fg("dim", "[") +
						theme.fg(barColor, "█".repeat(barFilled)) +
						theme.fg("dim", "░".repeat(barTotal - barFilled)) +
						theme.fg("dim", "]");
					const ctxStr = contextPercent > 90
						? theme.fg("error", `${contextPercent}%`)
						: contextPercent > 70
							? theme.fg("warning", `${contextPercent}%`)
							: theme.fg("muted", `${contextPercent}%`);
					const ctxFull = contextWindow > 0 ? `/${fmt(contextWindow)}` : "";

										// Session title (truncated with … based on remaining space)
					let sessionTitle = "";
					try { sessionTitle = pi.getSessionName()?.trim() ?? ""; } catch {}
					
					// ── Line 1: content ────────────────────────────────────────────
					const piPart = theme.fg("accent", icons.pi);
					const thinkPart = thinkingText
						? " " + theme.fg("dim", `(${thinkingText})`) + " "
						: "  ";
					const ctxBar = `${bar} ${ctxStr}${theme.fg("muted", ctxFull)}`;
					const prefixStr = ` ${piPart}  ${modelId}${thinkPart}${ctxBar}`;
					const prefixW = strWidth(prefixStr);
					const remainW = Math.max(0, width - prefixW - 2); // -2 for "  "
					let titlePart = "";
					if (sessionTitle && remainW > 4) {
						const t = sessionTitle;
						if (strWidth(t) > remainW - 1) {
							// Truncate with …
							const avail = remainW - 1;
							let cut = "";
							for (const ch of t) {
								if (strWidth(cut + ch) > avail) break;
								cut += ch;
							}
							titlePart = "  " + theme.fg("muted", cut + "\u2026");
						} else {
							titlePart = "  " + theme.fg("muted", t);
						}
					}
					const content = prefixStr + titlePart;
					const line1 = truncateToWidth(content, width);


					// ── Line 2: ┌─┐ box top ────────────────────────────────────────
					const border = (s: string) =>
						editorRef?.borderColor(s) ?? theme.fg("borderMuted", s);
					const line2 = truncateToWidth(
						`${border("┌")}${border("─".repeat(width - 2))}${border("┐")}`,
						width,
					);

					return [line1, line2];
				},
			};
		},
		{ placement: "aboveEditor" },
	);

		// ── FOOTER: cwd + git ───────────────────────────────────────────────────

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const gitTimer = setInterval(async () => {
				const changed = await fetchGit();
				if (changed) tui.requestRender();
			}, 5000);
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					clearInterval(gitTimer);
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					const usableW = width - 2;
					const CWD_MAX = Math.floor(usableW * 0.55);

					const cwd = formatCwd(ctx.cwd, CWD_MAX, theme);

					if (!gitState) {
						return [bgLine(theme, cwd.text, width)];
					}

					const git = formatGit(gitState, theme);
					const line = cwd.text + "  " + git.text;
					return [bgLine(theme, line, width)];
				},
			};
		});
	});
}
