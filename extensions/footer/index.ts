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

	if (state.behind > 0) add(` ⇣${state.behind}`, "error");
	if (state.ahead > 0) add(` ⇡${state.ahead}`, "success");
	if (state.staged > 0) add(` ✚${state.staged}`, "success");
	if (state.modified > 0) add(` !${state.modified}`, "warning");
	if (state.untracked > 0) add(` ?${state.untracked}`, "dim");

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
function bgBorderLine(
	borderFn: (s: string) => string,
	content: string,
	width: number,
): string {
	const innerW = width - 2;
	const c = truncateToWidth(content, innerW);
	const cW = visibleWidth(c);
	const trail = cW < innerW ? borderFn("─".repeat(innerW - cW)) : "";
	return borderFn("─") + c + trail + borderFn("─");
}

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

		// ── ABOVE EDITOR: stats widget ──────────────────────────────────────────

		ctx.ui.setWidget(
			"stats-bar",
			(tui: any, theme: any) => {
				// Track the last rendered minute so we only re-render when it actually changes
				let lastRenderedMinute = -1;
				const timer = setInterval(() => {
					const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
					const currentMinute = Math.floor(elapsed / 60);
					if (currentMinute !== lastRenderedMinute) {
						lastRenderedMinute = currentMinute;
						tui.requestRender();
					}
				}, 30_000);

				return {
					dispose() {
						clearInterval(timer);
					},
					invalidate() {},
					render(width: number): string[] {
						// Token stats
						let totalInput = 0,
							totalOutput = 0,
							totalCacheRead = 0,
							totalCost = 0;
						for (const entry of ctx.sessionManager.getEntries()) {
							if (
								entry.type === "message" &&
								entry.message.role === "assistant"
							) {
								const m = entry.message as any;
								totalInput += m.usage.input;
								totalOutput += m.usage.output;
								totalCacheRead += m.usage.cacheRead;
								totalCost += m.usage.cost.total;
							}
						}

						// Context usage
						let contextPercent = 0,
							contextWindow = 0,
							contextStr = "?";
						const cu = ctx.getContextUsage();
						if (cu) {
							contextPercent = (cu as any).percent ?? 0;
							contextWindow = (cu as any).contextWindow ?? 0;
							contextStr = `${contextPercent.toFixed(0)}%`;
						}

						// Session timer (minutes resolution — updated every 30s)
						const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
						const h = Math.floor(elapsed / 3600);
						const m = Math.floor((elapsed % 3600) / 60);
						const timeStr =
							h > 0 ? `${h}:${String(m).padStart(2, "0")}h` : `${m}m`;

						// Model + thinking
						const icons = getIcons();
						const fullModelId = ctx.model?.id ?? "no-model";
						const modelId = fullModelId
							.replace(/^.*\//, "")
							.replace(/-\d{8}$/, "")
							.replace(/@.*$/, "");
						const thinkingLevel = pi.getThinkingLevel();
						const thinkingText = thinkingLevel
							? getThinkingText(thinkingLevel)
							: undefined;
						const modelDisplay = modelId;
						const modelDisplayW = visibleWidth(modelId);

						// Progress bar
						const barTotal = 12;
						const barFilled = Math.min(
							barTotal,
							Math.round((contextPercent / 100) * barTotal),
						);
						const barEmpty = barTotal - barFilled;
						let barColor: string;
						if (contextPercent > 90) barColor = "error";
						else if (contextPercent > 70) barColor = "warning";
						else barColor = "success";
						const progressBar =
							theme.fg("dim", "[") +
							theme.fg(barColor, "█".repeat(barFilled)) +
							theme.fg("dim", "░".repeat(barEmpty)) +
							theme.fg("dim", "]");
						const contextLabel =
							contextPercent > 90
								? theme.fg("error", contextStr)
								: contextPercent > 70
									? theme.fg("warning", contextStr)
									: theme.fg("muted", contextStr);
						const contextWindowLabel =
							contextWindow > 0 ? `/${fmt(contextWindow)}` : "";

						// Segments: each is " content " (1 space each side), separated by border("─")
						// Layout: ─ π ─ model ─ [thinking] ─ ctx ──fill──── tokens ─ timer ─

						const border = (s: string) =>
							editorRef?.borderColor(s) ?? theme.fg("borderMuted", s);
						const sep = border("─");
						const fill = (n: number) => border("─".repeat(Math.max(1, n)));
						const usableW = width - 2; // bgBorderLine handles the 2 edge chars

						// ── Segment definitions ─────────────────────────────────────────
						const starPi = theme.fg("accent", icons.pi);
						const modelStr = theme.fg("muted", modelDisplay);

						const piSeg = " " + starPi + " ";
						const piW = 1 + strWidth(icons.pi) + 1;
						const mdSeg = " " + modelStr + " ";
						const mdW = 1 + modelDisplayW + 1;
						const thSeg = thinkingText
							? " " + theme.fg("dim", thinkingText) + " "
							: "";
						const thW = thinkingText ? 1 + visibleWidth(thinkingText) + 1 : 0;

						const ctxFull =
							progressBar +
							" " +
							contextLabel +
							theme.fg("muted", contextWindowLabel);
						const ctxFullW =
							2 +
							barTotal +
							1 +
							visibleWidth(contextStr) +
							visibleWidth(contextWindowLabel);
						const ctxCmpct = progressBar + " " + contextLabel;
						const ctxCmpctW = 2 + barTotal + 1 + visibleWidth(contextStr);

						// Build context segment variants
						const ctxSeg = " " + ctxFull + " ";
						const ctxSegW = 1 + ctxFullW + 1;
						const ctxCSeg = " " + ctxCmpct + " ";
						const ctxCSegW = 1 + ctxCmpctW + 1;

						// Tokens segment (optional)
						const tokenParts: string[] = [];
						const tokenPartsW: number[] = [];
						if (totalInput || totalOutput) {
							const t = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
							tokenParts.push(theme.fg("dim", t));
							tokenPartsW.push(strWidth(t));
						}
						if (totalCacheRead) {
							const t = `R${fmt(totalCacheRead)}`;
							tokenParts.push(theme.fg("dim", t));
							tokenPartsW.push(strWidth(t));
						}
						if (totalCost > 0) {
							const t = `$${totalCost.toFixed(3)}`;
							tokenParts.push(theme.fg("dim", t));
							tokenPartsW.push(strWidth(t));
						}
						const tokenStr = tokenParts.join(" ");
						const tokenVisW =
							tokenPartsW.reduce((a, b) => a + b, 0) +
							Math.max(0, tokenPartsW.length - 1);
						const tokSeg = tokenVisW > 0 ? " " + tokenStr + " " : "";
						const tokW = tokenVisW > 0 ? 1 + tokenVisW + 1 : 0;

						// Timer segment
						const clockIcon = icons.time ? icons.time + " " : "";
						const timerPart = theme.fg("muted", clockIcon + timeStr);
						const timerVisW = strWidth(clockIcon) + strWidth(timeStr);
						const clkSeg = " " + timerPart + " ";
						const clkW = 1 + timerVisW + 1;

						// ── Layout: build left + fill + right ────────────────────────────
						// left  = piSeg + sep + mdSeg [+ sep + thSeg] + sep + ctxVariant
						// right = [tokSeg + sep] + clkSeg
						// fill  = usableW - leftW - rightW  (min 1)

						const mkLeft = (useThink: boolean, cs: string, cw: number) => ({
							text:
								piSeg +
								sep +
								mdSeg +
								(useThink && thW > 0 ? sep + thSeg : "") +
								sep +
								cs,
							w: piW + 1 + mdW + (useThink && thW > 0 ? 1 + thW : 0) + 1 + cw,
						});
						const mkRight = (useTok: boolean) => ({
							text: useTok && tokW > 0 ? tokSeg + sep + clkSeg : clkSeg,
							w: useTok && tokW > 0 ? tokW + 1 + clkW : clkW,
						});
						const mkLine = (
							left: { text: string; w: number },
							right: { text: string; w: number },
						) => {
							const f = usableW - left.w - right.w;
							const line =
								f >= 1
									? left.text + fill(f) + right.text
									: left.text + right.text;
							// Ensure line is never wider than usableW
							return truncateToWidth(line, usableW);
						};

						// Attempt from most to least content
						const attempts: Array<[boolean, string, number, boolean]> = [
							[true, ctxSeg, ctxSegW, true],
							[true, ctxSeg, ctxSegW, false],
							[false, ctxSeg, ctxSegW, true],
							[false, ctxSeg, ctxSegW, false],
							[false, ctxCSeg, ctxCSegW, false],
						];

						let line = "";
						for (const [useThink, cs, cw, useTok] of attempts) {
							const L = mkLeft(useThink, cs, cw);
							const R = mkRight(useTok);
							if (L.w + 1 + R.w <= usableW) {
								line = mkLine(L, R);
								break;
							}
						}
						if (!line) {
							// Ultra-narrow: just π + compact ctx
							const L = { text: piSeg + sep + ctxCSeg, w: piW + 1 + ctxCSegW };
							line =
								L.w <= usableW
									? mkLine(L, { text: "", w: 0 })
									: truncateToWidth(piSeg + ctxCSeg, usableW);
						}

						return [bgBorderLine(border, line, width)];
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
