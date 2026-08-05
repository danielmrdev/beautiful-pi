/**
 * `/codex` command surface — Codex account lifecycle.
 *
 * Subcommands:
 *   /codex account add [label]      create a new Codex account
 *   /codex account login [ref]      authenticate (or show how)
 *   /codex account logout [ref]     remove the stored credential
 *   /codex account remove [ref]     remove the account configuration entry
 *   /codex account switch [ref]     switch the active model to the account
 *   /codex account list             list accounts with auth status
 *   /codex account status [ref]     detailed status for one account
 *   /codex account migrate          run legacy config migration manually
 *
 * pi owns the OAuth credential store (auth.json) and the login/logout dialogs;
 * this surface registers providers so pi's `/login` can authenticate them and
 * instructs the user for `/logout`. We never write auth.json.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
// Node builtins follow the repo convention: require(), not import.
const { exec } = require("node:child_process") as typeof import("node:child_process");
import {
  loadGlobalAccountConfig,
  saveGlobalAccountConfig,
  addAccount,
  removeAccount,
  setActiveAccount,
  resolveAccount,
  isCredentialAllowed,
  authFilePath,
  agentDirPath,
  storedCredentialIds,
  createPool,
  deletePool,
  setPoolEnabled,
  addPoolMembers,
  removePoolMembers,
  resolvePool,
  listPools,
  setPoolStrategy,
  setPoolSchedule,
  clearPoolSchedule,
  setPoolSelector,
  clearPoolSelector,
} from "./store.ts";
import { nextCodexCredentialId, registerAccountProvider, isSuffixedCodexId, activateAccountModel } from "./provider.ts";
import { getProviderAdapter } from "./registry.ts";
import { runMigration } from "./migration.ts";
import { nextEligibleMember, getSharedRotationState, beginNewRequest, isCooldownActive, type EligibleMember, type RotationContext, type RotationState } from "./rotation.ts";
import { rotationContextFrom } from "./context.ts";
import {
  WEEKDAYS,
  WEEKEND,
  eligibleMembers,
  isScheduleActive,
  resolveCustomSelection,
  selectQuotaFirst,
  selectScheduled,
} from "./strategies.ts";
import { fetchAccountQuotaReport, formatAccountQuota, formatUnavailableReason } from "./quota.ts";
import { SCHEDULE_DATE_RE, SCHEDULE_TIME_RE } from "./store.ts";
import type { AccountAuthStatus, AccountConfig, CodexAccount, CodexPool, PoolSchedule } from "./types.ts";

const USAGE = [
  "/codex account <subcommand>",
  "",
  "  add [label]      create a new Codex account",
  "  login [ref]      authenticate the account (shows the /login command)",
  "  logout [ref]     remove the stored credential (shows the /logout command)",
  "  remove [ref]     remove the account configuration entry",
  "  switch [ref]     switch the active model to the account",
  "  list             list accounts with auth status",
  "  status [ref]     detailed status for one account",
  "  quota [ref]      inspect quota windows (5h/7d usage) per account",
  "  migrate          run legacy multi-pass config migration",
  "",
  "/codex pool <subcommand>",
  "",
  "  create <name> <member...>   create a pool from account refs",
  "  list                        list pools with members",
  "  inspect <pool>              per-member eligibility",
  "  enable <pool>               re-enable a pool",
  "  disable <pool>              disable a pool (no rotation/failover)",
  "  delete <pool>               remove the pool",
  "  add <pool> <member...>      add members",
  "  remove <pool> <member...>   remove members",
  "  use <pool>                  select a member (round-robin, quota-first, scheduled, or custom)",
  "  strategy <pool> <round-robin|quota-first|scheduled|custom>",
  "  schedule <pool> [<HH:MM-HH:MM>,...] [days <spec>] [from <date>] [to <date>] [roles <member>=<role> ...]",
  "  schedule clear <pool>       remove the schedule",
  "  selector <pool> <command>   custom member selector (outputs a member ref)",
  "  selector clear <pool>       remove the selector",
  "",
  "days <spec>: everyday | weekdays | weekend | sun,mon,... | mon-fri ranges",
  "roles: <member>=<primary|backup>  (backup members used when no primary is eligible)",
].join("\n");

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}
function sendOutput(pi: ExtensionAPI, lines: string[]): void {
  pi.sendMessage({
    customType: "codex-accounts",
    content: lines.join("\n"),
    display: true,
  }, { triggerTurn: false });
}

/** The referenced account, or the active/first account when no ref is given. */
function pickAccount(cfg: AccountConfig, ref: string | undefined): CodexAccount | undefined {
  if (!ref) {
    const active = cfg.activeAccountId
      ? cfg.accounts.find((a) => a.id === cfg.activeAccountId)
      : cfg.accounts.find((a) => a.active);
    return active ?? cfg.accounts[0];
  }
  return resolveAccount(cfg, ref);
}

