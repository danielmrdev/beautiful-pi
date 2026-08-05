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
 * compaction and every other model gets blackhole. The module only keeps
 * blackhole's `skipForProviders` config in place — the model guards on each
 * engine do the rest. The Codex side has its own separate configuration
 * (`~/.pi/agent/pi-codex-compaction.json`, autoCompact + thresholdRatio).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

/** Providers owned by pi-codex-compaction; blackhole must never touch them. */
export const CODEX_COMPACTION_PROVIDERS = ["openai-codex"];

/** blackhole's unified config path (mirrors pi-blackhole's configPath). */
export function blackholeConfigPath(): string {
  return join(getAgentDir(), "pi-blackhole", "pi-blackhole-config.json");
}

/**
 * Idempotent: appends the Codex providers to blackhole's `skipForProviders`.
 * Returns whether the file was written. Malformed/missing config starts from
 * scratch; unknown keys are preserved.
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

export default function compactionCoordinator(pi: ExtensionAPI): void {
  // Both engines load as separate extensions via package.json "pi.extensions"
  // (codex-compaction first, blackhole second). This coordinator only keeps
  // blackhole's provider-aware skip in place so engine selection is
  // provider-driven rather than registration-order-driven.
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    try {
      const { changed } = ensureBlackholeSkipConfig();
      if (changed && ctx.hasUI) {
        ctx.ui.notify(
          "Compaction: blackhole will skip OpenAI Codex sessions — native Codex compaction handles them",
          "info",
        );
      }
    } catch {
      // Best-effort: a broken config write must never break session start.
    }
  });
}
