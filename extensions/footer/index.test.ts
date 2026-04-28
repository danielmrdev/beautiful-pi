/**
 * Footer extension tests — verifies showFooter setting is respected.
 *
 * Each scenario runs in a child jiti process (temp script file) to ensure
 * fresh module loading, since jiti has its own module cache.
 *
 * Run with:
 *   ~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/.bin/jiti extensions/footer/index.test.ts
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

// Temp scripts must live inside the project tree so @mariozechner/pi-coding-agent resolves
const SCRIPT_DIR = __dirname; // extensions/footer/
const FOOTER_PATH = join(__dirname, "index.ts");

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
 * Returns { widgetCount, footerCount } from the session_start handler.
 */
function runScenario(homeDir: string, events: string[]): { widgetCount: number; footerCount: number } {
  const scriptPath = join(SCRIPT_DIR, `__scenario-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);

  const script = `
process.env.HOME = ${JSON.stringify(homeDir)};

// Pre-populate require.cache so BorderlessTopEditor can extend CustomEditor
// (CustomEditor is not exported from the package in test context)
const piPath = require.resolve("@mariozechner/pi-coding-agent");
require.cache[piPath] = {
  id: piPath, filename: piPath, loaded: true,
  exports: { CustomEditor: class { render(w: number) { return []; } } },
  parent: null, children: [], paths: [],
};

const { default: footerDefault } = require(${JSON.stringify(FOOTER_PATH)});

let widgetCount = 0;
let footerCount = 0;

const ctx = {
  hasUI: true,
  cwd: "/tmp",
  model: { name: "test-model", id: "test-model" },
  sessionManager: { getEntries: () => [] },
  getContextUsage: () => null,
  ui: {
    setWidget: () => { widgetCount++; },
    setFooter: () => { footerCount++; },
    setEditorComponent: () => {},
  },
};

const handlers: Record<string, Function[]> = {};
const mockPi = {
  on: (event: string, handler: Function) => {
    handlers[event] = handlers[event] || [];
    handlers[event].push(handler);
  },
  getThinkingLevel: () => null,
  exec: async () => ({ code: 128, stdout: "", stderr: "" }),
};
footerDefault(mockPi);

const events: string[] = ${JSON.stringify(events)};
for (const evt of events) {
  for (const h of (handlers[evt] || [])) {
    h({}, ctx);
  }
}
process.stdout.write(JSON.stringify({ widgetCount, footerCount }));
`;

  writeFileSync(scriptPath, script);

  try {
    const result = execSync(`${JITI} ${scriptPath}`, {
      encoding: "utf-8",
      env: { ...process.env, HOME: homeDir },
    });
    return JSON.parse(result.trim());
  } finally {
    try { rmSync(scriptPath); } catch {}
  }
}

// ── Setup temp directories ────────────────────────────────────────────────────

const tempHomeDefault = join(tmpdir(), `bp-footer-default-${Date.now()}`);
const tempHomeFalse = join(tmpdir(), `bp-footer-false-${Date.now()}`);

// Default: no settings file → showFooter defaults to true
mkdirSync(join(tempHomeDefault, ".pi", "agent"), { recursive: true });

// False: settings file explicitly sets showFooter: false
mkdirSync(join(tempHomeFalse, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(tempHomeFalse, ".pi", "agent", "beautiful-pi.json"),
  JSON.stringify({ showFooter: false }),
);

// ── Tests ─────────────────────────────────────────────────────────────────────

test("session_start registers widgets when showFooter is true (default settings)", () => {
  const { widgetCount, footerCount } = runScenario(tempHomeDefault, ["session_start"]);
  if (widgetCount === 0) throw new Error(`setWidget should be called when showFooter is true, widgetCount=${widgetCount}`);
  if (footerCount === 0) throw new Error(`setFooter should be called when showFooter is true, footerCount=${footerCount}`);
});

test("session_start does NOT register widgets when showFooter is false", () => {
  const { widgetCount, footerCount } = runScenario(tempHomeFalse, ["session_start"]);
  if (widgetCount !== 0) throw new Error(`setWidget should NOT be called when showFooter is false, widgetCount=${widgetCount}`);
  if (footerCount !== 0) throw new Error(`setFooter should NOT be called when showFooter is false, footerCount=${footerCount}`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

try { rmSync(tempHomeDefault, { recursive: true, force: true }); } catch {}
try { rmSync(tempHomeFalse, { recursive: true, force: true }); } catch {}

if (!process.exitCode) {
  console.log("\nAll tests passed.");
} else {
  console.log("\nSome tests failed.");
}