function authStatusOf(ctx: ExtensionCommandContext, credentialId: string): AccountAuthStatus {
  try {
    return ctx.modelRegistry.getProviderAuthStatus(credentialId) as AccountAuthStatus;
  } catch {
    return { configured: false };
  }
}

function statusLineOf(ctx: ExtensionCommandContext, account: CodexAccount): string {
  const adapter = getProviderAdapter(account.provider);
  const status = authStatusOf(ctx, account.credentialId);
  const credential = readStoredCredential(account.credentialId, authFilePath());
  return adapter?.statusLine(status, credential) ?? (status.configured ? "authenticated" : "not authenticated");
}

/** Resolve an account for a ref-less command, notifying when none exists. */
function ensureAccount(cfg: AccountConfig, ctx: ExtensionCommandContext, ref: string | undefined): CodexAccount | undefined {
  const account = pickAccount(cfg, ref);
  if (!account) {
    notify(ctx, "No Codex accounts yet. Add one with: /codex account add <label>", "warning");
  }
  return account;
}

function formatAccountRow(ctx: ExtensionCommandContext, account: CodexAccount, activeId?: string): string {
  const active = account.id === activeId || account.active ? "●" : " ";
  return `${active} ${account.label}  [${account.credentialId}]  ${statusLineOf(ctx, account)}`;
}

// ── Subcommands ──────────────────────────────────────────────────────────────

async function cmdAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  let label = rest.trim();
  if (!label && ctx.hasUI) {
    label = (await ctx.ui.input("Account label", "e.g. work, personal"))?.trim() ?? "";
  }
  if (!label) {
    notify(ctx, "Usage: /codex account add <label>", "error");
    return;
  }
  // Avoid colliding with a credential already present in pi's auth store
  // (e.g. created by a manual /login) even when it has no account entry.
  const used = [...cfg.accounts.map((a) => a.credentialId), ...storedCredentialIds()];
  const credentialId = nextCodexCredentialId(used);
  const result = addAccount(cfg, { provider: "openai-codex", credentialId, label });
  saveGlobalAccountConfig(result.cfg);
  if (result.created) {
    registerAccountProvider(ctx.modelRegistry, result.account);
    notify(ctx, `Added Codex account "${label}" as ${credentialId}. Authenticate with: /login ${credentialId}`);
  } else {
    notify(ctx, `Account "${label}" already exists as ${result.account.credentialId}`);
  }
}

async function cmdLogin(ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = ensureAccount(cfg, ctx, ref);
  if (!account) return;
  if (!isCredentialAllowed(ctx.cwd, account.credentialId)) {
    notify(ctx, `Account ${account.credentialId} is restricted in this project`, "warning");
    return;
  }
  const status = authStatusOf(ctx, account.credentialId);
  if (status.configured) {
    notify(ctx, `Account "${account.label}" is already authenticated`);
  } else {
    notify(ctx, `Authenticate "${account.label}" with: /login ${account.credentialId}`);
  }
}

async function cmdLogout(ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = ensureAccount(cfg, ctx, ref);
  if (!account) return;
  const status = authStatusOf(ctx, account.credentialId);
  if (!status.configured) {
    notify(ctx, `Account "${account.label}" is not authenticated`);
    return;
  }
  notify(ctx, `Remove the stored credential with: /logout ${account.credentialId}`);
}

async function cmdRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = pickAccount(cfg, ref);
  if (!account) {
    notify(ctx, "No matching Codex account found", "error");
    return;
  }
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Remove Codex account",
      `Remove "${account.label}" (${account.credentialId})? The stored credential stays in pi's auth store.`,
    );
    if (!confirmed) return;
  }
  const next = removeAccount(cfg, account.id);
  saveGlobalAccountConfig(next);
  if (isSuffixedCodexId(account.credentialId)) {
    try {
      ctx.modelRegistry.unregisterProvider(account.credentialId);
    } catch {
      // provider may not be registered
    }
  }
  notify(ctx, `Removed account "${account.label}". Credential still stored — remove it with: /logout ${account.credentialId}`);
}

