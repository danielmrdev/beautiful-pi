/**
 * Release smoke test for the beautiful-pi meta-package (issue #8, AC6/AC7/AC8).
 *
 * Proves that a CLEAN temporary Pi installation resolves every exact
 * dependency and every explicit manifest path, and that pi boots all selected
 * extensions without extension load/registration errors — without any live
 * OAuth/Codex/quota credentials. (pi 0.83 resolves duplicate tools
 * first-registration-wins and duplicate commands by `name:1` renaming, so
 * collisions are silent by design; the detectable failure class is a
 * throwing extension.)
 *
 * Flow:
 *   1. `pnpm pack` → tarball of the current tree.
 *   2. npm-install the tarball into a fresh temp agent npm dir with pi's
 *      exact command (npm install, no --legacy-peer-deps) → resolves ALL
 *      dependencies strictly, including the pi-blackhole fork pin. The
 *      pi-rtk-optimizer peer-range gap for pi 0.83 is closed by the npm
 *      `overrides` field in package.json, so this must succeed without flags.
 *   3. Assert every package.json "pi" manifest path (extensions, prompts,
 *      themes) resolves relative to the installed package, every direct
 *      dependency is present, and the installed pi-blackhole fork carries the
 *      provider-aware capability (via the coordinator's own probe).
 *   4. Boot the pi CLI the tarball resolved (npmDir/.bin/pi) in print mode
 *      against the temp agent (no credentials): the extension-load phase
 *      must pass cleanly — pi reaching the auth stage ("No API key found")
 *      is the success signal.
 *   5. Boot the same installed pi in TUI-capable mode under a PTY: the
 *      beautiful-pi banner must render (session_start ran with UI enabled)
 *      with no extension load errors and the passed model visible, and the
 *      compaction coordinator's session_start hook must write
 *      skipForProviders into the clean agent dir at runtime.
 *   6. Exercise the compaction coordination at runtime against the installed
 *      artifacts: drive BOTH engines (pi-codex-compaction + pi-blackhole
 *      fork) through real session_before_compact events and assert
 *      one-engine-per-turn (openai-codex → native compaction, blackhole
 *      steps aside; non-Codex → blackhole compacts).
 *
 * Requires network (npm registry + the pi-blackhole fork on GitHub), a PTY
 * runner (`script` from util-linux), and tsx. Run with `pnpm smoke`. Not part
 * of the offline unit suite.
 */
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const TARBALL = join(ROOT, "beautiful-pi-0.1.0.tgz");
// The real load-phase signal is "Failed to load extension"; the "conflicts
// with" branches are a safety net in case a future pi/provider prints one.
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// TUI-mode render signals: pi emits terminal-mode escapes on start, and the
// beautiful-pi banner proves session_start ran with ctx.hasUI enabled.
const TUI_ESCAPE_RE = /\x1b\[/;
const TUI_BANNER_RE = /CODING AGENT/;

/**
 * Boots the real pi CLI in TUI mode under a PTY and waits for the
 * beautiful-pi banner to render, then kills the process group.
 * Returns { ok, output, timedOut?, exitCode?, signal? }.
 */
async function bootTuiPi(piBin, args, { env, cwd, timeoutMs = 60_000 }) {
  const cmd = [piBin, ...args].map(shellQuote).join(" ");
  return new Promise((resolve) => {
    let output = "";
    let finished = false;
    let child;
    function finish(result) {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(deadline);
      // Safe to kill immediately: session_start handlers (including the
      // coordinator's sync config write) complete before the first banner
      // frame is drawn.
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* process group already gone */
        }
      }
      resolve({ ...result, output });
    }
    const poll = setInterval(() => {
      if (TUI_ESCAPE_RE.test(output) && TUI_BANNER_RE.test(output)) {
        finish({ ok: true });
      }
    }, 200);
    const deadline = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
    child = spawn("script", ["-qec", cmd, "/dev/null"], {
      detached: true,
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      output += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      output += d.toString("utf8");
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("exit", (code, signal) => finish({ ok: false, exitCode: code, signal }));
  });
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

  // Point this process at the temp agent so the installed coordinator's
  // getAgentDir-based helpers resolve the same clean config location the
  // boots use. The pi CLI the tarball resolved lives in the temp npm dir.
  process.env.HOME = tmp;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const installedPiBin = join(npmDir, "node_modules", ".bin", "pi");
  if (!existsSync(installedPiBin)) {
    fail(`installed pi CLI missing: ${installedPiBin}`);
  } else {
    ok(`installed pi CLI: ${installedPiBin}`);
  }
  const coordinator = install.status === 0
    ? await import(
        pathToFileURL(join(installed, "extensions", "compaction", "coordinator.ts")).href,
      ).catch((error) => {
        fail(`could not load installed compaction coordinator: ${error.message}`);
        return null;
      })
    : null;

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
  // The pinned fork must carry the provider-aware capability (issue #7);
  // reuse the coordinator's own probe so the check and the runtime guard
  // cannot drift apart.
  if (coordinator?.blackholeHasProviderSkip() ?? false) {
    ok("pi-blackhole fork carries the skipForProviders capability");
  } else {
    fail("pi-blackhole installed without the provider-aware capability");
  }

  // 4. Boot pi in print mode (no credentials — expected to stop at auth).
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ theme: "dark", packages: [installed] }),
  );
  ok("booting installed pi (print mode, no credentials)");
  const boot = run(
    installedPiBin,
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
    ok("extensions loaded without load/registration errors");
  }
  if (!/No API key found|authentication|api key|401/i.test(output)) {
    // Pi must reach the auth stage — anything else means the run never got
    // past loading (or crashed earlier).
    fail(`pi did not reach the provider stage:\n${output.slice(0, 500)}`);
  } else {
    ok("pi reached the provider stage (load phase passed)");
  }

  // 5. Boot pi in TUI-capable mode under a PTY — the UI registration paths
  //     (banner, footer, editor, rails, commands) that print mode never runs.
  //     The beautiful-pi banner rendering is the success signal: session_start
  //     ran with ctx.hasUI enabled and no widget/command/tool threw, and the
  //     banner/footer render the passed model, tying provider/model selection
  //     to the boot. Account routing needs a request (hence credentials) — it
  //     is covered by the unit suite, not the smoke.
  const scriptCheck = run("script", ["--version"]);
  if (scriptCheck.error || scriptCheck.status !== 0) {
    fail("script (util-linux) not found — required for the PTY-based TUI boot");
  }
  const projectDir = join(tmp, "project");
  mkdirSync(projectDir, { recursive: true });
  ok("booting installed pi TUI (real runtime under a PTY, no credentials)");
  const tui = await bootTuiPi(
    installedPiBin,
    ["--approve", "--provider", "openai", "--model", "gpt-5.5",
     "--api-key", "invalid-key", "--session-dir", join(tmp, "sessions"),
     "--session-id", "smoke-tui"],
    { env: { ...process.env, HOME: tmp, PI_CODING_AGENT_DIR: agentDir }, cwd: projectDir },
  );
  if (tui.ok) {
    ok("TUI rendered (banner visible — UI registration paths ran)");
  } else if (tui.timedOut) {
    fail("pi TUI did not render the banner within 60s");
  } else {
    fail(`pi TUI exited during startup (code ${tui.exitCode ?? "?"}`
      + `${tui.signal ? ` signal ${tui.signal}` : ""}${tui.error ? `, ${tui.error}` : ""})`);
  }
  if (LOAD_ERROR_RE.test(tui.output)) {
    fail(`extension load errors during TUI boot:\n${tui.output.slice(0, 800)}`);
  } else {
    ok("TUI boot: no extension load errors");
  }
  if (/gpt-5\.5/i.test(tui.output)) {
    ok("provider/model selection rendered in the TUI (banner/footer show gpt-5.5)");
  } else {
    fail("passed model did not render in the TUI — provider/model selection broken");
  }

  // The compaction coordinator's session_start hook must have written the
  // provider-aware skip config into the clean agent dir at runtime.
  const blackholeCfgPath = coordinator?.blackholeConfigPath()
    ?? join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
  try {
    const skip = JSON.parse(readFileSync(blackholeCfgPath, "utf8")).skipForProviders ?? [];
    if (skip.includes("openai-codex")) {
      ok("compaction coordinator ran at runtime (skipForProviders written during TUI boot)");
    } else {
      fail(`compaction coordinator wrote skipForProviders=${JSON.stringify(skip)} (expected openai-codex)`);
    }
  } catch (error) {
    fail(`compaction skip config missing after TUI boot (${error.message})`);
  }

  // 6. Exercise the compaction coordination at runtime (issue #13): drive
  //     BOTH installed engines through real session_before_compact events and
  //     assert one-engine-per-turn selection.
  ok("exercising compaction coordination at runtime");
  const guard = run(
    process.execPath,
    ["--import=tsx", join(ROOT, "scripts", "smoke", "compaction-check.mts"), installed, agentDir],
    { env: { ...process.env, HOME: tmp, PI_CODING_AGENT_DIR: agentDir }, timeout: 60_000 },
  );
  if (guard.status === 0) {
    ok("compaction coordination exercised at runtime (codex → native, other → blackhole)");
  } else {
    fail(`compaction runtime check failed:\n${(guard.stderr || guard.stdout || "").slice(0, 800)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke test FAILED (${failures} failure(s))`);
  process.exit(1);
}
console.log("\nsmoke test passed: clean install + boot verified");
