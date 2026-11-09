import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------
// Local copy of the subset of @juicesharp/rpiv-config needed by this extension.
// Vendored to keep beautiful-pi self-contained (no external rpiv-* dependency).
// Original author: juicesharp (MIT). See THIRD-PARTY-NOTICES.md.
// ---------------------------------------------------------------------------

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function defaultConfigDir(): string {
	return join(homedir(), ".config");
}

function resolveConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (!xdg) return defaultConfigDir();
	const expanded = expandTilde(xdg);
	return isAbsolute(expanded) ? expanded : defaultConfigDir();
}

function legacyConfigPath(name: string, file: string = "config.json"): string {
	return join(defaultConfigDir(), name, file);
}

function configPath(name: string, file: string = "config.json"): string {
	return join(resolveConfigDir(), name, file);
}

function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (err) {
		console.warn(`rpiv-config: invalid JSON at ${path}, using default ({}) — ${(err as Error).message}`);
		return {} as T;
	}
}

function loadJsonConfigWithLegacyFallback<T>(name: string, file: string = "config.json"): T {
	const xdgPath = configPath(name, file);
	if (existsSync(xdgPath)) {
		return loadJsonConfig<T>(xdgPath);
	}
	return loadJsonConfig<T>(legacyConfigPath(name, file));
}

// (chmodSync/mkdirSync/writeFileSync/dirsname retained for parity; unused but harmless)
void chmodSync;
void mkdirSync;
void writeFileSync;
void dirname;

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]"
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";
export const DEFAULT_NOTES_KEY = "n";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
	/**
	 * Key that opens the notes editor. Defaults to `"n"`. A single character of any
	 * script (e.g. `"т"` on a Cyrillic layout) matches as typed; anything else is a
	 * key spec in the `collapseKey` format, e.g. `"ctrl+n"`.
	 */
	notesKey?: string;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

const NOTES_KEY_RESERVED = new Set(["space", "enter", "return", "tab", "escape", "esc", "up", "down", "left", "right"]);

export function resolveNotesKey(config: Pick<AskUserQuestionConfig, "notesKey">): string {
	const raw = config.notesKey?.trim();
	if (!raw) return DEFAULT_NOTES_KEY;
	if ([...raw].length === 1) return raw;
	const spec = raw.toLowerCase();
	return isValidCollapseKeySpec(spec) && !NOTES_KEY_RESERVED.has(spec) ? spec : DEFAULT_NOTES_KEY;
}

export function formatNotesKeyForDisplay(notesKey: string): string {
	return [...notesKey].length === 1 ? notesKey : formatKeySpecForDisplay(notesKey);
}

const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

export function loadConfig(): AskUserQuestionConfig {
	return loadJsonConfigWithLegacyFallback<AskUserQuestionConfig>("rpiv-ask-user-question");
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	if (typeof g.description === "string" && g.description.length > 0) {
		result.description = g.description;
	}
	return result;
}
