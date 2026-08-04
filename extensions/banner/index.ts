/**
 * Agent Banner — Sophisticated startup banner for pi
 *
 * Left: large π ASCII art with gradient colours
 * Right: session info panel, right-aligned
 * Uses startup header to fill available terminal height. Hides on first input.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { strWidth } from "../shared/icons.ts";
import { loadSettings } from "../shared/settings.ts";

const {
	readFileSync,
	existsSync,
	readdirSync,
	realpathSync,
	statSync,
} = require("node:fs");
const { basename, dirname, join, relative, resolve } = require("node:path");
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

const PI_PACKAGE_NAMES = ["@earendil-works/pi-coding-agent"];

function packageJsonPath(nodeModulesRoot: string, pkgName: string): string {
	return join(nodeModulesRoot, ...pkgName.split("/"), "package.json");
}

function readPackageVersion(pkgPath: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (PI_PACKAGE_NAMES.includes(pkg.name) && pkg.version)
			return String(pkg.version);
	} catch {
		/* try next */
	}
	return null;
}

function nearestPiPackageJson(startPath: string): string | null {
	try {
		let current = statSync(startPath).isDirectory()
			? startPath
			: dirname(startPath);
		while (true) {
			const pkgPath = join(current, "package.json");
			const version = existsSync(pkgPath) ? readPackageVersion(pkgPath) : null;
			if (version) return pkgPath;

			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	} catch {
		return null;
	}
}

function getPiVersion(): string {
	const candidates: string[] = [];
	const add = (path: string | null | undefined) => {
		if (path && !candidates.includes(path)) candidates.push(path);
	};

	// Best case: pi is the process that loaded this extension, so Node can resolve its package.
	for (const pkgName of PI_PACKAGE_NAMES) {
		try {
			add(require.resolve(`${pkgName}/package.json`));
		} catch {
			/* try next */
		}
	}

	// If the CLI entrypoint lives inside the package (npx/global install), walk up to package.json.
	for (const runtimePath of [process.argv?.[1], require.main?.filename]) {
		if (!runtimePath) continue;
		try {
			add(nearestPiPackageJson(realpathSync(runtimePath)));
		} catch {
			add(nearestPiPackageJson(runtimePath));
		}
	}

	// Common node_modules roots: npm global, pi package cache, nvm/mise, system installs.
	const nodeRoots = [
		join(homedir(), ".npm-global", "lib", "node_modules"),
		join(homedir(), ".pi", "agent", "npm", "node_modules"),
		join(homedir(), ".pi", "agent", "bin", "node_modules"),
		join(
			homedir(),
			".nvm",
			"versions",
			"node",
			process.version,
			"lib",
			"node_modules",
		),
		join(dirname(dirname(process.execPath)), "lib", "node_modules"),
		join("/usr", "local", "lib", "node_modules"),
	];
	for (const root of nodeRoots) {
		for (const pkgName of PI_PACKAGE_NAMES) add(packageJsonPath(root, pkgName));
	}

	// Omarchy's pi wrapper runs pi through npx; include the npx cache directories too.
	const npxRoot = join(homedir(), ".npm", "_npx");
	try {
		const npxDirs = readdirSync(npxRoot, { withFileTypes: true })
			.filter((entry: any) => entry.isDirectory())
			.map((entry: any) => join(npxRoot, entry.name))
			.sort(
				(a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs,
			);
		for (const dir of npxDirs) {
			for (const pkgName of PI_PACKAGE_NAMES)
				add(packageJsonPath(join(dir, "node_modules"), pkgName));
		}
	} catch {
		/* ignore */
	}

	for (const p of candidates) {
		const version = readPackageVersion(p);
		if (version) return version;
	}
	return "?.?.?";
}

/* ──────────────────────────────────────────────────────────────────────────────
   Startup resource listing — compact version of pi's standard resource summary
   ────────────────────────────────────────────────────────────────────────────── */

interface ResourceItem {
	path: string;
	source?: string;
	baseDir?: string;
	packageName?: string;
}

interface StartupResources {
	extensions: string[];
	skills: string[];
	themes: string[];
}

function readJson(path: string): any | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values.filter((v) => v.trim().length > 0))).sort(
		(a, b) => a.localeCompare(b),
	);
}

