/**
 * Release smoke test for the beautiful-pi meta-package (issue #8, AC6/AC7/AC8).
 *
 * Proves that a CLEAN temporary Pi installation resolves every exact
 * dependency and every explicit manifest path, and that pi boots all selected
 * extensions without registration errors, tool collisions, or command
 * collisions — without any live OAuth/Codex/quota credentials.
 *
 * Flow:
 *   1. `pnpm pack` → tarball of the current tree.
 *   2. npm-install the tarball into a fresh temp agent npm dir with pi's
 *      exact command (npm install, no --legacy-peer-deps) → resolves ALL
 *      dependencies strictly, including the pi-blackhole fork pin. The
 *      pi-rtk-optimizer peer-range gap for pi 0.83 is closed by the npm
 *      `overrides` field in package.json, so this must succeed without flags.
 *   3. Assert every package.json "pi" manifest path (extensions, prompts,
 *      themes) resolves relative to the installed package, and every direct
 *      dependency is present.
 *   4. Boot the real pi CLI in print mode against the temp agent (no
 *      credentials): the extension-load phase must pass cleanly — pi reaching
 *      the auth stage ("No API key found") is the success signal.
 *
 * Requires network (npm registry + the pi-blackhole fork on GitHub). Run with
 * `pnpm smoke`. Not part of the offline unit suite.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const TARBALL = join(ROOT, "beautiful-pi-0.1.0.tgz");
const LOAD_ERROR_RE =
  /Failed to load extension|Tool\s+["'`]?[A-Za-z0-9_-]+["'`]?\s+conflicts with|Command\s+["'`]?[A-Za-z0-9_/-]+["'`]?\s+conflicts/i;

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.error && res.error.code === "ETIMEDOUT") {
    return { timedOut: true, stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: null };
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
}

const tmp = mkdtempSync(join(tmpdir(), "bpi-smoke-"));
const agentDir = join(tmp, "agent");
const npmDir = join(agentDir, "npm");
const installed = join(npmDir, "node_modules", "beautiful-pi");

try {
  // 1. Pack
  ok("packing current tree");
  const pack = run("pnpm", ["pack"], { cwd: ROOT });
  if (pack.status !== 0 || !existsSync(TARBALL)) {
    fail("pnpm pack produced no tarball");
  } else {
    ok(`tarball: ${TARBALL}`);
  }

  // 2. Install tarball + deps into a fresh agent npm dir, replicating pi's
  // own managed install (npm install, no --legacy-peer-deps). Any strict
  // peer-resolution gap here is a release blocker (see issue #18).
  mkdirSync(npmDir, { recursive: true });
  ok("installing tarball + dependencies (npm, strict peer resolution)");
  const install = run(
    "npm",
    ["install", TARBALL, "--no-audit", "--no-fund"],
    { cwd: npmDir, timeout: 300_000 },
  );
  if (install.timedOut) {
    fail("dependency install timed out");
  } else if (install.status !== 0) {
    fail(`dependency install failed: ${(install.stderr || "").slice(0, 500)}`);
  } else {
    ok("dependencies resolved");
  }

  // 3. Manifest path + dependency assertions against the installed package.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifestPaths = [
    ...(pkg.pi?.extensions ?? []),
    ...(pkg.pi?.prompts ?? []),
    ...(pkg.pi?.themes ?? []),
  ];
  for (const p of manifestPaths) {
    const full = resolve(installed, p);
    if (existsSync(full)) ok(`manifest path: ${p}`);
    else fail(`manifest path missing: ${p} (${full})`);
  }
  for (const dep of Object.keys(pkg.dependencies)) {
    if (existsSync(join(npmDir, "node_modules", dep))) ok(`dependency: ${dep}`);
    else fail(`dependency missing: ${dep}`);
  }
  // The pinned fork must carry the provider-aware capability (issue #7).
  const blackholeDist = join(npmDir, "node_modules", "pi-blackhole", "dist", "index.js");
  if (
    existsSync(blackholeDist) &&
    readFileSync(blackholeDist, "utf8").includes("before_compact.provider_skipped")
  ) {
    ok("pi-blackhole fork carries the skipForProviders capability");
  } else {
    fail("pi-blackhole installed without the provider-aware capability");
  }

  // 4. Boot pi in print mode (no credentials — expected to stop at auth).
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ theme: "dark", packages: [installed] }),
  );
  ok("booting pi (print mode, no credentials)");
  const boot = run(
    PI_BIN,
    ["-p", "say hi", "--provider", "openai-codex", "--model", "gpt-5.5",
     "--api-key", "invalid-key", "--no-session", "--session-dir", join(tmp, "sessions")],
    { env: { ...process.env, HOME: tmp, PI_CODING_AGENT_DIR: agentDir }, timeout: 90_000 },
  );
  const output = `${boot.stdout}\n${boot.stderr}`;
  if (LOAD_ERROR_RE.test(output)) {
    fail(`extension load errors detected:\n${output.slice(0, 800)}`);
  } else if (boot.timedOut) {
    fail("pi boot timed out before reaching the provider stage");
  } else {
    ok("extensions loaded without registration/tool/command collisions");
  }
  if (!/No API key found|authentication|api key|401/i.test(output)) {
    // Pi must reach the auth stage — anything else means the run never got
    // past loading (or crashed earlier).
    fail(`pi did not reach the provider stage:\n${output.slice(0, 500)}`);
  } else {
    ok("pi reached the provider stage (load phase passed)");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke test FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log("\nsmoke test passed: clean install + boot verified");
