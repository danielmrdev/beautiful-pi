/**
 * Compaction engine coordination tests (issue #7).
 *
 * Drives the REAL pi-codex-compaction and pi-blackhole extensions through
 * pi's `session_before_compact` runner semantics (last-writer-wins with a
 * cancel short-circuit, replicated by fakePi's emitWithResult) and asserts
 * the provider-aware selection:
 *   - OpenAI Codex models → native Codex compaction, blackhole steps aside
 *   - non-Codex models → blackhole compaction
 *   - exactly one engine acts per turn, regardless of registration order
 *   - blackhole's cancel never blocks Codex native compaction
 *   - Codex native failure → compaction cancelled, blackhole does not take over
 * No live provider calls: the Codex remote endpoint is stubbed.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePi, type FakePi } from "../test-helpers.ts";
import codexCompactionExtension from "@ogulcancelik/pi-codex-compaction/index.ts";
import blackholeExtension from "pi-blackhole";
import compactionCoordinator, {
  ensureBlackholeSkipConfig,
  blackholeConfigPath,
  CODEX_COMPACTION_PROVIDERS,
} from "./coordinator.ts";

const CODEX_MODEL = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const NON_CODEX_MODEL = { provider: "anthropic", api: "completions", id: "claude" };

/** JWT with the chatgpt_account_id claim the Codex endpoint requires. */
function codexToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  ).toString("base64url");
  return `h.${payload}.sig`;
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "bpi-compaction-"));
  process.env.HOME = tmpHome;
  // pi-blackhole memoizes getAgentDir per PI_CODING_AGENT_DIR; a fresh value
  // per test forces it to resolve the new tmp dir (HOME alone is not enough).
  process.env.PI_CODING_AGENT_DIR = join(tmpHome, ".pi", "agent");
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

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

/** Wire both engines (order chosen by caller) + coordinator config. */
async function wire(order: "codex-first" | "blackhole-first"): Promise<FakePi> {
  ensureBlackholeSkipConfig();
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

describe("/codex compaction coordination", () => {
  test("coordinator writes blackhole skipForProviders (idempotent)", () => {
    const first = ensureBlackholeSkipConfig();
    assert.equal(first.changed, true);
    const cfg = JSON.parse(readFileSync(blackholeConfigPath(), "utf8"));
    assert.deepEqual(cfg.skipForProviders, CODEX_COMPACTION_PROVIDERS);
    const second = ensureBlackholeSkipConfig();
    assert.equal(second.changed, false);
    // unknown keys preserved
    writeFileSync(
      blackholeConfigPath(),
      JSON.stringify({ ...cfg, memory: false }),
    );
    ensureBlackholeSkipConfig();
    const merged = JSON.parse(readFileSync(blackholeConfigPath(), "utf8"));
    assert.equal(merged.memory, false);
    assert.deepEqual(merged.skipForProviders, ["openai-codex"]);
  });

  test("Codex model → native Codex compaction; blackhole steps aside", async () => {
    stubCodexCompactionSuccess();
    const pi = await wire("codex-first");
    const ctx = makeCtx(CODEX_MODEL, branchWith(8));
    const result = (await (pi.events as any).emitWithResult(
      "session_before_compact",
      makeEvent(branchWith(8)),
      ctx,
    )) as any;
    assert.ok(result?.compaction, "an engine produced a compaction");
    assert.match(
      result.compaction.summary,
      /OpenAI Codex native compaction checkpoint/,
      "Codex native marker wins",
    );
    assert.notEqual(result.compaction.details?.compactor, "blackhole", "blackhole did not compact");
  });

  test("registration order does not change the Codex selection", async () => {
    stubCodexCompactionSuccess();
    for (const order of ["codex-first", "blackhole-first"] as const) {
      const pi = await wire(order);
      const branch = branchWith(8);
      const result = (await (pi.events as any).emitWithResult(
        "session_before_compact",
        makeEvent(branch),
        makeCtx(CODEX_MODEL, branch),
      )) as any;
      assert.match(
        result?.compaction?.summary ?? "",
        /OpenAI Codex native compaction checkpoint/,
        `codex wins with ${order}`,
      );
    }
  });

  test("blackhole's cancel path never blocks Codex native compaction", async () => {
    stubCodexCompactionSuccess();
    const pi = await wire("blackhole-first");
    // Few live messages: without the provider guard, blackhole would return
    // {cancel:true} and short-circuit the runner before codex-compaction.
    const branch = branchWith(2);
    const result = (await (pi.events as any).emitWithResult(
      "session_before_compact",
      makeEvent(branch),
      makeCtx(CODEX_MODEL, branch),
    )) as any;
    assert.equal(result?.cancel, undefined, "not cancelled by blackhole");
    assert.match(
      result?.compaction?.summary ?? "",
      /OpenAI Codex native compaction checkpoint/,
      "codex native compaction proceeded",
    );
  });

  test("non-Codex model → blackhole compaction", async () => {
    const pi = await wire("codex-first");
    const branch = branchWith(8);
    const result = (await (pi.events as any).emitWithResult(
      "session_before_compact",
      makeEvent(branch),
      makeCtx(NON_CODEX_MODEL, branch),
    )) as any;
    assert.ok(result?.compaction, "blackhole produced a compaction");
    assert.equal(result.compaction.details?.compactor, "blackhole");
    assert.doesNotMatch(
      result.compaction.summary,
      /OpenAI Codex native compaction checkpoint/,
      "codex engine did not touch a non-Codex session",
    );
  });

  test("Codex native compaction failure → cancelled, blackhole does not take over", async () => {
    stubCodexCompactionFailure();
    const pi = await wire("codex-first");
    const branch = branchWith(8);
    const result = (await (pi.events as any).emitWithResult(
      "session_before_compact",
      makeEvent(branch),
      makeCtx(CODEX_MODEL, branch),
    )) as any;
    assert.equal(result?.cancel, true, "compaction cancelled on native failure");
    assert.equal(result?.compaction, undefined, "blackhole did not take over a Codex session");
  });

  test("coordinator extension registers a session_start config guard", async () => {
    const pi = fakePi();
    const notifies: string[] = [];
    compactionCoordinator(pi);
    const handler = (pi.events.get("session_start") ?? [])[0] as (e: unknown, c: unknown) => void;
    assert.ok(handler, "session_start handler registered");
    handler({}, { hasUI: true, ui: { notify: (m: string) => notifies.push(m) } });
    const cfg = JSON.parse(readFileSync(blackholeConfigPath(), "utf8"));
    assert.deepEqual(cfg.skipForProviders, ["openai-codex"]);
  });
});
