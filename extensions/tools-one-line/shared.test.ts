/**
 * TDD tests for tools-one-line changes:
 * - renderLine uses configurable indentLevel from settings
 * - renderLine uses toolRailColor from settings for in-progress rail
 * - toolsOneLineExtension skips registration when toolsOneLine: false
 */

import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// ── Test helper ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error("   ", (e as Error).message);
    failed++;
  }
}

// ── Settings environment helpers ──────────────────────────────────────────────

const tempHome = path.join(os.tmpdir(), `bp-tools-test-${Date.now()}`);
const settingsDir = path.join(tempHome, ".pi", "agent");
const settingsFile = path.join(settingsDir, "beautiful-pi.json");
fs.mkdirSync(settingsDir, { recursive: true });

const origHome = process.env["HOME"];

function writeSettings(data: Record<string, unknown>): void {
  fs.writeFileSync(settingsFile, JSON.stringify(data));
}

function clearModuleCache(): void {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes("tools-one-line") ||
      key.includes("beautiful-pi") ||
      key.includes("shared/settings") ||
      key.includes("shared\\settings")
    ) {
      delete require.cache[key];
    }
  }
}

function loadShared(home: string): {
  renderLine: (ctx: any, theme: any, label: string, intent?: string) => any;
  setAgentActive: (v: boolean) => void;
  OneLine: new () => any;
} {
  process.env["HOME"] = home;
  clearModuleCache();
  return require("./shared.ts");
}

function makeInProgressCtx(comp: any): any {
  return {
    isPartial: true,
    isError: false,
    expanded: false,
    argsComplete: false,
    executionStarted: false,
    state: {},
    invalidate: () => {},
    args: {},
    cwd: process.cwd(),
    lastComponent: comp,
  };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── Test 1: renderLine uses indentLevel from settings ─────────────────────────

test("renderLine uses indentLevel:2 from settings instead of hardcoded 4", () => {
  writeSettings({ indentLevel: 2 });
  const shared = loadShared(tempHome);
  shared.setAgentActive(true);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  const comp = new shared.OneLine();
  const result = shared.renderLine(makeInProgressCtx(comp), theme, "my-label");
  const lines = result.render(200) as string[];
  const mainLine = stripAnsi(lines[lines.length - 1]!);
  result.stopTimer(); // prevent process hang from spinner interval

  // With indentLevel: 2, line should start with exactly 2 spaces (not 4)
  assert.ok(
    mainLine.startsWith("  "),
    `Expected 2-space indent, got: ${JSON.stringify(mainLine)}`
  );
  assert.ok(
    !mainLine.startsWith("   "),
    `Expected exactly 2-space indent (not 3+), got: ${JSON.stringify(mainLine)}`
  );
});

// ── Test 2: renderLine uses toolRailColor for in-progress rail ────────────────

test("renderLine uses toolRailColor:'accent' from settings for in-progress rail", () => {
  writeSettings({ toolRailColor: "accent", indentLevel: 4 });
  const shared = loadShared(tempHome);
  shared.setAgentActive(true);

  const railColors: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      if (text === "┃") railColors.push(color);
      return text;
    },
    bold: (text: string) => text,
  };

  const comp = new shared.OneLine();
  const result = shared.renderLine(makeInProgressCtx(comp), theme, "my-label");
  result.stopTimer();

  assert.strictEqual(
    railColors.length,
    1,
    `Expected exactly one rail (┃) call, got ${railColors.length}`
  );
  assert.strictEqual(
    railColors[0],
    "accent",
    `Rail should use toolRailColor "accent", got: ${railColors[0]}`
  );
});

// ── Test 3: default toolRailColor comes from settings defaults ────────────────

test("renderLine uses settings default toolRailColor:'success' when not overridden", () => {
  writeSettings({}); // empty → use defaults; default toolRailColor is "success"
  const shared = loadShared(tempHome);
  shared.setAgentActive(true);

  const railColors: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      if (text === "┃") railColors.push(color);
      return text;
    },
    bold: (text: string) => text,
  };

  const comp = new shared.OneLine();
  const result = shared.renderLine(makeInProgressCtx(comp), theme, "my-label");
  result.stopTimer();

  assert.strictEqual(railColors.length, 1, "Should have exactly one rail color call");
  assert.strictEqual(
    railColors[0],
    "success",
    `Default rail should use settings default "success", got: ${railColors[0]}`
  );
});

// ── Test 4: toolsOneLineExtension skips registration when toolsOneLine: false ─

test("toolsOneLineExtension skips all registrations when toolsOneLine is false", () => {
  writeSettings({ toolsOneLine: false });
  process.env["HOME"] = tempHome;
  clearModuleCache();

  const mod = require("./index.ts") as { default: (pi: any) => void };

  const onCalls: string[] = [];
  const registerCalls: string[] = [];

  const mockPi: any = {
    on: (event: string, _handler: any) => { onCalls.push(event); },
    registerTool: (def: any) => { registerCalls.push(def.name ?? "unknown"); },
  };

  mod.default(mockPi);

  assert.strictEqual(
    registerCalls.length,
    0,
    `No tools should be registered when toolsOneLine:false, got: [${registerCalls.join(", ")}]`
  );
  assert.strictEqual(
    onCalls.length,
    0,
    `No events should be subscribed when toolsOneLine:false, got: [${onCalls.join(", ")}]`
  );
});

// ── Test 5: toolsOneLineExtension subscribes to events when toolsOneLine: true ─
// Note: In the test environment, tool registration may throw because
// createBashToolDefinition etc. require the full pi runtime. We wrap the call
// in try/catch and verify that pi.on WAS called (guard did NOT fire early return).

test("toolsOneLineExtension subscribes to agent events when toolsOneLine is true", () => {
  writeSettings({ toolsOneLine: true });
  process.env["HOME"] = tempHome;
  clearModuleCache();

  const mod = require("./index.ts") as { default: (pi: any) => void };

  const onCalls: string[] = [];
  const mockPi: any = {
    on: (event: string, _handler: any) => { onCalls.push(event); },
    registerTool: (_def: any) => {},
  };

  // Tool registration may throw in test env (missing pi runtime deps);
  // we only assert on events subscribed BEFORE registration.
  try { mod.default(mockPi); } catch { /* expected in test env */ }

  assert.ok(
    onCalls.includes("agent_start"),
    `Should subscribe to agent_start (guard must not fire), got: [${onCalls.join(", ")}]`
  );
  assert.ok(
    onCalls.includes("agent_end"),
    `Should subscribe to agent_end (guard must not fire), got: [${onCalls.join(", ")}]`
  );
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

process.env["HOME"] = origHome;
try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}

// ── Summary and exit ──────────────────────────────────────────────────────────

if (failed === 0) {
  console.log(`\nAll ${passed} tests passed.`);
  process.exit(0);
} else {
  console.log(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
}