async function cmdSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = ensureAccount(cfg, ctx, ref);
  if (!account) return;
  if (!isCredentialAllowed(ctx.cwd, account.credentialId)) {
    notify(ctx, `Account ${account.credentialId} is restricted in this project`, "warning");
    return;
  }
  const model = await activateAccountModel(pi, ctx.modelRegistry, account);
  if (!model) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${account.credentialId}`, "warning");
    return;
  }
  const next = setActiveAccount(cfg, account.id);
  saveGlobalAccountConfig(next);
  notify(ctx, `Switched to Codex account "${account.label}" (${account.credentialId}, ${model.id})`);
}

async function cmdList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  if (cfg.accounts.length === 0) {
    sendOutput(pi, ["No Codex accounts yet.", "Add one with: /codex account add <label>"]);
    return;
  }
  const activeId = cfg.activeAccountId ?? cfg.accounts.find((a) => a.active)?.id;
  const rows = cfg.accounts.map((a) => formatAccountRow(ctx, a, activeId));
  sendOutput(pi, ["Codex accounts", ...rows, "", "● active  · use /codex account switch <label> to change"]);
}

async function cmdStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = pickAccount(cfg, ref);
  if (!account) {
    sendOutput(pi, ["No matching Codex account found."]);
    return;
  }
  const adapter = getProviderAdapter(account.provider);
  const allowed = isCredentialAllowed(ctx.cwd, account.credentialId);
  const lines = [
    `Account: ${account.label}`,
    `  credential:  ${account.credentialId}`,
    `  provider:    ${adapter?.displayName ?? account.provider}`,
    `  status:      ${statusLineOf(ctx, account)}`,
    `  project:     ${allowed ? "allowed" : "restricted in this project"}`,
    `  created:     ${account.createdAt.slice(0, 10)}`,
    ...(account.lastUsedAt ? [`  last used:   ${account.lastUsedAt.slice(0, 10)}`] : []),
    ...(account.legacy?.index !== undefined ? [`  legacy:      migrated from multi-pass (subscription #${account.legacy.index})`] : account.legacy ? ["  legacy:      migrated from multi-pass"] : []),
    ...(statusLineOf(ctx, account).startsWith("not authenticated") ? [`  next:        /login ${account.credentialId}`] : []),
  ];
  sendOutput(pi, lines);
}

async function cmdAccountQuota(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  if (cfg.accounts.length === 0) {
    sendOutput(pi, ["No Codex accounts yet.", "Add one with: /codex account add <label>"]);
    return;
  }
  const accounts = ref ? [pickAccount(cfg, ref)].filter((a): a is CodexAccount => !!a) : cfg.accounts;
  if (accounts.length === 0) {
    sendOutput(pi, ["No matching Codex account found."]);
    return;
  }
  const lines = ["Codex quota"];
  const allowed = accounts.filter((a) => isCredentialAllowed(ctx.cwd, a.credentialId));
  for (const account of accounts) {
    if (!isCredentialAllowed(ctx.cwd, account.credentialId)) {
      lines.push(`  ${account.label}  [${account.credentialId}]  restricted in this project`);
    }
  }
  // Fetch allowed accounts in parallel; each fetch has its own timeout.
  const reports = await Promise.all(allowed.map((a) => fetchAccountQuotaReport(a)));
  for (const report of reports) {
    const { account } = report;
    if (report.quota) {
      lines.push(`  ${account.label}  [${account.credentialId}]  ${formatAccountQuota(report.quota)}`);
    } else {
      lines.push(`  ${account.label}  [${account.credentialId}]  unavailable: ${formatUnavailableReason(report.unavailableReason ?? "network")}`);
    }
  }
  sendOutput(pi, lines);
}

