/**
 * Compaction engine coordination tests (issue #7).
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
 *     cannot hold (config write failure, env override shadowing, missing
 *     fork capability) and never touches the separate Codex config
 * No live provider calls: the Codex remote endpoint is stubbed per test and
 * the stub is restored afterwards.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi, type FakePi } from "../test-helpers.ts";
import codexCompactionExtension from "@ogulcancelik/pi-codex-compaction/index.ts";
import {
  NATIVE_COMPACTION_KIND,
  isOpenAICodexModel,
} from "@ogulcancelik/pi-codex-compaction/native-compaction.ts";
import blackholeExtension from "pi-blackhole";
import compactionCoordinator, {
  ensureBlackholeSkipConfig,
  blackholeConfigPath,
  blackholeHasProviderSkip,
  coordinationWarnings,
  CODEX_COMPACTION_PROVIDERS,
} from "./coordinator.ts";

const CODEX_MODEL = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NON_CODEX_MODEL = { provider: "anthropic", api: "completions", id: "claude" };

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

/** JWT with the chatgpt_account_id claim the Codex endpoint requires. */
function codexToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  ).toString("base64url");
  return `h.${payload}.sig`;
}

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
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: codexToken(), headers: {} }),
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

function stubCodexCompactionSuccess(): void {
  globalThis.fetch = (async () => {
    const sse = [
      'data: {"type":"response.output_item.done","item":{"type":"compaction","id":"cmp-1","encrypted_content":"opaque-checkpoint"}}',
      "",
      'data: {"type":"response.completed","response":{"usage":{"output_tokens":12}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    return { ok: true, status: 200, body: stream } as unknown as Response;
  }) as unknown as typeof fetch;
}

function stubCodexCompactionFailure(): void {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => "bad",
  })) as unknown as typeof fetch;
}

/** Wire both engines in the given order (no side effects). */
function wireEngines(order: "codex-first" | "blackhole-first"): FakePi {
  const pi = fakePi();
  (pi as any).getAllTools = () => [];
  (pi as any).getActiveTools = () => [];
  if (order === "codex-first") {
    codexCompactionExtension(pi);
    blackholeExtension(pi);
  } else {
    blackholeExtension(pi);
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
    const pi = wireEngines("codex-first");
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
      const pi = wireEngines(order);
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
    const pi = wireEngines("blackhole-first");
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
    const pi = wireEngines("codex-first");
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
    const pi = wireEngines("codex-first");
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

  test("coordinationWarnings flags env shadowing and missing capability", () => {
    const envWarn = coordinationWarnings("anthropic", true);
    assert.ok(envWarn.some((w) => w.includes("PI_BLACKHOLE_SKIP_PROVIDERS")));
    const capWarn = coordinationWarnings(undefined, false);
    assert.ok(capWarn.some((w) => w.includes("lacks the provider-aware skipForProviders capability")));
    // env set with openai-codex + capability present → no warnings
    assert.equal(coordinationWarnings("anthropic,openai-codex", true).length, 0);
    // both problems → both warnings
    assert.equal(coordinationWarnings("anthropic", false).length, 2);
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
