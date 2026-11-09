/**
 * btw-ui — centered, bounded dialog overlay for /btw.
 *
 * Layout (grows with content, capped at 70% of terminal height):
 *   prompt block — user rail + shared background; blank rows above and below
 *   answer block — tools rail + shared background; spacer rows around answer and hints
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
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { BtwTurn } from "./btw-messages.ts";
import { loadSettings, safeBg, safeFg } from "../shared/settings.ts";

const BTW_MAX_HEIGHT_RATIO = 0.7;

const BTW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "75%",
	maxHeight: `${BTW_MAX_HEIGHT_RATIO * 100}%`,
};

const RAIL = "┃";
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
		const safeWidth = Math.max(1, Math.floor(width));
		const settings = loadSettings();
		const messageBackground = "userMessageBg";
		const promptStartLine = this.renderRoleLines(
			" ",
			safeWidth,
			settings.userRailColor,
			"accent",
			messageBackground,
			"selectedBg",
			"text",
			"text",
		)[0] ?? "";
		const promptLines = this.renderRoleLines(
			`${BTW_LITERAL} ${this.question}`,
			safeWidth,
			settings.userRailColor,
			"accent",
			messageBackground,
			"selectedBg",
			"userMessageText",
			"text",
		);
		const promptEndLine = this.renderRoleLines(
			" ",
			safeWidth,
			settings.userRailColor,
			"accent",
			messageBackground,
			"selectedBg",
			"text",
			"text",
		)[0] ?? "";
		const promptBlock = [promptStartLine, ...promptLines, promptEndLine];

		const responseText = this.mode === "pending" ? PENDING_GLYPH : this.mode === "error" ? this.error : this.answer;
		const responseColor = this.mode === "pending" ? "warning" : this.mode === "error" ? "error" : "customMessageText";
		const responseFallback = this.mode === "pending" ? "warning" : this.mode === "error" ? "error" : "text";
		const responseLines = this.renderRoleLines(
			responseText,
			safeWidth,
			settings.toolRailColor,
			"success",
			messageBackground,
			"selectedBg",
			responseColor,
			responseFallback,
		);
		const separatorLine = this.renderRoleLines(
			" ",
			safeWidth,
			settings.toolRailColor,
			"success",
			messageBackground,
			"selectedBg",
			"text",
			"text",
		)[0] ?? "";
		const trimLines = this.trimmed
			? this.renderRoleLines(
					MSG_TRIMMED,
					safeWidth,
					settings.toolRailColor,
					"success",
					messageBackground,
					"selectedBg",
					"warning",
					"warning",
				)
			: [];

		const footerParts: string[] = [];
		if (this.mode !== "pending") footerParts.push(FOOTER_SCROLL);
		if (this.history.length > 0) footerParts.push(FOOTER_CLEAR);
		footerParts.push(FOOTER_DISMISS);
		const responseEndLine = this.renderRoleLines(
			" ",
			safeWidth,
			settings.toolRailColor,
			"success",
			messageBackground,
			"selectedBg",
			"text",
			"text",
		)[0] ?? "";
		const footerLines = this.renderRoleLines(
			footerParts.join(FOOTER_SEP),
			safeWidth,
			settings.toolRailColor,
			"success",
			messageBackground,
			"selectedBg",
			"dim",
			"dim",
		);
		const footerEndLine = this.renderRoleLines(
			" ",
			safeWidth,
			settings.toolRailColor,
			"success",
			messageBackground,
			"selectedBg",
			"text",
			"text",
		)[0] ?? "";
		const scrollable = [separatorLine, ...responseLines, ...trimLines, responseEndLine, ...footerLines, footerEndLine];

		// Keep the user prompt visible while scrolling through a long response.
		const termRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.max(promptBlock.length + 1, Math.floor(termRows * BTW_MAX_HEIGHT_RATIO));
		const maxResponseRows = Math.max(1, maxRows - promptBlock.length);
		let visible = scrollable;
		if (scrollable.length > maxResponseRows) {
			const excess = scrollable.length - maxResponseRows;
			if (this.scrollOffset > excess) this.scrollOffset = excess;
			const start = excess - this.scrollOffset;
			visible = scrollable.slice(start, start + maxResponseRows);
		}

		return [...promptBlock, ...visible];
	}

	invalidate(): void {
		// no-op — render recomputes from state each cycle
	}

	private renderRoleLines(
		text: string,
		width: number,
		railColor: string,
		railFallback: string,
		background: string,
		backgroundFallback: string,
		textColor: string,
		textFallback: string,
	): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const rail = safeFg(this.theme, railColor, railFallback, RAIL);
		const prefix = `${rail} `;
		const contentWidth = Math.max(1, safeWidth - visibleWidth(RAIL + " "));

		return wrapTextWithAnsi(text, contentWidth).map((line) => {
			const content = safeFg(this.theme, textColor, textFallback, line);
			const raw = prefix + content;
			const padded = raw + " ".repeat(Math.max(0, safeWidth - visibleWidth(raw)));
			return safeBg(this.theme, background, backgroundFallback, padded);
		});
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