async function cmdMigrate(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const summary = runMigration(agentDirPath(), ctx.cwd, { trusted: ctx.isProjectTrusted() });  const lines = [
    "Legacy multi-pass migration",
    `  global:  ${summary.global}`,
    `  project: ${summary.project}${summary.project === "skipped-untrusted" ? " (project not trusted)" : ""}`,
    ...(summary.accountsCreated > 0 ? [`  accounts created: ${summary.accountsCreated}`] : []),
    ...summary.warnings.map((w) => `  ! ${w}`),
  ];
  sendOutput(pi, lines);
  if (summary.accountsCreated > 0 || summary.warnings.length > 0) {
    notify(ctx, `Migration done: global=${summary.global}, project=${summary.project}`, "info");
  }
}

// ── Pool subcommands ─────────────────────────────────────────────────────────

function poolMemberLabel(cfg: AccountConfig, credentialId: string): string {
  return cfg.accounts.find((a) => a.credentialId === credentialId)?.label ?? credentialId;
}

function poolMemberStatus(ctx: ExtensionCommandContext, cfg: AccountConfig, credentialId: string): string {
  const account = cfg.accounts.find((a) => a.credentialId === credentialId);
  const status = account ? statusLineOf(ctx, account) : "no account entry";
  const rotCtx = rotationContextFrom(ctx);
  const restricted = !rotCtx.allowed(credentialId);
  const cooling = isCooldownActive(getSharedRotationState(), credentialId);
  return `${status}${cooling ? " · cooling down" : ""}${restricted ? " · restricted in this project" : ""}`;
}

async function cmdPoolCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...memberRefs] = tokenize(rest);
  if (!name || memberRefs.length === 0) {
    notify(ctx, "Usage: /codex pool create <name> <member...>  (members are account refs: label, credential id, or id)", "error");
    return;
  }
  const result = createPool(cfg, name, memberRefs);
  if (!result.created) {
    notify(ctx, `Could not create pool: ${result.errors.join("; ")}`, "error");
    return;
  }
  // AC2: unavailable (unauthenticated) members are rejected, not admitted.
  const rotCtx = rotationContextFrom(ctx);
  const unauthenticated = result.pool!.credentialIds.filter((id) => !rotCtx.authConfigured(id));
  if (unauthenticated.length > 0) {
    const labels = unauthenticated.map((id) => poolMemberLabel(result.cfg, id)).join(", ");
    saveGlobalAccountConfig(deletePool(result.cfg, name));
    notify(ctx, `Could not create pool: ${labels} not authenticated yet. Authenticate with: /login <credentialId>`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Created pool "${name}" with ${result.pool!.credentialIds.length} member(s)`);
}

async function cmdPoolList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pools = listPools(cfg);
  if (pools.length === 0) {
    sendOutput(pi, ["No Codex pools yet.", "Create one with: /codex pool create <name> <member...>"]);
    return;
  }
  const rows = pools.map((p) => {
    const members = p.credentialIds.map((id) => poolMemberLabel(cfg, id)).join(", ") || "(empty)";
    return `${p.enabled ? "●" : "○"} ${p.name}  [${p.credentialIds.length} member(s): ${members}]`;
  });
  sendOutput(pi, ["Codex pools", ...rows, "", "● enabled · use /codex pool use <name> to rotate"]);
}

async function cmdPoolInspect(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    sendOutput(pi, [`Pool "${ref}" not found. See: /codex pool list`]);
    return;
  }
  const lines = [
    `Pool: ${pool.name} (${pool.enabled ? "enabled" : "disabled"})`,
    `  cooldown:    ${pool.cooldownSeconds}s after a rate limit`,
    `  next index:  #${pool.lastUsedIndex + 1} (rotation pointer)`,
    `  strategy:    ${pool.strategy ?? "round-robin"}`,
    ...(pool.schedule ? [`  schedule:    ${summarizeSchedule(pool.schedule)}`] : []),
    ...(pool.selector ? [`  selector:    ${pool.selector}`] : []),
    "",
    ...(pool.credentialIds.length === 0
      ? ["  (no members — add some with /codex pool add)"]
      : pool.credentialIds.map((id) => `  ${poolMemberLabel(cfg, id)}  [${id}]  ${poolMemberStatus(ctx, cfg, id)}`)),
  ];
  sendOutput(pi, lines);
}

async function cmdPoolSetEnabled(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string, enabled: boolean): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  saveGlobalAccountConfig(setPoolEnabled(cfg, ref, enabled));
  notify(ctx, `Pool "${pool.name}" ${enabled ? "enabled" : "disabled"}`);
}

