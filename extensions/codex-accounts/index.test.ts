/**
 * Wiring test: codex-accounts extension registers /codex and a session_start
 * handler through the full beautiful-pi entry point.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakePi } from "../test-helpers.ts";

describe("codex-accounts wiring", () => {
  test("registers /codex command and session_start handler", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "bpi-wire-test-"));
    process.env["HOME"] = tmpHome;
    try {
      const pi = fakePi();
      const mod = await import("../index.ts");
      mod.default(pi);

      assert.ok(pi.commands.has("codex"), "/codex command registered");
      const sessionStart = pi.events.get("session_start") ?? [];
      assert.ok(sessionStart.length >= 1, "session_start handler registered");
      const agentEnd = pi.events.get("agent_end") ?? [];
      assert.ok(agentEnd.length >= 1, "agent_end failover capture registered");
      const agentSettled = pi.events.get("agent_settled") ?? [];
      assert.ok(agentSettled.length >= 1, "agent_settled failover handler registered");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("codex-accounts module alone registers the command", async () => {
    const pi = fakePi();
    const mod = await import("./index.ts");
    mod.default(pi);
    assert.ok(pi.commands.has("codex"));
  });
});
