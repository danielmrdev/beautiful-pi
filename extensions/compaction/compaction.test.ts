/**
 * Compaction engine coordination tests (provider-aware engine selection).
 *
 * Drives the REAL pi-codex-compaction and pi-blackhole extensions through
 * pi's `session_before_compact` runner semantics (last-writer-wins with a
 * cancel short-circuit, replicated by fakePi's emitWithResult — see the
 * documented divergence there) and asserts the provider-aware selection:
 *   - OpenAI Codex models → native Codex compaction, blackhole steps aside
 *   - non-Codex models → blackhole compaction (+ observational-memory content)
 *   - exactly one engine acts per turn, regardless of registration order
 *   - blackhole's cancel never blocks Codex native compaction
 *   - Codex native failure → compaction cancelled, blackhole does not take over
 *   - coordinator degrades loudly (warning) when the one-engine guarantee
 *     cannot hold (config write failure, env/project override shadowing, missing
 *     capability) and never touches the separate Codex config
 * No live provider calls: the Codex remote endpoint is stubbed per test and
 * the stub is restored afterwards.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { pathToFileURL } = require("node:url");
import { fakePi, type FakePi } from "../test-helpers.ts";
import {
  NATIVE_COMPACTION_KIND,
  isOpenAICodexModel,
} from "@ogulcancelik/pi-codex-compaction/native-compaction.ts";
import compactionCoordinator, {
  ensureBlackholeSkipConfig,
  blackholeConfigPath,
  blackholeHasProviderSkip,
  coordinationWarnings,
  projectSkipForProviders,
  CODEX_COMPACTION_PROVIDERS,
} from "./coordinator.ts";
import {
  CODEX_MODEL,
  NON_CODEX_MODEL,
  branchWith,
  makeCtx,
  makeEvent,
  stubCodexCompactionSuccess,
  stubCodexCompactionFailure,
} from "./fixtures.ts";

interface CompactResult {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    details?: Record<string, unknown> & {
      compactor?: string;
      kind?: string;
      "om.folded"?: unknown;
    };
  };
}

let tmpHome: string;
let origHome: string | undefined;
let origAgentDir: string | undefined;
let origEnvSkip: string | undefined;
let origFetch: typeof fetch;

beforeEach(() => {
  origHome = process.env.HOME;
  origAgentDir = process.env.PI_CODING_AGENT_DIR;
  origEnvSkip = process.env.PI_BLACKHOLE_SKIP_PROVIDERS;
  origFetch = globalThis.fetch;
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-compaction-"));
  process.env.HOME = tmpHome;
  // pi-blackhole memoizes getAgentDir per PI_CODING_AGENT_DIR; a fresh value
  // per test forces it to resolve the new tmp dir (HOME alone is not enough).
  process.env.PI_CODING_AGENT_DIR = join(tmpHome, ".pi", "agent");
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = origAgentDir;
  if (origEnvSkip === undefined) delete process.env.PI_BLACKHOLE_SKIP_PROVIDERS;
  else process.env.PI_BLACKHOLE_SKIP_PROVIDERS = origEnvSkip;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Wire both engines in the given order (no side effects). */
async function wireEngines(order: "codex-first" | "blackhole-first"): Promise<FakePi> {
  // The Codex package only ships TypeScript source. Load it dynamically so
  // tsc does not typecheck an upstream 0.1.5 headers mismatch as part of our
  // project; the real package loader also executes this source at runtime.
  const { default: codexCompactionExtension } = await import(
    pathToFileURL(require.resolve("@ogulcancelik/pi-codex-compaction/index.ts")).href,
  );
  // Use Blackhole's published bundle here. Its package also ships source
  // files, but those target a different pi-tui type identity when typechecked
  // from this project.
  const { default: blackholeExtension } = await import(
    pathToFileURL(require.resolve("pi-blackhole/dist/index.js")).href,
  );
  const pi = fakePi();
  (pi as any).getAllTools = () => [];
  (pi as any).getActiveTools = () => [];
  if (order === "codex-first") {
    codexCompactionExtension(pi);
    await blackholeExtension(pi);
  } else {
    await blackholeExtension(pi);
    codexCompactionExtension(pi);
  }
  return pi;
}

async function compactOnce(
  pi: FakePi,
  model: unknown,
  branch: unknown[],
): Promise<CompactResult | undefined> {
  return (await pi.events.emitWithResult(
    "session_before_compact",
    makeEvent(branch),
    makeCtx(model, branch),
  )) as CompactResult | undefined;
}