async function cmdPoolDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  saveGlobalAccountConfig(deletePool(cfg, ref));
  notify(ctx, `Deleted pool "${pool.name}"`);
}

async function cmdPoolAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...memberRefs] = tokenize(rest);
  if (!name || memberRefs.length === 0) {
    notify(ctx, "Usage: /codex pool add <pool> <member...>", "error");
    return;
  }
  const result = addPoolMembers(cfg, name, memberRefs);
  if (!result.ok) {
    notify(ctx, `Could not add members: ${result.errors.join("; ")}`, "error");
    return;
  }
  // AC2: newly added members must be available (authenticated).
  const rotCtx = rotationContextFrom(ctx);
  const unauthenticated = memberRefs
    .map((ref) => resolveAccount(result.cfg, ref.trim()))
    .filter((a): a is CodexAccount => !!a)
    .filter((a) => !rotCtx.authConfigured(a.credentialId))
    .map((a) => a.credentialId);
  if (unauthenticated.length > 0) {
    const rollback = removePoolMembers(result.cfg, name, unauthenticated);
    saveGlobalAccountConfig(rollback.cfg);
    notify(ctx, `Could not add members: ${unauthenticated.join(", ")} not authenticated yet. Authenticate with: /login <credentialId>`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Added member(s) to pool "${name}"`);
}

async function cmdPoolRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...memberRefs] = tokenize(rest);
  if (!name || memberRefs.length === 0) {
    notify(ctx, "Usage: /codex pool remove <pool> <member...>", "error");
    return;
  }
  const result = removePoolMembers(cfg, name, memberRefs);
  if (!result.ok) {
    notify(ctx, `Could not remove members: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Removed member(s) from pool "${name}"`);
}

async function cmdPoolUse(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  if (!pool.enabled) {
    notify(ctx, `Pool "${pool.name}" is disabled. Enable with: /codex pool enable ${pool.name}`, "warning");
    return;
  }
  const rotCtx = rotationContextFrom(ctx);
  const state = getSharedRotationState();
  beginNewRequest(state);
  const member = await selectForStrategy(pool, cfg, rotCtx, state, ctx);
  if (!member) {
    notify(
      ctx,
      `No eligible member in pool "${pool.name}". Check authentication (/codex account list) and cooldowns (/codex pool inspect ${pool.name})`,
      "warning",
    );
    return;
  }
  const account = cfg.accounts.find((a) => a.credentialId === member.credentialId)!;
  const model = await activateAccountModel(pi, ctx.modelRegistry, account);
  if (!model) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${member.credentialId}`, "warning");
    return;
  }
  const withPointer: AccountConfig = {
    ...setActiveAccount(cfg, account.id),
    pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, lastUsedIndex: member.index } : p)),
  };
  saveGlobalAccountConfig(withPointer);
  notify(ctx, `Pool "${pool.name}": active member is "${account.label}" (${member.credentialId}, ${model.id})`);
}

// ── Strategy selection ───────────────────────────────────────────────────────

const WINDOW_RE = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DAY_NUM_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(DAY_NAMES).map(([name, num]) => [num, name]),
);

/**
 * Pick a pool member according to the pool's strategy. Every strategy degrades
 * to deterministic round-robin when its specialized data is unavailable;
 * quota-first fetches live quota for the eligible set (network failures and
 * missing credentials simply exclude a member from the healthiest ranking).
 */