function compactLabel(label: string): string {
	return label.replace(/\\/g, "/").replace(/\.(ts|js|json|md)$/i, "");
}

function packageNameFromJson(packageRoot: string): string | undefined {
	const pkg = readJson(join(packageRoot, "package.json"));
	return typeof pkg?.name === "string" ? pkg.name : undefined;
}

function collectFilesRecursive(
	dir: string,
	accept: (name: string) => boolean,
): string[] {
	const out: string[] = [];
	if (!isDirectory(dir)) return out;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...collectFilesRecursive(fullPath, accept));
			} else if (entry.isFile() && accept(entry.name)) {
				out.push(fullPath);
			}
		}
	} catch {
		/* ignore */
	}
	return out;
}

function collectThemeFiles(dir: string, recursive = false): string[] {
	if (!isDirectory(dir)) return [];
	if (recursive)
		return collectFilesRecursive(dir, (name) => name.endsWith(".json"));
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter(
				(entry: any) =>
					entry.isFile() &&
					!entry.name.startsWith(".") &&
					entry.name.endsWith(".json"),
			)
			.map((entry: any) => join(dir, entry.name));
	} catch {
		return [];
	}
}

function collectSkillFiles(
	dir: string,
	includeRootMd = true,
	root = dir,
): string[] {
	if (!isDirectory(dir)) return [];
	const skillPath = join(dir, "SKILL.md");
	if (isFile(skillPath)) return [skillPath];

	const out: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...collectSkillFiles(fullPath, includeRootMd, root));
			} else if (
				includeRootMd &&
				dir === root &&
				entry.isFile() &&
				entry.name.endsWith(".md")
			) {
				out.push(fullPath);
			}
		}
	} catch {
		/* ignore */
	}
	return out;
}

function resolveExtensionEntries(dir: string): string[] | null {
	const manifest = readJson(join(dir, "package.json"))?.pi;
	if (Array.isArray(manifest?.extensions) && manifest.extensions.length > 0) {
		const entries = manifest.extensions
			.filter(
				(entry: any) =>
					typeof entry === "string" &&
					!entry.startsWith("!") &&
					!entry.startsWith("+") &&
					!entry.startsWith("-"),
			)
			.map((entry: string) => resolve(dir, entry))
			.filter((entry: string) => existsSync(entry));
		if (entries.length > 0) return entries;
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (isFile(indexTs)) return [indexTs];
	if (isFile(indexJs)) return [indexJs];
	return null;
}

function collectExtensionFiles(dir: string): string[] {
	if (!isDirectory(dir)) return [];

	// Match pi's extension discovery: a directory with package.json `pi.extensions`
	// or `index.ts/js` is itself one extension entry; otherwise inspect one level.
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;

	const out: string[] = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
				out.push(fullPath);
			} else if (entry.isDirectory()) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) out.push(...resolvedEntries);
			}
		}
	} catch {
		/* ignore */
	}
	return out;
}

function collectFilesFromPaths(
	paths: string[],
	resourceType: "extensions" | "skills" | "themes",
): string[] {
	const out: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		if (isFile(p)) {
			out.push(p);
		} else if (isDirectory(p)) {
			if (resourceType === "extensions") out.push(...collectExtensionFiles(p));
			if (resourceType === "skills") out.push(...collectSkillFiles(p));
			if (resourceType === "themes") out.push(...collectThemeFiles(p, true));
		}
	}
	return out;
}

