import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let originalHome: string | undefined;
let testHome: string;

before(() => {
  originalHome = process.env["HOME"];
  testHome = mkdtempSync(join(tmpdir(), "beautiful-pi-footer-"));
  process.env["HOME"] = testHome;
});

after(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});

test("hides fetched provider quota when setting is switched off", async () => {
  const mod = await import("./index.ts");
  const { loadSettings, saveSettings } = await import("../shared/settings.ts");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let authCalls = 0;
  let sessionStart: ((event: any, ctx: any) => void) | undefined;
  let footer: { render(width: number): string[]; dispose?(): void } | undefined;

  const theme: any = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
  const tui = { requestRender() {} };
  const pi: any = {
    on(event: string, handler: (event: any, ctx: any) => void) {
      if (event === "session_start") sessionStart = handler;
    },
    registerShortcut() {},
    async exec() { return { code: 128, stdout: "", stderr: "" }; },
  };
  const ctx: any = {
    hasUI: true,
    cwd: "/tmp/bpi-quota-test",
    model: { provider: "openai-codex", id: "test-model" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        authCalls++;
        return { ok: true, apiKey: "fake-token" };
      },
    },
    sessionManager: { getEntries() { return [{ timestamp: Date.now() }]; } },
    getContextUsage() { return undefined; },
    ui: {
      setEditorComponent() {},
      setWidget() {},
      setFooter(factory: any) {
        footer?.dispose?.();
        footer = factory
          ? factory(tui, theme, { onBranchChange() { return () => {}; } })
          : undefined;
      },
    },
  };

  globalThis.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      async json() {
        return { rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 42, reset_after_seconds: 600 },
          secondary_window: { limit_window_seconds: 604_800, used_percent: 12, reset_after_seconds: 900 },
        } };
      },
    } as Response;
  };

  try {
    mod.default(pi);
    sessionStart!({ reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(footer!.render(120).join("\n"), /42%/);

    saveSettings({ ...loadSettings(), showQuotaUsage: false });

    assert.doesNotMatch(footer!.render(120).join("\n"), /42%/);
    assert.equal(fetchCalls, 1);
    assert.equal(authCalls, 1);
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});