async function selectForStrategy(
  pool: CodexPool,
  cfg: AccountConfig,
  rotCtx: RotationContext,
  state: RotationState,
  ctx: ExtensionCommandContext,
): Promise<EligibleMember | undefined> {
  const strategy = pool.strategy ?? "round-robin";
  if (strategy === "quota-first") {
    const members = eligibleMembers(pool, cfg, rotCtx, state);
    const reports = await Promise.all(
      members.map((m) => fetchAccountQuotaReport(cfg.accounts.find((a) => a.credentialId === m.credentialId)!)),
    );
    const quotaOf = (id: string) => reports.find((r) => r.account.credentialId === id)?.quota;
    const member = selectQuotaFirst(pool, cfg, rotCtx, state, quotaOf);
    if (member) {
      const withData = reports.filter((r) => r.quota);
      const noData = withData.length === 0;
      const allExhausted = withData.length > 0 && withData.every((r) => r.quota!.status === "exhausted");
      if (noData) {
        notify(ctx, `Pool "${pool.name}": no quota data available — fell back to round-robin`, "warning");
      } else if (allExhausted) {
        notify(ctx, `Pool "${pool.name}": every account is at quota — fell back to round-robin`, "warning");
      }
    }
    return member;
  }
  if (strategy === "scheduled") {
    const now = new Date();
    const member = selectScheduled(pool, cfg, rotCtx, state, pool.schedule, now);
    if (member && !isScheduleActive(pool.schedule, now)) {
      notify(ctx, `Pool "${pool.name}": schedule inactive — using round-robin`, "warning");
    }
    return member;
  }
  if (strategy === "custom") {
    if (!pool.selector) {
      notify(ctx, `Pool "${pool.name}": no selector configured — using round-robin (set one with /codex pool selector)`, "warning");
      return nextEligibleMember(pool, cfg, rotCtx, state);
    }
    const members = eligibleMembers(pool, cfg, rotCtx, state);
    const refOut = await execSelector(pool.selector, {
      pool: { name: pool.name, credentialIds: pool.credentialIds },
      eligible: members.map((m) => m.credentialId),
      now: new Date().toISOString(),
    });
    const member = resolveCustomSelection(pool, cfg, rotCtx, state, refOut);
    if (member) return member;
    const reason = refOut
      ? `selector returned an ineligible member ("${refOut}")`
      : "selector produced no usable member";
    notify(ctx, `Pool "${pool.name}": ${reason} — using round-robin`, "warning");
    return nextEligibleMember(pool, cfg, rotCtx, state);
  }
  return nextEligibleMember(pool, cfg, rotCtx, state);
}

/** Run the custom selector shell command; resolves with its first stdout line. */
function execSelector(selector: string, input: unknown): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = exec(selector, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(undefined);
        const line = stdout.trim().split(/\r?\n/)[0]?.trim();
        resolve(line || undefined);
      });
      const stdin = child.stdin;
      if (stdin) {
        // Selectors may ignore stdin (e.g. `echo`); a closed pipe must not crash.
        stdin.on("error", () => {});
        try {
          stdin.end(JSON.stringify(input));
        } catch {
          // stdin already closed
        }
      }
    } catch {
      resolve(undefined);
    }
  });
}

async function cmdPoolStrategy(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, strategy, ...extra] = tokenize(rest);
  if (!name || !strategy || extra.length > 0) {
    notify(ctx, "Usage: /codex pool strategy <pool> <round-robin|quota-first|scheduled|custom>", "error");
    return;
  }
  if (!resolvePool(cfg, name)) {
    notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
    return;
  }
  const result = setPoolStrategy(cfg, name, strategy);
  if (!result.ok) {
    notify(ctx, `Could not set strategy: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Pool "${name}" strategy: ${strategy}`);
}

async function cmdPoolSchedule(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    notify(ctx, "Usage: /codex pool schedule <pool> [<HH:MM-HH:MM>,...] [days <spec>] [from <date>] [to <date>] [roles <member>=<role> ...]", "error");
    return;
  }
  // Accept both "schedule clear <pool>" and "schedule <pool> clear".
  const clear = tokens.some((t) => t.toLowerCase() === "clear");
  const name = tokens.find((t) => t.toLowerCase() !== "clear");
  if (!name) {
    notify(ctx, "Usage: /codex pool schedule clear <pool>", "error");
    return;
  }
  const pool = resolvePool(cfg, name);
  if (!pool) {
    notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
    return;
  }
  if (clear) {
    saveGlobalAccountConfig(clearPoolSchedule(cfg, name).cfg);
    notify(ctx, `Cleared schedule for pool "${pool.name}"`);
    return;
  }
  const parsed = parseScheduleArgs(pool, cfg, tokens.filter((t) => t !== name));
  if (!parsed.schedule || parsed.errors.length > 0) {
    notify(ctx, `Could not set schedule: ${parsed.errors.join("; ")}`, "error");
    return;
  }
  const result = setPoolSchedule(cfg, name, parsed.schedule);
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Schedule for pool "${pool.name}": ${summarizeSchedule(parsed.schedule)}`);
}

async function cmdPoolSelector(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    notify(ctx, "Usage: /codex pool selector <pool> <command...>  (or: /codex pool selector clear <pool>)", "error");
    return;
  }
  // Clear form is unambiguous: "selector clear <pool>".
  if (tokens[0].toLowerCase() === "clear") {
    const name = tokens[1];
    if (!name) {
      notify(ctx, "Usage: /codex pool selector clear <pool>", "error");
      return;
    }
    const pool = resolvePool(cfg, name);
    if (!pool) {
      notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
      return;
    }
    saveGlobalAccountConfig(clearPoolSelector(cfg, name).cfg);
    notify(ctx, `Cleared selector for pool "${pool.name}"`);
    return;
  }
  const [name, ...command] = tokens;
  const pool = resolvePool(cfg, name);
  if (!pool) {
    notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
    return;
  }
  if (command.length === 0) {
    notify(ctx, "Usage: /codex pool selector <pool> <command...>", "error");
    return;
  }
  const result = setPoolSelector(cfg, name, command.join(" "));
  if (!result.ok) {
    notify(ctx, `Could not set selector: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  const saved = resolvePool(result.cfg, name)!;
  notify(ctx, `Custom selector for pool "${pool.name}": ${saved.selector}`);
}

