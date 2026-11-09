/**
 * btw-ui — centered, bounded dialog overlay for /btw.
 *
 * Layout (grows with content, capped at 70% of terminal height):
 *   banner (theme.bg stripe, padded to dialog width)  question header
 *   blank
 *   history  — "/btw <q>" (accent prefix + muted text), left-padded 2 cols
 *   echo     — "/btw <q>" (accent prefix + muted text), left-padded 2 cols
 *   blank
 *   answer   — body wrapped at width-2, left-padded 2 cols
 *   blank
 *   footer   — key hints (dim)                       sticky bottom
 *
 * Natural height grows with history and answer content. Pi-tui centers the dialog;
 * if content exceeds the height cap, ↑/↓ scroll the clipped window.
 *
 * Keys (via matchesKey — handles ANSI + Kitty):
 *   Esc → abort in-flight call + dismiss
 *   ↑/↓ → scroll (when content exceeds terminal)
 *   x   → clear current-session /btw history
 *   (f fork key deferred)
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import {
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type BtwTurn, userMessageText } from "./btw-messages.ts";

const BTW_MAX_HEIGHT_RATIO = 0.7;

const BTW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "75%",
	maxHeight: `${BTW_MAX_HEIGHT_RATIO * 100}%`,
};

const SIDE_PAD = "  "; // 2-col left gutter for history, echo, footer
const ANSWER_PAD = "    "; // 4-col left gutter for answer body (double of SIDE_PAD)
const BTW_LITERAL = "/btw";
const PENDING_GLYPH = "…";
const FOOTER_SCROLL = "↑/↓ to scroll";
const FOOTER_CLEAR = "x to clear history";
const FOOTER_DISMISS = "Esc to dismiss";
const FOOTER_SEP = " · ";
const MSG_TRIMMED = "context trimmed to fit budget";

type Mode = "pending" | "answer" | "error";

export interface ShowBtwOverlayParams {
	ctx: ExtensionCommandContext;
	question: string;
	history: BtwTurn[];
	controller: AbortController;
	onClearHistory: () => void;
}

export interface ShowBtwOverlayResult {
	overlayPromise: Promise<void>;
	controllerReady: Promise<BtwOverlayController>;
}

export class BtwOverlayController implements Component {
	private mode: Mode = "pending";
	private answer = "";
	private error = "";
	private scrollOffset = 0;
	private trimmed = false;
	private history: BtwTurn[];

	constructor(
		private readonly question: string,
		history: BtwTurn[],
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (result?: undefined) => void,
		private readonly controller: AbortController,
		private readonly onClearHistory: () => void,
	) {
		this.history = [...history];
	}

	setAnswer(text: string): void {
		this.mode = "answer";
		this.answer = text;
		this.tui.requestRender();
	}

	setError(message: string): void {
		this.mode = "error";
		this.error = message;
		this.tui.requestRender();
	}

	// Orthogonal to mode: a trimmed result is also a successful answer.
	// Idempotent; a fresh controller is built per /btw command in showBtwOverlay,
	// so there is no reset path.
	setTrimmed(): void {
		this.trimmed = true;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.controller.abort();
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset = this.scrollOffset + 1;
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			this.history = [];
			this.onClearHistory();
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const banner = this.renderBanner(width);
		const historyLines = this.history.map((h) => this.historyLine(userMessageText(h.userMessage), width));
		const answerLines = this.renderAnswer(width);
		const footerAvail = Math.max(1, width - SIDE_PAD.length);
		const footerParts: string[] = [];
		if (this.mode !== "pending") footerParts.push(FOOTER_SCROLL);
		if (this.history.length > 0) footerParts.push(FOOTER_CLEAR);
		footerParts.push(FOOTER_DISMISS);
		const footer =
			SIDE_PAD + truncateToWidth(this.theme.fg("dim", footerParts.join(FOOTER_SEP)), footerAvail, "…", false);

		// Natural content: banner + blank + history + blank + answer [+ trim notice] + blank + footer
		const natural: string[] = [
			banner,
			"",
			...historyLines,
			"",
			...answerLines,
			...(this.trimmed
				? [
						ANSWER_PAD +
							truncateToWidth(
								this.theme.fg("warning", MSG_TRIMMED),
								Math.max(1, width - ANSWER_PAD.length),
								"…",
								false,
							),
					]
				: []),
			"",
			footer,
		];

		// Clip to the dialog height cap; the default view favors newest content.
		// ↑/↓ moves the clipped window to reveal older history.
		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(4, Math.floor(termRows * BTW_MAX_HEIGHT_RATIO));
		if (natural.length <= maxRows) {
			return natural;
		}
		const excess = natural.length - maxRows;
		if (this.scrollOffset > excess) this.scrollOffset = excess;
		// scrollOffset=0 shows the BOTTOM (newest). Scrolling up reveals older history.
		const start = excess - this.scrollOffset;
		return natural.slice(start, start + maxRows);
	}

	invalidate(): void {
		// no-op — render recomputes from state each cycle
	}

	private renderBanner(width: number): string {
		const prefix = `${SIDE_PAD}${BTW_LITERAL} `;
		const prefixWidth = visibleWidth(prefix);
		const qAvail = Math.max(0, width - prefixWidth);
		const qTrunc = truncateToWidth(this.question, qAvail, "…", false);
		const raw = prefix + qTrunc;
		const padded = raw + " ".repeat(Math.max(0, width - visibleWidth(raw)));
		return this.theme.bg("customMessageBg", this.theme.fg("customMessageText", padded));
	}

	private historyLine(question: string, width: number): string {
		const qAvail = Math.max(0, width - SIDE_PAD.length);
		const qClean = question.replace(/\s+/g, " ").trim();
		const raw = `${BTW_LITERAL} ${qClean}`;
		const trunc = truncateToWidth(raw, qAvail, "…", false);
		return SIDE_PAD + this.theme.fg("muted", trunc);
	}

	private wrapBodyLines(text: string, bodyWidth: number, colorFn?: (s: string) => string): string[] {
		const out: string[] = [];
		for (const ln of text.split("\n")) {
			const src = ln.length === 0 ? " " : ln;
			const colored = colorFn ? colorFn(src) : src;
			out.push(...wrapTextWithAnsi(colored, bodyWidth));
		}
		return out;
	}

	private renderAnswer(width: number): string[] {
		const bodyWidth = Math.max(1, width - ANSWER_PAD.length);
		const indent = (lines: string[]) => lines.map((l) => ANSWER_PAD + l);

		if (this.mode === "pending") {
			return indent([this.theme.fg("warning", PENDING_GLYPH)]);
		}
		if (this.mode === "error") {
			return indent(this.wrapBodyLines(this.error, bodyWidth, (s) => this.theme.fg("error", s)));
		}
		return indent(this.wrapBodyLines(this.answer, bodyWidth));
	}
}

export function showBtwOverlay(params: ShowBtwOverlayParams): ShowBtwOverlayResult {
	let resolveReady!: (controller: BtwOverlayController) => void;
	const controllerReady = new Promise<BtwOverlayController>((resolve) => {
		resolveReady = resolve;
	});

	const overlayPromise = params.ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const controller = new BtwOverlayController(
				params.question,
				params.history,
				theme,
				tui,
				done,
				params.controller,
				params.onClearHistory,
			);
			resolveReady(controller);
			return controller;
		},
		{ overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
	);

	return { overlayPromise, controllerReady };
}
