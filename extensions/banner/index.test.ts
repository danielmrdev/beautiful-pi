/**
 * Banner extension tests — verifies showBanner setting is respected.
 *
 * Each scenario runs in a child jiti process (temp script file) to ensure
 * fresh module loading, since jiti has its own module cache.
 *
 * Run with:
 *   ~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/.bin/jiti extensions/banner/index.test.ts
 */

const { writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir, homedir } = require("node:os");
const { execSync } = require("node:child_process");

// ── Helpers ──────────────────────────────────────────────────────────────────

const JITI = join(
  homedir(),
  ".npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/.bin/jiti",
);

const BANNER_PATH = join(__dirname, "index.ts");

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error("   ", (e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Runs a mini-scenario in a child jiti process.
 * Writes a temp .ts script, runs it, parses stdout as the setWidget call count.
 */
function runScenario(homeDir: string, events: string[]): number {
  const scriptPath = join(tmpdir(), `bp-banner-scenario-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);

  const script = `
process.env.HOME = ${JSON.stringify(homeDir)};
const { default: bannerDefault } = require(${JSON.stringify(BANNER_PATH)});

let callCount = 0;
const ctx = {
  hasUI: true,
  ui: { setWidget: () => { callCount++; } },
  model: { name: "test-model", id: "test-model" },
};

const handlers: Record<string, Function[]> = {};
const mockPi = {
  on: (event: string, handler: Function) => {
    handlers[event] = handlers[event] || [];
    handlers[event].push(handler);
  },
};
bannerDefault(mockPi);

const events: string[] = ${JSON.stringify(events)};
for (const evt of events) {
  for (const h of (handlers[evt] || [])) {
    h({}, ctx);
  }
}
process.stdout.write(String(callCount));
`;

  writeFileSync(scriptPath, script);

  try {
    const result = execSync(`${JITI} ${scriptPath}`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: homeDir },
    });
    return parseInt(result.trim(), 10) || 0;
  } finally {
    try { rmSync(scriptPath); } catch {}
  }
}

// ── Setup temp directories ────────────────────────────────────────────────────

const tempHomeDefault = join(tmpdir(), `bp-banner-default-${Date.now()}`);
const tempHomeFalse = join(tmpdir(), `bp-banner-false-${Date.now()}`);

// Default: no settings file → showBanner defaults to true
mkdirSync(join(tempHomeDefault, ".pi", "agent"), { recursive: true });

// False: settings file explicitly sets showBanner: false
mkdirSync(join(tempHomeFalse, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(tempHomeFalse, ".pi", "agent", "beautiful-pi.json"),
  JSON.stringify({ showBanner: false }),
);

// ── Tests ─────────────────────────────────────────────────────────────────────

test("session_start calls setWidget when showBanner is true (default settings)", () => {
  const count = runScenario(tempHomeDefault, ["session_start"]);
  if (count === 0) throw new Error(`setWidget should be called when showBanner is true, callCount=${count}`);
});

test("session_start does NOT call setWidget when showBanner is false", () => {
  const count = runScenario(tempHomeFalse, ["session_start"]);
  if (count !== 0) throw new Error(`setWidget should NOT be called when showBanner is false, callCount=${count}`);
});

test("session_switch calls setWidget when showBanner is true (default settings)", () => {
  const count = runScenario(tempHomeDefault, ["session_switch"]);
  if (count === 0) throw new Error(`setWidget should be called on session_switch when showBanner is true, callCount=${count}`);
});

test("session_switch does NOT call setWidget when showBanner is false", () => {
  const count = runScenario(tempHomeFalse, ["session_switch"]);
  if (count !== 0) throw new Error(`setWidget should NOT be called on session_switch when showBanner is false, callCount=${count}`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

try { rmSync(tempHomeDefault, { recursive: true, force: true }); } catch {}
try { rmSync(tempHomeFalse, { recursive: true, force: true }); } catch {}

if (!process.exitCode) {
  console.log("\nAll tests passed.");
} else {
  console.log("\nSome tests failed.");
}