function parseDayToken(token: string): number[] | undefined {
  const t = token.toLowerCase();
  if (t === "everyday") return [];
  if (t === "weekdays") return [...WEEKDAYS];
  if (t === "weekend") return [...WEEKEND];
  const range = /^([a-z]{3})-([a-z]{3})$/.exec(t);
  if (range) {
    const a = DAY_NAMES[range[1]];
    const b = DAY_NAMES[range[2]];
    if (a === undefined || b === undefined) return undefined;
    if (a <= b) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    return [...Array.from({ length: 7 - a }, (_, i) => a + i), ...Array.from({ length: b + 1 }, (_, i) => i)];
  }
  const single = DAY_NAMES[t];
  return single !== undefined ? [single] : undefined;
}

/** Parse `[<HH:MM-HH:MM>,...] [days <spec>] [from <date>] [to <date>] [roles <member>=<role> ...]`. */
function parseScheduleArgs(
  pool: CodexPool,
  cfg: AccountConfig,
  tokens: string[],
): { schedule?: PoolSchedule; errors: string[] } {
  const schedule: PoolSchedule = {};
  const errors: string[] = [];
  let i = 0;
  if (i < tokens.length && /^\d{2}:\d{2}-\d{2}:\d{2}/.test(tokens[i])) {
    const windows: Array<{ start: string; end: string }> = [];
    for (const w of tokens[i].split(",")) {
      const match = WINDOW_RE.exec(w);
      if (!match || !SCHEDULE_TIME_RE.test(match[1]) || !SCHEDULE_TIME_RE.test(match[2])) {
        errors.push(`invalid time window "${w}" (HH:MM-HH:MM)`);
        return { schedule: undefined, errors };
      }
      windows.push({ start: match[1], end: match[2] });
    }
    schedule.timeWindows = windows;
    i++;
  }
  while (i < tokens.length) {
    const kw = tokens[i].toLowerCase();
    if (kw === "days") {
      i++;
      const days: number[] = [];
      while (i < tokens.length && !["from", "to", "roles"].includes(tokens[i].toLowerCase())) {
        for (const part of tokens[i].split(",")) {
          const parsed = parseDayToken(part);
          if (!parsed) {
            errors.push(`unknown day "${part}" (sun..sat, mon-fri, weekdays, weekend, everyday)`);
            return { schedule: undefined, errors };
          }
          days.push(...parsed);
        }
        i++;
      }
      if (days.length > 0) schedule.days = [...new Set(days)].sort();
    } else if (kw === "from" || kw === "to") {
      const date = tokens[i + 1];
      if (!date || !SCHEDULE_DATE_RE.test(date)) {
        errors.push(`invalid date after "${kw}" (YYYY-MM-DD)`);
        return { schedule: undefined, errors };
      }
      schedule.dateRange = { ...schedule.dateRange, [kw === "from" ? "start" : "end"]: date };
      i += 2;
    } else if (kw === "roles") {
      i++;
      const memberRoles: Record<string, "primary" | "backup"> = {};
      while (i < tokens.length) {
        const pair = tokens[i];
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          errors.push(`invalid role "${pair}" (member=primary|backup)`);
          return { schedule: undefined, errors };
        }
        const account = resolveAccount(cfg, pair.slice(0, eq));
        const role = pair.slice(eq + 1).toLowerCase();
        if (!account) {
          errors.push(`unknown member "${pair.slice(0, eq)}"`);
          return { schedule: undefined, errors };
        }
        if (!pool.credentialIds.includes(account.credentialId)) {
          errors.push(`"${pair.slice(0, eq)}" is not a member of pool "${pool.name}"`);
          return { schedule: undefined, errors };
        }
        if (role !== "primary" && role !== "backup") {
          errors.push(`invalid role "${pair.slice(eq + 1)}" (primary|backup)`);
          return { schedule: undefined, errors };
        }
        memberRoles[account.credentialId] = role;
        i++;
      }
      if (Object.keys(memberRoles).length > 0) schedule.memberRoles = memberRoles;
    } else {
      errors.push(`unexpected token "${tokens[i]}"`);
      return { schedule: undefined, errors };
    }
  }
  if (Object.keys(schedule).length === 0) {
    errors.push("no schedule constraints given (e.g. 09:00-17:00, days mon-fri)");
    return { schedule: undefined, errors };
  }
  return { schedule, errors };
}

