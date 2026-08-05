/**
 * Runtime exercise of the provider-aware compaction skip hook (issue #13).
 *
 * Drives the REAL pi-blackhole fork and beautiful-pi's compaction coordinator
 * — both loaded from the freshly installed package tree — through pi's
 * `session_before_compact` runner semantics (last-writer-wins with a cancel
 * short-circuit) and asserts the provider-aware selection as observable
 * behavior:
 *   - OpenAI Codex model → blackhole's skip guard fires (no result)
 *   - non-Codex model → blackhole compacts (guard did not over-skip)
 *   - coordinator's session_start wiring writes the skip config at runtime
 *
 * No live provider calls: blackhole's summarizer is local and deterministic.
 * Seam note: the fake ExtensionAPI replicates pi's session-before runner
 * semantics (last-writer-wins + cancel short-circuit, same fixture the unit
 * suite uses in extensions/compaction/compaction.test.ts); the real-runtime
 * half — the coordinator writing the skip config inside a real pi boot — is
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

const blackholeDist = join(installedDir, "..", "pi-blackhole", "dist", "index.js");
const coordinatorPath = join(installedDir, "extensions", "compaction", "coordinator.ts");
const testHelpersPath = join(installedDir, "extensions", "test-helpers.ts");
for (const [label, p] of [["pi-blackhole dist", blackholeDist], ["compaction coordinator", coordinatorPath], ["fake ExtensionAPI", testHelpersPath]]) {
  if (!existsSync(p)) {
    console.error(`missing installed module (${label}): ${p}`);
    process.exit(2);
  }
}

const CODEX_MODEL = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NON_CODEX_MODEL = { provider: "anthropic", api: "completions", id: "claude" };

function message(id: string, role: string, content = "x"): unknown {
  return { id, type: "message", message: { role, content } };
}

function branchWith(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    out.push(message(`m${i}`, i % 2 === 0 ? "user" : "assistant", `content ${i}`));
  }
  return out;
}

function makeCtx(model: unknown, branch: unknown[]): Record<string, unknown> {
  return {
    mode: "print",
    cwd: "/tmp/proj",
    hasUI: false,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "x", headers: {} }),
      getAll: () => [],
      getProviderAuthStatus: () => ({ configured: true }),
      hasConfiguredAuth: () => true,
      registerProvider: () => {},
    },
    sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
    getSystemPrompt: () => "System prompt",
    abort: () => {},
  };
}

function makeEvent(branch: unknown[]): Record<string, unknown> {
  return {
    type: "session_before_compact",
    customInstructions: undefined,
    branchEntries: branch,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
      firstKeptEntryId: (branch[0] as { id: string }).id,
    },
    reason: "overflow",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

async function main(): Promise<number> {
  // Load the installed artifacts only after the caller set the agent dir env,
  // so both modules resolve the same clean config location. The fake
  // ExtensionAPI ships with the package (extensions/test-helpers.ts) and
  // replicates pi's runner semantics (last-wins + cancel short-circuit).
  const [{ default: blackholeExtension }, coordinator, { fakePi }] = await Promise.all([
    import(pathToFileURL(blackholeDist).href),
    import(pathToFileURL(coordinatorPath).href),
    import(pathToFileURL(testHelpersPath).href),
  ]);

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

  // 2. Wire the real pi-blackhole fork and drive real compact events.
  blackholeExtension(pi);

  const codexResult = await pi.events.emitWithResult(
    "session_before_compact",
    makeEvent(branchWith(2)),
    makeCtx(CODEX_MODEL, branchWith(2)),
  );
  assert.equal(
    codexResult,
    undefined,
    "blackhole must step aside for an openai-codex session (skip guard fired)",
  );
  console.log("✓ blackhole skip guard fired at runtime for openai-codex");

  const nonCodexResult = (await pi.events.emitWithResult(
    "session_before_compact",
    makeEvent(branchWith(8)),
    makeCtx(NON_CODEX_MODEL, branchWith(8)),
  )) as { compaction?: { details?: Record<string, unknown> } } | undefined;
  assert.ok(nonCodexResult?.compaction, "blackhole must compact a non-Codex session");
  assert.equal(
    (nonCodexResult.compaction.details as Record<string, unknown> | undefined)?.compactor,
    "blackhole",
    "non-Codex session is handled by blackhole",
  );
  console.log("✓ blackhole compacts at runtime for a non-Codex session");

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
