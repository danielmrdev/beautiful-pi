import * as assert from "node:assert";
import * as path from "node:path";

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

// ── Mock settings module ────────────────────────────────────────────────────

const mockSettings = {
  userRailColor: "customColor",
};

const mockTheme = {
  fg: (token: string, text: string) => `[${token}]${text}`,
};

const settingsPath = path.resolve(__dirname, "../shared/settings.ts");
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    loadSettings: () => mockSettings,
    safeFg: (theme: any, token: string | undefined, fallback: string, text: string) => {
      if (!theme || typeof theme.fg !== "function") return text;
      return theme.fg(token ?? fallback, text);
    },
  },
  require: require,
  children: [],
  parent: module,
} as any;

// ── Require module under test ───────────────────────────────────────────────

const indexPath = require.resolve("./index.ts");
delete require.cache[indexPath];

const { default: userStyleExtension } = require("./index.ts") as {
  default: (pi: any) => void;
};

// ── Tests ───────────────────────────────────────────────────────────────────

test("patched render uses userRailColor from settings via safeFg", () => {
  const events: Record<string, any> = {};
  const mockPi = {
    on: (event: string, handler: any) => {
      events[event] = handler;
    },
  };

  userStyleExtension(mockPi);

  // Trigger session_start with a mock context that has theme
  const mockCtx = {
    hasUI: true,
    ui: { theme: mockTheme },
  };

  events["session_start"]("session_start", mockCtx);

  // Import UserMessageComponent after extension has patched it
  const { UserMessageComponent } = require("@mariozechner/pi-coding-agent");
  const instance = new UserMessageComponent();
  const result = instance.render(20);

  assert.ok(Array.isArray(result), "render should return an array");
  assert.strictEqual(result.length, 1, "should return one line");
  assert.ok(
    result[0].includes("[customColor]┃"),
    `expected [customColor]┃ in "${result[0]}"`
  );
});

test("patched render falls back to accent when theme is missing", () => {
  const events: Record<string, any> = {};
  const mockPi = {
    on: (event: string, handler: any) => {
      events[event] = handler;
    },
  };

  userStyleExtension(mockPi);

  // Trigger with no theme
  const mockCtx = {
    hasUI: false,
    ui: null,
  };

  events["session_start"]("session_start", mockCtx);

  const { UserMessageComponent } = require("@mariozechner/pi-coding-agent");
  const instance = new UserMessageComponent();
  const result = instance.render(20);

  assert.ok(Array.isArray(result), "render should return an array");
  // When no theme, safeFg falls back to plain text
  assert.ok(
    result[0].startsWith("┃ "),
    `expected plain rail prefix in "${result[0]}"`
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

if (!process.exitCode) {
  console.log("\nAll tests passed.");
} else {
  console.log("\nSome tests failed.");
}