function summarizeSchedule(schedule: PoolSchedule): string {
  const parts: string[] = [];
  if (schedule.timeWindows?.length) parts.push(schedule.timeWindows.map((w) => `${w.start}-${w.end}`).join(","));
  if (schedule.days?.length) parts.push("on " + schedule.days.map((d) => DAY_NUM_TO_NAME[d] ?? "?").join(","));
  if (schedule.dateRange?.start) parts.push(`from ${schedule.dateRange.start}`);
  if (schedule.dateRange?.end) parts.push(`to ${schedule.dateRange.end}`);
  if (schedule.memberRoles) {
    const roles = Object.entries(schedule.memberRoles).map(([id, role]) => `${id}=${role}`).join(", ");
    parts.push(`roles ${roles}`);
  }
  return parts.join(" ") || "(always active)";
}

// ── Command registration ─────────────────────────────────────────────────────

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export function registerCodexCommand(pi: ExtensionAPI): void {
  pi.registerCommand("codex", {
    description: "Manage Codex accounts and pools (add, authenticate, switch, rotate, failover)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [section, sub, ...rest] = tokenize(args);
      if (section === "account") {
        const ref = rest.join(" ").trim() || undefined;
        switch (sub) {
          case "add":    await cmdAdd(pi, ctx, rest.join(" ")); break;
          case "login":  await cmdLogin(ctx, ref); break;
          case "logout": await cmdLogout(ctx, ref); break;
          case "remove": await cmdRemove(pi, ctx, ref); break;
          case "switch": await cmdSwitch(pi, ctx, ref); break;
          case "list":   await cmdList(pi, ctx); break;
          case "status": await cmdStatus(pi, ctx, ref); break;
          case "quota":  await cmdAccountQuota(pi, ctx, ref); break;
          case "migrate": await cmdMigrate(pi, ctx); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      if (section === "pool") {
        const restArgs = rest.join(" ");
        switch (sub) {
          case "create":  await cmdPoolCreate(pi, ctx, restArgs); break;
          case "list":    await cmdPoolList(pi, ctx); break;
          case "inspect": await cmdPoolInspect(pi, ctx, restArgs.trim()); break;
          case "enable":  await cmdPoolSetEnabled(pi, ctx, restArgs.trim(), true); break;
          case "disable": await cmdPoolSetEnabled(pi, ctx, restArgs.trim(), false); break;
          case "delete":  await cmdPoolDelete(pi, ctx, restArgs.trim()); break;
          case "add":     await cmdPoolAdd(pi, ctx, restArgs); break;
          case "remove":  await cmdPoolRemove(pi, ctx, restArgs); break;
          case "use":      await cmdPoolUse(pi, ctx, restArgs.trim()); break;
          case "strategy": await cmdPoolStrategy(pi, ctx, restArgs); break;
          case "schedule": await cmdPoolSchedule(pi, ctx, restArgs); break;
          case "selector": await cmdPoolSelector(pi, ctx, restArgs); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      notify(ctx, USAGE, "info");
    },
  });
}
