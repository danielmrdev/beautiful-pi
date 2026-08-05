/**
 * Compaction engine coordinator.
 *
 * beautiful-pi wires two compaction engines (see package.json "pi.extensions"):
 * `@ogulcancelik/pi-codex-compaction` (native OpenAI Codex remote compaction,
 * preserving opaque checkpoints) and `pi-blackhole` (local summarization +
 * observational memory). Both hook pi's `session_before_compact`, which
 * resolves last-writer-wins with a cancel short-circuit — so two engines
 * answering the same turn double-compact or block each other depending on
 * extension registration order.
 *
 * This coordinator makes engine selection provider-aware instead of
 * order-dependent: blackhole (provider-aware fork, issue #7) skips the
 * providers pi-codex-compaction owns, so Codex models get native Codex
 * compaction and every other model gets blackhole. The module keeps blackhole's
 * `skipForProviders` config in place and warns loudly when the coordination
 * could silently degrade (config write failure, env override shadowing, or an
 * installed pi-blackhole without the fork capability). The Codex side has its
 * own separate configuration (`~/.pi/agent/pi-codex-compaction.json`,
 * autoCompact + thresholdRatio) — never touched here.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("node:fs");
const { join, dirname } = require("node:path");

/** Providers owned by pi-codex-compaction; blackhole must never touch them. */
export const CODEX_COMPACTION_PROVIDERS = ["openai-codex"];

/** Debug-event marker emitted by the provider-aware blackhole fork. */
export const PROVIDER_SKIP_MARKER = "before_compact.provider_skipped";

/** blackhole's unified config path (mirrors pi-blackhole's configPath). */
export function blackholeConfigPath(): string {
  return join(getAgentDir(), "pi-blackhole", "pi-blackhole-config.json");
}

/**
 * Idempotent: appends the Codex providers to blackhole's `skipForProviders`.
 * Returns whether the file was written. Malformed/missing config starts from
 * scratch; unknown keys are preserved. Throws on write failure — the caller
 * decides how loudly to surface it.
 */
export function ensureBlackholeSkipConfig(): { changed: boolean; path: string } {
  const path = blackholeConfigPath();
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // missing or malformed → start from scratch
  }
  const list = Array.isArray(cfg.skipForProviders)
    ? (cfg.skipForProviders as unknown[])
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : [];
  const missing = CODEX_COMPACTION_PROVIDERS.filter((p) => !list.includes(p));
  if (missing.length === 0) return { changed: false, path };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...cfg, skipForProviders: [...list, ...missing] }, null, 2),
  );
  return { changed: true, path };
}

/**
 * True when the installed pi-blackhole carries the provider-aware skip
 * capability (issue #7 fork). Probes the package's built dist for the marker
 * the fork emits in its before-compact guard. `packageDir` is injectable for
 * tests; defaults to the resolved pi-blackhole package.
 */
export function blackholeHasProviderSkip(packageDir?: string): boolean {
  try {
    const pkg = packageDir ?? dirname(require.resolve("pi-blackhole/package.json"));
    const dist = join(pkg, "dist", "index.js");
    if (!existsSync(dist)) return false;
    return readFileSync(dist, "utf8").includes(PROVIDER_SKIP_MARKER);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Warnings when the one-engine-per-turn guarantee could silently degrade.
 * Pure — injectable for tests. Env override wins over the config file inside
 * blackhole's merge; a capability-less pi-blackhole cannot skip providers.
 */
export function coordinationWarnings(
  envSkip: string | undefined,
  hasCapability: boolean,
): string[] {
  const warnings: string[] = [];
  if (
    envSkip !== undefined &&
    !envSkip.split(",").map((s) => s.trim()).includes("openai-codex")
  ) {
    warnings.push(
      "Compaction: PI_BLACKHOLE_SKIP_PROVIDERS is set without openai-codex — add it to keep native Codex compaction single-engine",
    );
  }
  if (!hasCapability) {
    warnings.push(
      "Compaction: installed pi-blackhole lacks the provider-aware skipForProviders capability — pin the issue-#7 fork (see README) to avoid double compaction",
    );
  }
  return warnings;
}

export default function compactionCoordinator(pi: ExtensionAPI): void {
  // Both engines load as separate extensions via package.json "pi.extensions"
  // (codex-compaction first, blackhole second). This coordinator only keeps
  // blackhole's provider-aware skip in place so engine selection is
  // provider-driven rather than registration-order-driven, and warns once per
  // process if the coordination could silently degrade.
  let coordinationWarned = false;
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const problems: string[] = [];
    try {
      const { changed } = ensureBlackholeSkipConfig();
      if (changed && ctx.hasUI) {
        ctx.ui.notify(
          "Compaction: blackhole will skip OpenAI Codex sessions — native Codex compaction handles them",
          "info",
        );
      }
    } catch (error) {
      problems.push(
        `Compaction: could not write blackhole skipForProviders config (${errorMessage(error)}) — Codex sessions may double-compact`,
      );
    }
    problems.push(
      ...coordinationWarnings(
        process.env.PI_BLACKHOLE_SKIP_PROVIDERS,
        blackholeHasProviderSkip(),
      ),
    );
    if (problems.length > 0 && !coordinationWarned) {
      coordinationWarned = true;
      if (ctx.hasUI) ctx.ui.notify(problems.join(" "), "warning");
    }
  });
}