describe("/codex compaction coordination", () => {
  test("coordinator writes blackhole skipForProviders (idempotent, preserves unknown keys)", () => {
    const first = ensureBlackholeSkipConfig();
    assert.equal(first.changed, true);
    const cfg = JSON.parse(readFileSync(blackholeConfigPath(), "utf8"));
    assert.deepEqual(cfg.skipForProviders, CODEX_COMPACTION_PROVIDERS);
    const second = ensureBlackholeSkipConfig();
    assert.equal(second.changed, false);
    writeFileSync(
      blackholeConfigPath(),
      JSON.stringify({ ...cfg, memory: false }),
    );
    ensureBlackholeSkipConfig();
    const merged = JSON.parse(readFileSync(blackholeConfigPath(), "utf8"));
    assert.equal(merged.memory, false);
    assert.deepEqual(merged.skipForProviders, ["openai-codex"]);
  });

  test("coordinator provider list matches codex-compaction's model guard", () => {
    for (const provider of CODEX_COMPACTION_PROVIDERS) {
      assert.equal(
        isOpenAICodexModel({ provider, api: "openai-codex-responses", id: "x" }),
        true,
        `${provider} must be recognized by codex-compaction`,
      );
    }
    assert.equal(isOpenAICodexModel({ provider: "anthropic", api: "completions" }), false);
  });

  test("blackholeHasProviderSkip probes the installed capability", () => {
    const pkgDir = join(tmpHome, "bh");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "dist", "index.js"), "var x; /* before_compact.provider_skipped */");
    assert.equal(blackholeHasProviderSkip(pkgDir), true);
    writeFileSync(join(pkgDir, "dist", "index.js"), "var x;");
    assert.equal(blackholeHasProviderSkip(pkgDir), false);
    assert.equal(blackholeHasProviderSkip(join(tmpHome, "missing")), false);
  });

  test("Codex model → native Codex compaction; blackhole steps aside", async () => {
    stubCodexCompactionSuccess();
    ensureBlackholeSkipConfig();
    const pi = await wireEngines("codex-first");
    const branch = branchWith(8);
    const result = await compactOnce(pi, CODEX_MODEL, branch);
    assert.ok(result?.compaction, "an engine produced a compaction");
    assert.equal(
      result.compaction.details?.kind,
      NATIVE_COMPACTION_KIND,
      "native Codex compaction details win",
    );
    assert.equal(
      result.compaction.details?.["om.folded"],
      undefined,
      "blackhole ran no observational-memory content on a Codex session",
    );
    // The separate Codex compaction config is never created or touched.
    assert.equal(
      existsSync(join(process.env.PI_CODING_AGENT_DIR!, "pi-codex-compaction.json")),
      false,
      "Codex compaction config stays separate and untouched",
    );
  });

  test("registration order does not change the Codex selection", async () => {
    stubCodexCompactionSuccess();
    ensureBlackholeSkipConfig();
    for (const order of ["codex-first", "blackhole-first"] as const) {
      const pi = await wireEngines(order);
      const branch = branchWith(8);
      const result = await compactOnce(pi, CODEX_MODEL, branch);
      assert.equal(
        result?.compaction?.details?.kind,
        NATIVE_COMPACTION_KIND,
        `codex wins with ${order}`,
      );
    }
  });

  test("blackhole's cancel path never blocks Codex native compaction", async () => {
    stubCodexCompactionSuccess();
    ensureBlackholeSkipConfig();
    const pi = await wireEngines("blackhole-first");
    // Few live messages: without the provider guard, blackhole would return
    // {cancel:true} and short-circuit the runner before codex-compaction.
    const branch = branchWith(2);
    const result = await compactOnce(pi, CODEX_MODEL, branch);
    assert.equal(result?.cancel, undefined, "not cancelled by blackhole");
    assert.equal(
      result?.compaction?.details?.kind,
      NATIVE_COMPACTION_KIND,
      "codex native compaction proceeded",
    );
  });

  test("non-Codex model → blackhole compaction with observational-memory content", async () => {
    ensureBlackholeSkipConfig();
    const pi = await wireEngines("codex-first");
    const branch = branchWith(8);
    const result = await compactOnce(pi, NON_CODEX_MODEL, branch);
    assert.ok(result?.compaction, "blackhole produced a compaction");
    assert.equal(result.compaction.details?.compactor, "blackhole");
    assert.ok(
      result.compaction.details?.["om.folded"] !== undefined,
      "blackhole's observational-memory pipeline ran and attached its details",
    );
    // blackhole ran its compaction on a non-Codex session: no native marker.
    assert.equal(result.compaction.details?.kind, undefined);
    assert.doesNotMatch(
      result.compaction.summary,
      /OpenAI Codex native compaction checkpoint/,
      "codex engine did not touch a non-Codex session",
    );
  });

  test("Codex native compaction failure → cancelled, blackhole does not take over", async () => {
    stubCodexCompactionFailure();
    ensureBlackholeSkipConfig();
    const pi = await wireEngines("codex-first");
    const branch = branchWith(8);
    const result = await compactOnce(pi, CODEX_MODEL, branch);
    assert.equal(result?.cancel, true, "compaction cancelled on native failure");
    assert.equal(result?.compaction, undefined, "blackhole did not take over a Codex session");
  });

  test("coordinator warns when the skipForProviders write fails", () => {
    const pi = fakePi();
    const notifies: Array<{ msg: string; level: string }> = [];
    compactionCoordinator(pi);
    const handler = (pi.events.get("session_start") ?? [])[0] as (e: unknown, c: unknown) => void;
    // Make the config dir read-only so the write throws.
    const cfgDir = join(process.env.PI_CODING_AGENT_DIR!, "pi-blackhole");
    mkdirSync(cfgDir, { recursive: true });
    chmodSync(cfgDir, 0o555);
    try {
      handler({}, { hasUI: true, ui: { notify: (m: string, l: string) => notifies.push({ msg: m, level: l }) } });
    } finally {
      chmodSync(cfgDir, 0o755);
    }
    assert.ok(
      notifies.some((n) => n.level === "warning" && n.msg.includes("could not write blackhole skipForProviders")),
      "write failure surfaces loudly",
    );
  });

  test("coordinationWarnings flags env/project shadowing and missing capability", () => {
    const envWarn = coordinationWarnings("anthropic", true);
    assert.ok(envWarn.some((w) => w.includes("PI_BLACKHOLE_SKIP_PROVIDERS")));
    const projectWarn = coordinationWarnings(undefined, true, ["anthropic"]);
    assert.ok(projectWarn.some((w) => w.includes("project pi-blackhole config")));
    assert.equal(coordinationWarnings(undefined, true, []).length, 1);
    const capWarn = coordinationWarnings(undefined, false);
    assert.ok(capWarn.some((w) => w.includes("lacks the provider-aware skipForProviders capability")));
    // env/project set with a compatible openai-codex entry + capability present → no warnings
    assert.equal(
      coordinationWarnings("anthropic,openai-codex:openai-codex-responses", true, [
        "openai-codex:openai-codex-responses",
      ]).length,
      0,
    );
    assert.equal(coordinationWarnings(",", true).length, 1);
    // all three problems → all warnings
    assert.equal(coordinationWarnings("anthropic", false, ["anthropic"]).length, 3);
  });

  test("projectSkipForProviders detects an effective project override", () => {
    const cwd = join(tmpHome, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-blackhole-config.json"),
      JSON.stringify({ skipForProviders: [" anthropic ", 42] }),
    );
    assert.deepEqual(projectSkipForProviders(cwd), ["anthropic"]);
    writeFileSync(
      join(cwd, ".pi", "pi-blackhole-config.json"),
      JSON.stringify({ skipForProviders: [] }),
    );
    assert.deepEqual(projectSkipForProviders(cwd), []);
    writeFileSync(
      join(cwd, ".pi", "pi-blackhole-config.json"),
      JSON.stringify({ skipForProviders: [42] }),
    );
    assert.deepEqual(projectSkipForProviders(cwd), []);
    writeFileSync(
      join(cwd, ".pi", "pi-blackhole-config.json"),
      JSON.stringify({ skipForProviders: ["openai-codex:openai-codex-responses"] }),
    );
    assert.deepEqual(projectSkipForProviders(cwd), ["openai-codex:openai-codex-responses"]);
    assert.equal(projectSkipForProviders(join(tmpHome, "missing")), undefined);
  });

  test("coordinator warns when PI_BLACKHOLE_SKIP_PROVIDERS shadows the guarantee", () => {
    process.env.PI_BLACKHOLE_SKIP_PROVIDERS = "anthropic";
    const pi = fakePi();
    const notifies: Array<{ msg: string; level: string }> = [];
    compactionCoordinator(pi);
    const handler = (pi.events.get("session_start") ?? [])[0] as (e: unknown, c: unknown) => void;
    handler({}, { hasUI: true, ui: { notify: (m: string, l: string) => notifies.push({ msg: m, level: l }) } });
    assert.ok(
      notifies.some((n) => n.level === "warning" && n.msg.includes("PI_BLACKHOLE_SKIP_PROVIDERS")),
      "env shadowing surfaces loudly",
    );
  });

  test("coordinator extension registers a session_start config guard", async () => {
    const pi = fakePi();
    const notifies: Array<{ msg: string; level: string }> = [];
    compactionCoordinator(pi);
    const handler = (pi.events.get("session_start") ?? [])[0] as (e: unknown, c: unknown) => void;
    assert.ok(handler, "session_start handler registered");
    handler({}, { hasUI: true, ui: { notify: (m: string) => notifies.push({ msg: m, level: "info" }) } });
    const cfg = JSON.parse(readFileSync(blackholeConfigPath(), "utf8"));
    assert.deepEqual(cfg.skipForProviders, ["openai-codex"]);
  });
});
