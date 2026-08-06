/**
 * Runtime exercise of the provider-aware compaction coordination (issue #13).
 *
 * Drives the REAL compaction engines — pi-codex-compaction and the
 * pi-blackhole fork — plus beautiful-pi's compaction coordinator, all loaded
 * from the freshly installed package tree, through pi's
 * `session_before_compact` runner semantics (last-writer-wins with a cancel
 * short-circuit) and asserts the observable provider-aware selection:
 *   - OpenAI Codex model → native Codex compaction wins, blackhole steps
 *     aside (its provider-skip guard fires — if it did not, blackhole's own
 *     compaction would replace the native result via last-wins)
 *   - non-Codex model → blackhole compacts (guard did not over-skip)
 *   - coordinator's session_start wiring writes the skip config at runtime
 *
 * No live provider calls: the Codex remote endpoint is stubbed (shared
 * fixtures in extensions/compaction/fixtures.ts) and blackhole's summarizer
 * is local. Seam note: the fake ExtensionAPI replicates pi's session-before
 * runner semantics (same fixture the unit suite uses); the real-runtime half
 * — the coordinator writing the skip config inside a real pi boot — is
 * verified by scripts/smoke.mjs step 5.
 *
 * Usage (by scripts/smoke.mjs):
 *   node --import=tsx compaction-check.mts <installed-beautiful-pi-dir> <agentDir>
 *
 * The caller must set HOME and PI_CODING_AGENT_DIR before spawning so pi's
 * agent-dir resolution points at the clean temp installation.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// tsx transpiles the CJS-typed coordinator.ts to require() calls; its
// `@earendil-works/pi-coding-agent` import then fails on the package's
// ESM-only exports map. Same patch the unit suite uses (test/setup.mjs).
import "../../test/setup.mjs";

const [installedDir, agentDir] = process.argv.slice(2);
if (!installedDir || !agentDir) {
  console.error("usage: compaction-check.mts <installed-beautiful-pi-dir> <agentDir>");
  process.exit(2);
}

/**
 * Resolve a sibling dependency. Installed layout: npmDir/node_modules/
 * beautiful-pi with siblings in npmDir/node_modules. Dev layout: the repo
 * itself (installedDir = repo root) with siblings in installedDir/node_modules.
 */
function resolveSibling(name: string, subpath: string): string {
  const sibling = join(installedDir, "..", name, subpath);
  if (existsSync(sibling)) return sibling;
  return join(installedDir, "node_modules", name, subpath);
}

const blackholeDist = resolveSibling("pi-blackhole", "dist/index.js");
const coordinatorPath = join(installedDir, "extensions", "compaction", "coordinator.ts");
const testHelpersPath = join(installedDir, "extensions", "test-helpers.ts");
const fixturesPath = join(installedDir, "extensions", "compaction", "fixtures.ts");
const codexIndexPath = resolveSibling("@ogulcancelik/pi-codex-compaction", "index.ts");
const nativeCompactionPath = resolveSibling("@ogulcancelik/pi-codex-compaction", "native-compaction.ts");
const requiredModules = [
  ["pi-blackhole dist", blackholeDist],
  ["compaction coordinator", coordinatorPath],
  ["fake ExtensionAPI", testHelpersPath],
  ["compaction fixtures", fixturesPath],
  ["pi-codex-compaction", codexIndexPath],
  ["pi-codex-compaction native module", nativeCompactionPath],
];
for (const [label, p] of requiredModules) {
  if (!existsSync(p)) {
    console.error(`missing installed module (${label}): ${p}`);
    process.exit(2);
  }
}

interface CompactResult {
  compaction?: {
    details?: {
      compactor?: string;
      kind?: string;
      "om.folded"?: unknown;
    };
  };
}

