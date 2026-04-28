/**
 * Agent Banner — Sophisticated startup banner for pi
 *
 * Left: large π ASCII art with gradient colours
 * Right: session info panel, right-aligned
 * Uses full terminal width. Hides on first input.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { strWidth } from "../shared/icons.ts";
import { loadSettings } from "../shared/settings.ts";

const { readFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

/* ──────────────────────────────────────────────────────────────────────────────
   Custom art loader (legacy)
   ────────────────────────────────────────────────────────────────────────────── */

const DEFAULT_ART = `                             ▄▄
█████▄ ▄████▄ ▄████▄ █████▄ ▄██▄▄▄
▄▄▄▄██ ██  ██ ██▄▄██ ██  ██ ▀██▀▀▀
██▄▄██ ██▄▄██ ██▄▄▄▄ ██  ██  ██▄▄▄
 ▀▀▀▀▀  ▀▀▀██  ▀▀▀▀▀ ▀▀  ▀▀   ▀▀▀▀
        ████▀                     `;

function loadArt(): string {
	const path = join(homedir(), "Desktop", "agent.txt");
	if (existsSync(path)) {
		try {
			return readFileSync(path, "utf-8").trimEnd();
		} catch {
			/* fall through */
		}
	}
	return DEFAULT_ART;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Data gatherers
   ────────────────────────────────────────────────────────────────────────────── */

function getPiVersion(): string {
	const candidates = [
		// npm global (e.g. ~/.npm-global)
		join(homedir(), ".npm-global", "lib", "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
		// nvm-managed node
		join(homedir(), ".nvm", "versions", "node", process.version, "lib", "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
		// system npm prefix fallback
		join("/usr", "local", "lib", "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
	];

	// Also try resolving from the pi binary location
	try {
		const { execSync } = require("node:child_process");
		const piPath = execSync("which pi", { encoding: "utf-8" }).trim();
		if (piPath) {
			const realPath = require("node:fs").realpathSync(piPath);
			// realPath is something like .../pi-coding-agent/dist/cli.js
			const pkgPath = join(realPath, "..", "..", "package.json");
			candidates.unshift(pkgPath);
		}
	} catch { /* ignore */ }

	for (const p of candidates) {
		try {
			const pkg = JSON.parse(readFileSync(p, "utf-8"));
			if (pkg.version) return pkg.version;
		} catch { /* try next */ }
	}
	return "?.?.?";
}

function countSkills(): number {
	let count = 0;
	const skillRoots = [
		join(homedir(), ".pi", "agent", "skills"),
		join(homedir(), ".agents", "skills"),
	];

	for (const root of skillRoots) {
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const subPath = join(root, entry.name);
				const subEntries = readdirSync(subPath, { withFileTypes: true });
				for (const sub of subEntries) {
					if (sub.isDirectory() && existsSync(join(subPath, sub.name, "SKILL.md"))) {
						count++;
					}
				}
			}
		} catch {
			/* ignore */
		}
	}
	return count;
}

function countExtensions(): number {
	const extDir = join(homedir(), ".pi", "agent", "extensions");
	if (!existsSync(extDir)) return 0;
	try {
		return readdirSync(extDir).filter(
			(f: string) => f.endsWith(".ts") || f.endsWith(".js"),
		).length;
	} catch {
		return 0;
	}
}

function formatTime(): string {
	const now = new Date();
	const h = String(now.getHours()).padStart(2, "0");
	const m = String(now.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

/* ──────────────────────────────────────────────────────────────────────────────
   π ASCII art — large, recognisable, multi-colour
   ────────────────────────────────────────────────────────────────────────────── */

// π ASCII art — user-provided, 14 cols
const PI_RAW = [
	"           ░██",
	"              ",
	"░████████  ░██",
	"░██    ░██ ░██",
	"░██    ░██ ░██",
	"░███   ░██ ░██",
	"░██░█████  ░██",
	"░██           ",
	"░██           ",
];

function buildPiArt(theme: Theme): string[] {
	return PI_RAW.map((row) =>
		row
			.split("")
			.map((ch) => (ch === " " ? " " : theme.fg("accent", ch)))
			.join(""),
	);
}

/* ──────────────────────────────────────────────────────────────────────────────
   Info card — bordered card with session info
   ────────────────────────────────────────────────────────────────────────────── */

function buildInfoCard(ctx: ExtensionContext, theme: Theme): string[] {
	const themeName = theme.name
		? theme.name.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())
		: "Default";
	const version = getPiVersion();
	const skills = countSkills();
	const extensions = countExtensions();
	const modelName = ctx.model?.name || ctx.model?.id || "—";
	const time = formatTime();

	const label = (t: string) => theme.fg("muted", t);
	const val = (t: string, c: ThemeColor = "text") => theme.fg(c, t);
	const bdr = (t: string) => theme.fg("borderMuted", t);

	const innerLines = [
		`${label("theme   ")}  ${val(themeName)}`,
		`${label("version ")}  ${val(version, "mdCode")}`,
		`${label("skills  ")}  ${val(String(skills), "syntaxString")}`,
		`${label("exts    ")}  ${val(String(extensions), "syntaxFunction")}`,
		`${label("model   ")}  ${val(modelName, "mdHeading")}`,
		`${label("session ")}  ${val(time, "dim")}`,
	];

	const maxLen = Math.max(...innerLines.map(visibleLen));
	// innerW = content width + 2 padding spaces (1 left + 1 right)
	const innerW = maxLen + 2;

	// Title centred in the top border
	const titleRaw = " π  CODING AGENT ";
	const titleStyled = theme.bold(val(titleRaw, "accent"));
	const titleLen = titleRaw.length;
	const leftDashes = Math.floor((innerW - titleLen) / 2);
	const rightDashes = innerW - titleLen - leftDashes;

	const top = bdr("╭") + bdr("─".repeat(leftDashes)) + titleStyled + bdr("─".repeat(rightDashes)) + bdr("╮");
	const bottom = bdr("╰") + bdr("─".repeat(innerW)) + bdr("╯");

	const lines: string[] = [top];
	for (const line of innerLines) {
		lines.push(bdr("│") + " " + padVisible(line, maxLen) + " " + bdr("│"));
	}
	lines.push(bottom);
	return lines;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────────────────────── */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const visibleLen = strWidth;

function padVisible(str: string, target: number): string {
	const vlen = visibleLen(str);
	return vlen >= target ? str : str + " ".repeat(target - vlen);
}



/* ──────────────────────────────────────────────────────────────────────────────
   Main banner renderer
   ────────────────────────────────────────────────────────────────────────────── */

export function showBanner(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const customArt = loadArt();
	const isCustom = customArt !== DEFAULT_ART;

	if (isCustom) {
		const split = customArt.split("\n");
		const firstNonEmpty = split.findIndex((l: string) => l.trim() !== "");
		const lines = firstNonEmpty >= 0 ? split.slice(firstNonEmpty) : split;

		ctx.ui.setWidget(
			"agent-banner",
			(_tui, theme) => ({
				invalidate() {},
				render(_width: number): string[] {
					const rendered = lines.map((line) => theme.fg("accent", line));
					rendered.push("");
					return rendered;
				},
			}),
			{ placement: "aboveEditor" },
		);
		return;
	}

	ctx.ui.setWidget(
		"agent-banner",
		(_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const piArt = buildPiArt(theme);
				const card = buildInfoCard(ctx, theme);

				const piWidth = 14; // visible width of π art
				const cardWidth = visibleLen(card[0]); // all card lines same visible width
				const gap = 4;
				const totalWidth = piWidth + gap + cardWidth;

				// If terminal is very narrow, just stack them
				if (width < totalWidth) {
					const out = ["", ...piArt, "", ...card, ""];
					return out;
				}

				// Center the combined block on screen
				const leftPad = " ".repeat(Math.max(0, Math.floor((width - totalWidth) / 2)));

				// Vertically centre the shorter column
				const maxRows = Math.max(piArt.length, card.length);
				const piOffset = Math.floor((maxRows - piArt.length) / 2);
				const cardOffset = Math.floor((maxRows - card.length) / 2);

				const out: string[] = [""];
				for (let i = 0; i < maxRows; i++) {
					const left = (i >= piOffset && i < piOffset + piArt.length) ? piArt[i - piOffset] : "";
					const right = (i >= cardOffset && i < cardOffset + card.length) ? card[i - cardOffset] : "";
					out.push(leftPad + padVisible(left, piWidth) + " ".repeat(gap) + right);
				}
				out.push("");
				return out;
			},
		}),
		{ placement: "aboveEditor" },
	);
}

/* ──────────────────────────────────────────────────────────────────────────────
   Lifecycle
   ────────────────────────────────────────────────────────────────────────────── */

let bannerCtx: ExtensionContext | null = null;
let bannerVisible = false;

export function isBannerVisible(): boolean {
	return bannerVisible;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		bannerCtx = ctx;
		bannerVisible = true;
		if (loadSettings().showBanner) {
			showBanner(ctx);
		}
	});

	pi.on("session_switch", async (_event, ctx: ExtensionContext) => {
		bannerCtx = ctx;
		bannerVisible = true;
		if (loadSettings().showBanner) {
			showBanner(ctx);
		}
	});

	pi.on("input", async () => {
		if (bannerCtx?.hasUI) {
			bannerCtx.ui.setWidget("agent-banner", undefined);
			bannerVisible = false;
		}
	});
}
