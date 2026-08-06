/**
 * Shared fixtures for driving the real compaction engines through pi's
 * `session_before_compact` runner semantics. Used by:
 *   - extensions/compaction/compaction.test.ts (unit suite)
 *   - scripts/smoke/compaction-check.mts (release smoke, imports this file
 *     from the installed package tree)
 * Keeps the observable-behavior fixtures in one place so the two seams cannot
 * drift apart. No live provider calls: the Codex remote endpoint is stubbed
 * per test and the stub is restored by the caller.
 */

/** JWT with the chatgpt_account_id claim the Codex endpoint requires. */
export function codexToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  ).toString("base64url");
  return `h.${payload}.sig`;
}

export const CODEX_MODEL = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.5",
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const NON_CODEX_MODEL = { provider: "anthropic", api: "completions", id: "claude" };

export function message(id: string, role: string, content = "x"): unknown {
  return { id, type: "message", message: { role, content } };
}

export function branchWith(n: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    out.push(message(`m${i}`, i % 2 === 0 ? "user" : "assistant", `content ${i}`));
  }
  return out;
}

export function makeCtx(model: unknown, branch: unknown[]): Record<string, unknown> {
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

export function makeEvent(branch: unknown[]): Record<string, unknown> {
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

export function stubCodexCompactionSuccess(): void {
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

export function stubCodexCompactionFailure(): void {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => "bad",
  })) as unknown as typeof fetch;
}