async function main(): Promise<number> {
  // Load the installed artifacts only after the caller set the agent dir env,
  // so both modules resolve the same clean config location.
  const [{ default: blackholeExtension }, coordinator, { fakePi }, fixtures, codexIndex, nativeCompaction] =
    await Promise.all([
      import(pathToFileURL(blackholeDist).href),
      import(pathToFileURL(coordinatorPath).href),
      import(pathToFileURL(testHelpersPath).href),
      import(pathToFileURL(fixturesPath).href),
      import(pathToFileURL(codexIndexPath).href),
      import(pathToFileURL(nativeCompactionPath).href),
    ]);
  const { default: codexCompactionExtension } = codexIndex as { default: (pi: unknown) => void };
  const { NATIVE_COMPACTION_KIND } = nativeCompaction as { NATIVE_COMPACTION_KIND: string };
  const {
    CODEX_MODEL,
    NON_CODEX_MODEL,
    branchWith,
    makeCtx,
    makeEvent,
    stubCodexCompactionSuccess,
  } = fixtures as {
    CODEX_MODEL: unknown;
    NON_CODEX_MODEL: unknown;
    branchWith: (n: number) => unknown[];
    makeCtx: (model: unknown, branch: unknown[]) => Record<string, unknown>;
    makeEvent: (branch: unknown[]) => Record<string, unknown>;
    stubCodexCompactionSuccess: () => void;
  };

  const pi = fakePi();
  coordinator.default(pi);

  // 1. Coordinator wiring: running its session_start handler must write the
  //    provider-aware skip config into the clean agent dir at runtime.
  const sessionStart = (pi.events.get("session_start") ?? [])[0] as
    | ((event: unknown, ctx: unknown) => void)
    | undefined;
  assert.ok(sessionStart, "coordinator registers a session_start handler");
  sessionStart({}, { hasUI: false });
  const cfgPath = join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
  assert.ok(existsSync(cfgPath), `skip config written at runtime: ${cfgPath}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { skipForProviders?: unknown[] };
  assert.deepEqual(cfg.skipForProviders, ["openai-codex"]);
  console.log("✓ coordinator session_start wrote skipForProviders at runtime");

  // 2. Wire BOTH engines exactly as pi loads them (codex first, blackhole
  //    second) and stub the Codex remote endpoint.
  const origFetch = globalThis.fetch;
  try {
    stubCodexCompactionSuccess();
    (pi as { getAllTools?: unknown }).getAllTools = () => [];
    (pi as { getActiveTools?: unknown }).getActiveTools = () => [];
    codexCompactionExtension(pi);
    blackholeExtension(pi);

    // Codex session → native Codex compaction; blackhole's provider-skip
    // guard must fire (otherwise blackhole's own compaction would replace
    // the native result via last-wins).
    const codexBranch = branchWith(8);
    const codexResult = (await pi.events.emitWithResult(
      "session_before_compact",
      makeEvent(codexBranch),
      makeCtx(CODEX_MODEL, codexBranch),
    )) as CompactResult | undefined;
    assert.ok(codexResult?.compaction, "an engine produced a compaction for the Codex session");
    assert.equal(
      codexResult.compaction.details?.kind,
      NATIVE_COMPACTION_KIND,
      "native Codex compaction wins for openai-codex",
    );
    assert.notEqual(
      codexResult.compaction.details?.compactor,
      "blackhole",
      "blackhole stepped aside (provider-skip guard fired at runtime)",
    );
    assert.equal(
      codexResult.compaction.details?.["om.folded"],
      undefined,
      "blackhole ran no observational-memory content on a Codex session",
    );
    console.log("✓ one-engine-per-turn at runtime: Codex session → native compaction, blackhole skips");

    // Non-Codex session → blackhole compacts (guard did not over-skip).
    const nonCodexBranch = branchWith(8);
    const nonCodexResult = (await pi.events.emitWithResult(
      "session_before_compact",
      makeEvent(nonCodexBranch),
      makeCtx(NON_CODEX_MODEL, nonCodexBranch),
    )) as CompactResult | undefined;
    assert.ok(nonCodexResult?.compaction, "blackhole must compact a non-Codex session");
    assert.equal(
      nonCodexResult.compaction.details?.compactor,
      "blackhole",
      "non-Codex session is handled by blackhole",
    );
    console.log("✓ one-engine-per-turn at runtime: non-Codex session → blackhole compacts");
  } finally {
    globalThis.fetch = origFetch;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