function parseNpmName(source: string): string | null {
	if (!source.startsWith("npm:")) return null;
	const spec = source.slice("npm:".length).trim();
	if (!spec) return null;
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		if (slash === -1) return spec;
		const versionAt = spec.indexOf("@", slash + 1);
		return versionAt === -1 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.indexOf("@");
	return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

function parseGitSource(
	source: string,
): { host: string; repoPath: string } | null {
	let s = source.startsWith("git:") ? source.slice("git:".length) : source;
	s = s
		.replace(/^https?:\/\//, "")
		.replace(/^ssh:\/\//, "")
		.replace(/^git:\/\//, "");
	const match =
		s.match(/^git@([^:]+):(.+)$/) || s.match(/^(?:[^@/]+@)?([^/:]+)[:/](.+)$/);
	if (!match) return null;
	let repoPath = match[2].replace(/\.git$/, "");
	const refAt = repoPath.lastIndexOf("@");
	if (refAt > 0) repoPath = repoPath.slice(0, refAt);
	return { host: match[1], repoPath };
}

function resolvePackageRoot(
	source: string,
	scope: "user" | "project",
	cwd: string,
): string | null {
	const agentDir = join(homedir(), ".pi", "agent");
	const projectDir = join(cwd, ".pi");
	const baseDir = scope === "project" ? projectDir : agentDir;

	const npmName = parseNpmName(source);
	if (npmName) {
		const managed = join(baseDir, "npm", "node_modules", ...npmName.split("/"));
		if (existsSync(managed)) return managed;
		const legacy = join(
			homedir(),
			".npm-global",
			"lib",
			"node_modules",
			...npmName.split("/"),
		);
		return existsSync(legacy) ? legacy : managed;
	}

	const gitSource = parseGitSource(source);
	if (gitSource) {
		return join(baseDir, "git", gitSource.host, gitSource.repoPath);
	}

	return resolve(baseDir, source);
}

function collectPackageResourceItems(
	packageRoot: string,
	resourceType: "extensions" | "skills" | "themes",
	source: string,
	enabledFilter: any,
): ResourceItem[] {
	if (!isDirectory(packageRoot)) return [];
	if (Array.isArray(enabledFilter) && enabledFilter.length === 0) return [];

	const pkgName = packageNameFromJson(packageRoot) ?? basename(packageRoot);
	const manifest = readJson(join(packageRoot, "package.json"))?.pi;
	const manifestEntries = manifest?.[resourceType];
	let paths: string[] = [];

	if (Array.isArray(manifestEntries)) {
		const entries = manifestEntries
			.filter(
				(entry: any) =>
					typeof entry === "string" &&
					!entry.startsWith("!") &&
					!entry.startsWith("+") &&
					!entry.startsWith("-") &&
					!entry.includes("*") &&
					!entry.includes("?"),
			)
			.map((entry: string) => resolve(packageRoot, entry));
		paths = collectFilesFromPaths(entries, resourceType);
	} else {
		const conventionDir = join(packageRoot, resourceType);
		if (resourceType === "extensions")
			paths = collectExtensionFiles(conventionDir);
		if (resourceType === "skills") paths = collectSkillFiles(conventionDir);
		if (resourceType === "themes")
			paths = collectThemeFiles(conventionDir, true);
	}

	return paths.map((path) => ({
		path,
		source,
		baseDir: packageRoot,
		packageName: pkgName,
	}));
}

function readSettingsFile(path: string): any {
	return readJson(path) ?? {};
}

function collectConfiguredResourceItems(
	settings: any,
	scope: "user" | "project",
	cwd: string,
	resourceType: "extensions" | "skills" | "themes",
): ResourceItem[] {
	const entries = Array.isArray(settings?.[resourceType])
		? settings[resourceType]
		: [];
	if (entries.length === 0) return [];
	const baseDir =
		scope === "project" ? join(cwd, ".pi") : join(homedir(), ".pi", "agent");
	const paths = entries
		.filter(
			(entry: any) =>
				typeof entry === "string" &&
				!entry.startsWith("!") &&
				!entry.startsWith("+") &&
				!entry.startsWith("-") &&
				!entry.includes("*") &&
				!entry.includes("?"),
		)
		.map((entry: string) => resolve(baseDir, entry));
	return collectFilesFromPaths(paths, resourceType).map((path) => ({
		path,
		source: "local",
		baseDir,
	}));
}

function collectAncestorAgentsSkillDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	while (true) {
		dirs.push(join(current, ".agents", "skills"));
		if (existsSync(join(current, ".git"))) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function collectStartupResourceItems(ctx: ExtensionContext): {
	extensions: ResourceItem[];
	skills: ResourceItem[];
	themes: ResourceItem[];
} {
	const cwd = ctx.cwd;
	const agentDir = join(homedir(), ".pi", "agent");
	const projectDir = join(cwd, ".pi");
	const globalSettings = readSettingsFile(join(agentDir, "settings.json"));
	const projectSettings = readSettingsFile(join(projectDir, "settings.json"));
	const result = {
		extensions: [] as ResourceItem[],
		skills: [] as ResourceItem[],
		themes: [] as ResourceItem[],
	};

	// Top-level configured paths.
	for (const resourceType of ["extensions", "skills", "themes"] as const) {
		result[resourceType].push(
			...collectConfiguredResourceItems(
				projectSettings,
				"project",
				cwd,
				resourceType,
			),
		);
		result[resourceType].push(
			...collectConfiguredResourceItems(
				globalSettings,
				"user",
				cwd,
				resourceType,
			),
		);
	}

	// Auto-discovered project/user resources, matching pi's standard locations.
	result.extensions.push(
		...collectExtensionFiles(join(projectDir, "extensions")).map((path) => ({
			path,
			source: "auto",
			baseDir: projectDir,
		})),
	);
	result.extensions.push(
		...collectExtensionFiles(join(agentDir, "extensions")).map((path) => ({
			path,
			source: "auto",
			baseDir: agentDir,
		})),
	);
	result.skills.push(
		...collectSkillFiles(join(projectDir, "skills")).map((path) => ({
			path,
			source: "auto",
			baseDir: projectDir,
		})),
	);
	for (const dir of collectAncestorAgentsSkillDirs(cwd)) {
		result.skills.push(
			...collectSkillFiles(dir, false).map((path) => ({
				path,
				source: "auto",
				baseDir: dirname(dir),
			})),
		);
	}
	result.skills.push(
		...collectSkillFiles(join(agentDir, "skills")).map((path) => ({
			path,
			source: "auto",
			baseDir: agentDir,
		})),
	);
	result.skills.push(
		...collectSkillFiles(join(homedir(), ".agents", "skills"), false).map(
			(path) => ({ path, source: "auto", baseDir: join(homedir(), ".agents") }),
		),
	);
	result.themes.push(
		...collectThemeFiles(join(projectDir, "themes")).map((path) => ({
			path,
			source: "auto",
			baseDir: projectDir,
		})),
	);
	result.themes.push(
		...collectThemeFiles(join(agentDir, "themes")).map((path) => ({
			path,
			source: "auto",
			baseDir: agentDir,
		})),
	);

	// Installed packages. Project settings win visually by being collected first; labels are deduped later.
	for (const [settings, scope] of [
		[projectSettings, "project"],
		[globalSettings, "user"],
	] as const) {
		const packages = Array.isArray(settings?.packages) ? settings.packages : [];
		for (const pkg of packages) {
			const source = typeof pkg === "string" ? pkg : pkg?.source;
			if (typeof source !== "string") continue;
			const packageRoot = resolvePackageRoot(source, scope, cwd);
			if (!packageRoot) continue;
			const filter = pkg && typeof pkg === "object" ? pkg : undefined;
			result.extensions.push(
				...collectPackageResourceItems(
					packageRoot,
					"extensions",
					source,
					filter?.extensions,
				),
			);
			result.skills.push(
				...collectPackageResourceItems(
					packageRoot,
					"skills",
					source,
					filter?.skills,
				),
			);
			result.themes.push(
				...collectPackageResourceItems(
					packageRoot,
					"themes",
					source,
					filter?.themes,
				),
			);
		}
	}

	return result;
}

function readSkillName(skillPath: string): string {
	try {
		const content = readFileSync(skillPath, "utf-8");
		const frontMatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
		const source = frontMatter?.[1] ?? content.slice(0, 1200);
		const match = source.match(/^name:\s*["']?([^"'\n#]+)/m);
		if (match?.[1]) return match[1].trim();
	} catch {
		/* ignore */
	}
	if (basename(skillPath) === "SKILL.md") return basename(dirname(skillPath));
	return compactLabel(basename(skillPath));
}

function readThemeName(themePath: string): string {
	const themeJson = readJson(themePath);
	return typeof themeJson?.name === "string"
		? themeJson.name
		: compactLabel(basename(themePath));
}

function extensionLabel(item: ResourceItem): string {
	if (item.packageName && item.baseDir) {
		const rel = relative(item.baseDir, item.path).replace(/\\/g, "/");
		const withoutExt = compactLabel(rel);
		if (!withoutExt || withoutExt === "extensions/index") return item.packageName;
		if (withoutExt.startsWith("extensions/") && withoutExt.endsWith("/index")) {
			return `${item.packageName}:${withoutExt.slice("extensions/".length, -"/index".length)}`;
		}
		return `${item.packageName}:${withoutExt.replace(/^extensions\//, "")}`;
	}
	if (/^index\.(ts|js)$/.test(basename(item.path)))
		return basename(dirname(item.path));
	return compactLabel(basename(item.path));
}

function shortExtensionLabel(label: string): string {
	return label.split(":")[0] || label;
}

function getStartupResources(
	ctx: ExtensionContext,
	pi?: ExtensionAPI,
): StartupResources {
	const items = collectStartupResourceItems(ctx);

	const extensions = uniqueSorted(
		items.extensions.map(extensionLabel).map(shortExtensionLabel),
	);
	const skills = uniqueSorted(
		items.skills.map((item) => readSkillName(item.path)),
	);
	const themes = uniqueSorted(
		items.themes.map((item) => readThemeName(item.path)),
	);

	// pi already knows skill commands and registered themes; use them as a final safety net.
	try {
		for (const command of pi?.getCommands?.() ?? []) {
			if (command.source === "skill" && command.name.startsWith("skill:")) {
				skills.push(command.name.slice("skill:".length));
			}
		}
	} catch {
		/* ignore */
	}
	try {
		for (const themeInfo of ctx.ui.getAllThemes()) {
			if (
				themeInfo.path &&
				themeInfo.name !== "dark" &&
				themeInfo.name !== "light"
			) {
				themes.push(themeInfo.name);
			}
		}
	} catch {
		/* ignore */
	}

	return {
		extensions: uniqueSorted(extensions),
		skills: uniqueSorted(skills),
		themes: uniqueSorted(themes),
	};
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

const TRUECOLOR =
	/truecolor|24bit/i.test(process.env["COLORTERM"] ?? "") ||
	(process.env["TERM"] ?? "").includes("256color") ||
	["iTerm.app", "WezTerm", "vscode"].includes(
		process.env["TERM_PROGRAM"] ?? "",
	) ||
	process.env["WT_SESSION"] !== undefined;

const LOGO_SETTLE_FRAME = 90;
const CHAR_FADE_FRAMES = 22;
const LOGO_FRAME_MS = 16;
// Header container spacers (2) + above-editor stats widget (3) + editor (3) + footer (1).
const BANNER_RESERVED_ROWS = 9;

type AnimationStyle = "vertical-down";

function rgb(r: number, g: number, b: number, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function gray(value: number, text: string): string {
	return rgb(value, value, value, text);
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function computeRevealAt(
	_x: number,
	y: number,
	_rows: number,
	style: AnimationStyle = "vertical-down",
): number {
	switch (style) {
		case "vertical-down":
			return y * 5.5;
	}
}

function buildAnimatedArt(
	lines: string[],
	theme: Theme,
	frame = LOGO_SETTLE_FRAME,
): string[] {
	if (frame >= LOGO_SETTLE_FRAME) {
		return lines.map((row) =>
			Array.from(row)
				.map((ch) => (ch === " " ? " " : theme.fg("accent", ch)))
				.join(""),
		);
	}

	const rows = lines.length;
	return lines.map((row, y) => {
		let result = "";
		const chars = Array.from(row);
		for (let x = 0; x < chars.length; x++) {
			const ch = chars[x] ?? "";
			if (ch === " ") {
				result += " ";
				continue;
			}

			const revealAt = computeRevealAt(x, y, rows);
			const age = frame - revealAt;
			if (age <= 0) {
				result += " ";
				continue;
			}

			if (!TRUECOLOR) {
				result += theme.fg("accent", ch);
				continue;
			}

			const t = Math.min(1, age / CHAR_FADE_FRAMES);
			const eased = 1 - (1 - t) * (1 - t);
			const brightness = Math.floor(lerp(50, 255, eased));
			result += gray(brightness, ch);
		}
		return result;
	});
}

/* ──────────────────────────────────────────────────────────────────────────────
   Cards — left agent card + right resources card
   ────────────────────────────────────────────────────────────────────────────── */

type CardRow = { kind: "line"; text: string } | { kind: "separator" };

function wrapResourceList(
	items: string[],
	maxWidth = 52,
	cardWidth?: number,
): string[] {
	if (items.length === 0) return ["  —"];

	// Use cardWidth if provided, otherwise use maxWidth
	const effectiveMax = cardWidth ? Math.min(maxWidth, cardWidth - 4) : maxWidth;

	const lines: string[] = [];
	let current = "  ";
	for (const item of items) {
		const separator = current.trim().length === 0 ? "" : ", ";
		const candidate = current + separator + item;
		if (current.trim().length > 0 && visibleLen(candidate) > effectiveMax) {
			lines.push(current);
			current = `  ${item}`;
		} else {
			current = candidate;
		}
	}
	if (current.trim().length > 0) lines.push(current);
	return lines;
}

// 3 headings, 2 separators, 2 borders.
const RESOURCE_CARD_OVERHEAD = 7;

function appendResourceEllipsis(line: string, maxWidth: number): string {
	if (visibleLen(line) + 3 <= maxWidth) return `${line}, …`;
	return `${truncateToWidth(line, Math.max(1, maxWidth - 1))}…`;
}

function limitResourceLines(
	lines: string[],
	maxLines: number,
	maxWidth: number,
): string[] {
	if (lines.length <= maxLines) return lines;
	const visibleLines = lines.slice(0, Math.max(1, maxLines));
	const last = visibleLines.length - 1;
	visibleLines[last] = appendResourceEllipsis(visibleLines[last] ?? "  ", maxWidth);
	return visibleLines;
}

function distributeResourceLines(
	lists: string[][],
	maxLines: number,
): number[] {
	const budgets = lists.map(() => 1);
	let remaining = Math.max(0, maxLines - budgets.length);

	// Keep every section visible, then give spare rows to longest lists first.
	while (remaining > 0) {
		let best = -1;
		for (let i = 0; i < lists.length; i++) {
			if (budgets[i] >= lists[i].length) continue;
			if (
				best === -1 ||
				lists[i].length - budgets[i] >
					lists[best].length - budgets[best]
			) {
				best = i;
			}
		}
		if (best === -1) break;
		budgets[best]++;
		remaining--;
	}
	return budgets;
}

function buildBorderedCard(
	theme: Theme,
	titleRaw: string,
	rows: CardRow[],
	minContentWidth = 18,
): string[] {
	const val = (t: string, c: ThemeColor = "text") => theme.fg(c, t);
	const bdr = (t: string) => theme.fg("borderMuted", t);
	const innerLines = rows
		.filter((row): row is { kind: "line"; text: string } => row.kind === "line")
		.map((row) => row.text);
	const maxLen = Math.max(
		minContentWidth,
		titleRaw.length,
		...innerLines.map(visibleLen),
	);
	const innerW = maxLen + 2;

	const titleStyled = theme.bold(val(titleRaw, "accent"));
	const leftDashes = Math.max(0, Math.floor((innerW - titleRaw.length) / 2));
	const rightDashes = Math.max(0, innerW - titleRaw.length - leftDashes);

	const top =
		bdr("╭") +
		bdr("─".repeat(leftDashes)) +
		titleStyled +
		bdr("─".repeat(rightDashes)) +
		bdr("╮");
	const divider = bdr("├") + bdr("─".repeat(innerW)) + bdr("┤");
	const bottom = bdr("╰") + bdr("─".repeat(innerW)) + bdr("╯");

	const lines: string[] = [top];
	for (const row of rows) {
		if (row.kind === "separator") {
			lines.push(divider);
		} else {
			lines.push(
				bdr("│") + " " + padVisible(row.text, maxLen) + " " + bdr("│"),
			);
		}
	}
	lines.push(bottom);
	return lines;
}

function buildAgentCard(ctx: ExtensionContext, theme: Theme): string[] {
	const themeName = theme.name
		? theme.name
				.replace(/-/g, " ")
				.replace(/\b\w/g, (c: string) => c.toUpperCase())
		: "Default";
	const version = getPiVersion();
	const modelName = ctx.model?.name || ctx.model?.id || "—";

	const label = (t: string) => theme.fg("muted", t);
	const val = (t: string, c: ThemeColor = "text") => theme.fg(c, t);

	return buildBorderedCard(
		theme,
		" (pi) CODING AGENT ",
		[
			{ kind: "line", text: `${label("version ")}  ${val(version, "mdCode")}` },
			{
				kind: "line",
				text: `${label("model   ")}  ${val(modelName, "mdHeading")}`,
			},
			{ kind: "line", text: `${label("theme   ")}  ${val(themeName)}` },
		],
		25,
	);
}

function buildResourcesCard(
	theme: Theme,
	resources: StartupResources,
	terminalWidth?: number,
	maxRows?: number,
): string[] {
	const val = (t: string, c: ThemeColor = "text") => theme.fg(c, t);
	const section = (t: string) => theme.bold(val(`[${t}]`, "mdHeading"));
	const resourceWidth = terminalWidth
		? Math.max(1, Math.min(52, terminalWidth - 4))
		: 52;
	const wrappedLists = [
		wrapResourceList(resources.extensions, resourceWidth, terminalWidth),
		wrapResourceList(resources.skills, resourceWidth, terminalWidth),
		wrapResourceList(resources.themes, resourceWidth, terminalWidth),
	];
	const listBudgets = distributeResourceLines(
		wrappedLists,
		maxRows === undefined
			? Number.MAX_SAFE_INTEGER
			: Math.max(wrappedLists.length, maxRows - RESOURCE_CARD_OVERHEAD),
	);
	const lists = wrappedLists.map((lines, index) =>
		limitResourceLines(lines, listBudgets[index] ?? 1, resourceWidth),
	);

	return buildBorderedCard(
		theme,
		" RESOURCES ",
		[
			{ kind: "line", text: section("Extensions") },
			...(lists[0] ?? []).map((text) => ({
				kind: "line" as const,
				text: val(text, "syntaxFunction"),
			})),
			{ kind: "separator" },
			{ kind: "line", text: section("Skills") },
			...(lists[1] ?? []).map((text) => ({
				kind: "line" as const,
				text: val(text, "syntaxString"),
			})),
			{ kind: "separator" },
			{ kind: "line", text: section("Themes") },
			...(lists[2] ?? []).map((text) => ({
				kind: "line" as const,
				text: val(text, "text"),
			})),
		],
		30,
	);
}

/* ──────────────────────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────────────────────── */

const visibleLen = strWidth;

function padVisible(str: string, target: number): string {
	const vlen = visibleLen(str);
	return vlen >= target ? str : str + " ".repeat(target - vlen);
}

function maxVisibleWidth(lines: string[]): number {
	return Math.max(0, ...lines.map(visibleLen));
}

function centerVisible(str: string, target: number): string {
	const vlen = visibleLen(str);
	if (vlen >= target) return str;
	const left = Math.floor((target - vlen) / 2);
	const right = target - vlen - left;
	return " ".repeat(left) + str + " ".repeat(right);
}

function buildLeftColumn(logo: string[], agentCard: string[]): string[] {
	const colWidth = Math.max(maxVisibleWidth(logo), maxVisibleWidth(agentCard));
	return [
		...logo.map((line) => centerVisible(line, colWidth)),
		"".padEnd(colWidth, " "),
		...agentCard.map((line) => centerVisible(line, colWidth)),
	];
}

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

function renderColumns(
	left: string[],
	right: string[],
	width: number,
	gap = 4,
): string[] {
	const leftWidth = maxVisibleWidth(left);
	const rightWidth = maxVisibleWidth(right);
	const totalWidth = leftWidth + gap + rightWidth;

	if (width < totalWidth) {
		// Truncate each line to fit within terminal width
		const truncateLine = (line: string) => truncateToWidth(line, width);
		return ["", ...left.map(truncateLine), "", ...right.map(truncateLine), ""];
	}

	const leftPad = " ".repeat(Math.max(0, Math.floor((width - totalWidth) / 2)));
	const rows = Math.max(left.length, right.length);
	const out: string[] = [""];
	for (let i = 0; i < rows; i++) {
		const l = left[i] ?? "";
		const r = right[i] ?? "";
		out.push(leftPad + padVisible(l, leftWidth) + " ".repeat(gap) + r);
	}
	out.push("");
	return out;
}


/* ──────────────────────────────────────────────────────────────────────────────
   Main banner renderer
   ────────────────────────────────────────────────────────────────────────────── */

function renderFullscreen(lines: string[], width: number, height: number): string[] {
	const safeLines = lines.map((line) => truncateToWidth(line, width));
	if (height <= 0) return safeLines;
	if (safeLines.length >= height) return safeLines.slice(0, height);

	const remaining = height - safeLines.length;
	const topPad = Math.floor(remaining / 2);
	const bottomPad = remaining - topPad;
	return [
		...Array.from({ length: topPad }, () => ""),
		...safeLines,
		...Array.from({ length: bottomPad }, () => ""),
	];
}

/* ──────────────────────────────────────────────────────────────────────────────
   Animation state — stored on globalThis Symbol to survive /reload
   ────────────────────────────────────────────────────────────────────────────── */

const SYM_FRAME = Symbol.for("beautiful-pi:animFrame");
const SYM_INTERVAL = Symbol.for("beautiful-pi:animInterval");
const SYM_TUI = Symbol.for("beautiful-pi:animTui");
const g = globalThis as any;

function initFrame(): void {
	if (g[SYM_INTERVAL]) return;
	g[SYM_FRAME] = 0;
	g[SYM_INTERVAL] = setInterval(() => {
		g[SYM_FRAME]++;
		if (g[SYM_FRAME] >= LOGO_SETTLE_FRAME) {
			clearInterval(g[SYM_INTERVAL]);
			g[SYM_INTERVAL] = undefined;
		}
		if (g[SYM_TUI]) g[SYM_TUI].requestRender();
	}, LOGO_FRAME_MS);
}

function stopAnim(): void {
	if (g[SYM_INTERVAL]) {
		clearInterval(g[SYM_INTERVAL]);
		g[SYM_INTERVAL] = undefined;
	}
	g[SYM_TUI] = undefined;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Factory builders
   ────────────────────────────────────────────────────────────────────────────── */

function buildHeaderFactory(
	artLines: string[],
	resources: StartupResources,
	ctx: ExtensionContext,
) {
	return (tui: any, theme: Theme) => {
		g[SYM_TUI] = tui;
		return {
			invalidate() {},
			dispose() {},
			render(width: number): string[] {
				const logo = buildAnimatedArt(artLines, theme, g[SYM_FRAME] ?? LOGO_SETTLE_FRAME);
				const left = buildLeftColumn(logo, buildAgentCard(ctx, theme));
				const termRows = (tui as any).terminal?.rows ?? left.length + 2;
				const availableRows = Math.max(0, termRows - BANNER_RESERVED_ROWS);
				const right = buildResourcesCard(
					theme,
					resources,
					width,
					Math.max(0, availableRows - 2),
				);
				const content = renderColumns(left, right, width);
				return renderFullscreen(content, width, availableRows);
			},
		};
	};
}

/* ──────────────────────────────────────────────────────────────────────────────
   showBanner — fullscreen via setHeader (Archimedes pattern)
   ────────────────────────────────────────────────────────────────────────────── */

export function showBanner(ctx: ExtensionContext, pi?: ExtensionAPI) {
	if (!ctx.hasUI) return;

	const customArt = loadArt();
	const artLines = customArt !== DEFAULT_ART
		? (() => {
				const split = customArt.split("\n");
				const i = split.findIndex((l: string) => l.trim() !== "");
				return i >= 0 ? split.slice(i) : split;
			})()
		: PI_RAW;
	const resources = getStartupResources(ctx, pi);

	initFrame();

	const headerFactory = buildHeaderFactory(artLines, resources, ctx);

	// Immediate set + persistent retry to survive reload resetExtensionUI.
	ctx.ui.setHeader(headerFactory);
	const RETRY_MS = 400;
	const RETRY_DURATION = 4000;
	const retryId = setInterval(() => ctx.ui.setHeader(headerFactory), RETRY_MS);
	setTimeout(() => clearInterval(retryId), RETRY_DURATION);
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
		if (loadSettings().showBanner) showBanner(ctx, pi);
	});

	pi.on("input", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setHeader(undefined);
		}
		bannerCtx = ctx;
		bannerVisible = false;
		stopAnim();
	});

	pi.on("session_shutdown", async () => {
		stopAnim();
		bannerCtx = null;
		bannerVisible = false;
	});
}
