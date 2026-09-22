---
name: bpi-update
description: Audit Pi and b-pi's bundled integrations, apply evidence-backed compatible updates and fixes, verify release matrices, then commit and push.
disable-model-invocation: true
---

# bpi-update

Run from `beautiful-pi` repository. User invocation requests full loop: discover,
assess, update, verify, commit, push.

Use this order:

`baseline → inventory → evidence → matrix → patch → verify → ship`

Every stage ends with its completion criterion. Keep unrelated work out of diff.

## 0. Gate baseline

1. Resolve repo root:

   ```bash
   root=$(git rev-parse --show-toplevel)
   test -f "$root/package.json"
   cd "$root"
   ```

2. Read repository `AGENTS.md`, then inspect:

   ```bash
   git status --short
   git branch --show-current
   git remote -v
   git log -5 --oneline
   ```

3. Require clean worktree before changing files. Existing user changes are a
   stop condition; report paths and ask whether to continue after they are
   committed, stashed, or discarded.

4. Record current versions from `package.json`, `pnpm-lock.yaml`, and installed
   metadata. Record Node and pnpm versions.

5. Run baseline checks when they are available:

   ```bash
   pnpm test
   pnpm typecheck
   pnpm pack:check
   pnpm smoke
   ```

   Record existing peer warnings separately from failures.

**Done when:** repository is clean, branch/remote are known, current versions
are recorded, and baseline failures are classified as pre-existing or blocking.

## 0.5 Versioning and changelog rules

Treat `package.json` as the single source of truth for b-pi's version. Use
Semantic Versioning and release tags in the form `v<version>`:

- patch — backwards-compatible fixes and small corrections;
- minor — backwards-compatible features;
- major — breaking changes. Before 1.0.0, breaking changes increment minor.

Keep `CHANGELOG.md` in English. Put unreleased work under `Unreleased`, using
short, user-facing bullets grouped under `Added`, `Changed`, `Fixed`, or
`Removed`. Do not claim a fix until a test or verification step proves it.

For a release:

1. Choose the bump from the actual diff; do not bump for unrelated metadata.
2. Update `package.json` to the new version. The lockfile has no second b-pi
   version to edit; inspect it before changing anything.
3. Move completed `Unreleased` entries to `## [<version>] - YYYY-MM-DD`, then
   recreate an empty `Unreleased` section above it.
4. Confirm the manifest and changelog agree:

   ```bash
   version=$(node -p "require('./package.json').version")
   grep -F "## [$version]" CHANGELOG.md
   ```

5. Include version, changelog, code, tests, and README changes in one release
   commit. Create an annotated tag only after that commit exists:

   ```bash
   git tag -a "v$version" -m "beautiful-pi $version"
   ```

6. Push the verified branch and tag. Never move or overwrite an existing
   release tag.

**Done when:** release version, changelog entry, release commit, and tag name
are explicit; no release tag is created before verification passes.

## 1. Inventory b-pi surface

Derive inventory from the repository. Do not rely on memory or a hardcoded list.

- Pi host peers: `peerDependencies` whose names start with
  `@earendil-works/pi-`.
- Bundled integrations: `dependencies` plus every package referenced by
  `pi.extensions` outside `./extensions/`.
- Direct b-pi surfaces: imports from `@earendil-works/pi-*`, event hooks,
  `setFooter`/`setEditorComponent`, prototype patches, `as any` runtime seams,
  compaction coordinator, provider registration, and tests.

Useful commands:

```bash
node - <<'NODE'
const p = require('./package.json');
console.log(JSON.stringify({
  piPeers: p.peerDependencies,
  dependencies: p.dependencies,
  extensions: p.pi?.extensions,
}, null, 2));
NODE
rg -n 'from "@earendil-works/pi-|prototype|session_before_compact|agent_settled|turn_end|context|setFooter|setEditorComponent' extensions test
```

Build table:

| package/surface | current | source | b-pi usage | candidate |
|---|---:|---|---|---:|

**Done when:** every Pi peer, every bundled integration, and every fragile
runtime seam has one row with its current version and source repository.

## 2. Research upstream evidence

Use primary sources. For each inventory row:

1. Query registry metadata:

   ```bash
   npm view <package> dist-tags version time engines peerDependencies repository bugs --json
   ```

2. Locate official repository, release/tag, changelog, migration notes, and
   source diff from the installed version to the candidate. Prefer tags and
   commits over blog posts.

3. For Pi, inspect each relevant package separately:
   - `@earendil-works/pi-coding-agent`
   - `@earendil-works/pi-ai`
   - `@earendil-works/pi-tui`
   - `@earendil-works/pi-agent-core` when it is pulled by an integration

   Compare changelogs, public `.d.ts`, event types, session/compaction code,
   and provider contracts.

4. For each bundled extension, inspect its own changelog, peer range, engine
   requirement, release diff, and compatibility claims. A broad peer range is
   evidence of installability, not proof of runtime compatibility.

5. When research spans several repositories, delegate one background research
   agent with a precise inventory and candidate version list. Verify every
   critical claim against source or published metadata before acting on it.

6. Write one evidence report at:

   ```text
   docs/research/bpi-update-YYYY-MM-DD.md
   ```

   Cite URL, version, commit/issue, exact changed contract, affected b-pi
   surface, and confidence. If `docs/` is ignored, keep report local and state
   that in final summary.

Flag these as breaking-change candidates:

- removed or renamed exported types/functions/events;
- changed event result/dispatch semantics;
- changed system-prompt, tool, transcript, session, or compaction carriers;
- changed `AgentSession`/`SessionManager` internals used by an extension;
- provider stream input changes;
- changed default provider/tool behavior;
- changed TUI component methods or fields touched by a prototype patch;
- Node/pnpm/engine changes;
- config migrations or new default UI output;
- peer ranges that exclude the candidate or extension releases that lag it.

Classify each finding:

- **green** — public contract stable and matrix-tested;
- **yellow** — private API, broad peer range, changed default, or missing
  candidate-specific claim; requires isolated matrix;
- **red** — known failure, removed contract, failed matrix, or unresolved
  behavior choice; keep current support range and stop shipping.

**Done when:** report contains a complete package-by-package change table and
all red/yellow findings map to a concrete test, patch, or stop decision.

## 3. Decide update set

Prefer the smallest coherent set:

- update an extension when its release fixes a Pi compatibility issue;
- widen Pi peer ranges only after candidate matrix passes;
- keep exact direct integration versions in `package.json`;
- keep unrelated dependencies pinned;
- update config defaults only when behavior is intentional and documented;
- preserve user config. Add a default only through a documented migration or
  opt-in path; do not silently overwrite user values.

Before editing, produce a short plan:

```text
Pi: current → candidate; peer range: current → new
Integrations: package current → candidate; reason
Fixes: file/test; failure reproduced
Docs: README / CHANGELOG / third-party notices / manifest tests
Matrix: baseline + candidate
Ship: commit message and remote branch
```

Ask user when a red finding, destructive config choice, major version, or
ambiguous default needs a product decision. Continue automatically for a
compatible patch/minor update with green evidence.

**Done when:** target versions, peer range, fixes, config decisions, and test
matrix are explicit before the first source edit.

## 4. Update and fix

1. Update exact integration versions with targeted package-manager commands or
   precise manifest edits. Avoid broad `pnpm update --latest`.

2. Update Pi peer ranges manually when semver `0.x` caret behavior would exclude
   the candidate. Use an explicit bounded range, for example:

   ```json
   ">=0.85.1 <0.88.0"
   ```

3. Regenerate only the needed lockfile entries:

   ```bash
   pnpm install --lockfile-only
   ```

   Review any `minimumReleaseAgeExclude` change. Keep it when the package is
   intentionally adopted before the workspace release-age gate; do not accept
   unrelated lock churn.

4. Reproduce each red/yellow behavior with a focused test before fixing it.
   Apply minimum code needed. Match b-pi's existing reload-safe and duck-typed
   compatibility patterns. Remove only imports/variables made unused by the
   patch.

5. Synchronize the public surface:
   - README prerequisites, integration table, config/default behavior, and
     release instructions;
   - `CHANGELOG.md` under `Unreleased`, or the selected release heading when
     preparing a version;
   - `package.json` version and release tag plan;
   - `THIRD-PARTY-NOTICES.md` exact version and ownership table;
   - manifest/catalog tests and compatibility fixtures.

6. Keep upstream extension fixes upstream when possible. Do not fork or copy
   large upstream implementations into b-pi to hide a dependency problem.

**Done when:** manifest, lockfile, code, tests, and public docs agree; every
source change traces to an evidence row or a failing regression test.

## 5. Verify two matrices

### Baseline

Run against the current supported Pi line and updated integrations:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm pack:check
pnpm smoke
```

### Candidate

Use a temporary copy or isolated worktree. Keep candidate Pi versions out of
the main worktree until the matrix passes:

```bash
tmp=$(mktemp -d)
rsync -a --exclude node_modules --exclude .git ./ "$tmp/"
# In the copy, set Pi peer packages to the exact candidate and install there.
# Keep source and lock changes isolated from the main worktree.
(cd "$tmp" && pnpm install --no-frozen-lockfile && pnpm test && pnpm typecheck && pnpm smoke)
```

Exercise behavior, not only compilation:

- Pi startup print mode and TUI mode;
- banner, footer, custom editor, message renderers, generic tool renderer;
- Codex model → native compaction, no Blackhole OM;
- non-Codex model → Blackhole compaction with OM details;
- both extension registration orders;
- native compaction failure → cancel without Blackhole takeover;
- overflow/retry, manual compaction, `/reload`, `/new`, fork/resume;
- system prompt and tools through changed context/session carriers;
- provider streams/custom providers/OpenCode Go when included in support;
- private prototype patches under streaming and completed-tool rendering.

For every failure, capture exact command, error, package version, and whether
it is b-pi, an integration, or upstream. Fix and rerun the smallest failing
case, then rerun the full matrix.

Run final hygiene:

```bash
git diff --check
pnpm gitleaks:scan  # when gitleaks is installed
```

**Done when:** baseline and candidate matrices pass, or every remaining failure
is an explicit upstream/pre-existing warning excluded from the release; no
unverified compatibility claim remains.

## 6. Ship

Treat this skill's explicit purpose as authorization to commit and push the
completed update. Keep a final safety gate for branch/remote drift and
unrelated files.

1. Inspect final diff:

   ```bash
   git status --short
   git diff --stat
   git diff --check
   git diff -- package.json pnpm-lock.yaml extensions test README.md CHANGELOG.md THIRD-PARTY-NOTICES.md
   ```

2. Stage only intended files. Exclude temporary reports/artifacts unless the
   user requested them tracked. Check staged diff and secrets.

3. Choose conventional commit from actual change:
   - `chore: update pi compatibility and integrations`
   - `fix: ...` when b-pi code changed to repair a regression
   - `docs: ...` for documentation-only changes

4. Commit. Push only to the verified branch and remote:

   ```bash
   git commit -m "<message>"
   git push <remote> <branch>
   git push <remote> "v$version"
   ```

   If branch, remote, upstream, or working tree differs from the baseline, stop
   and ask. If push fails, preserve commit and report exact remote error; do not
   rewrite history or force-push. Do not push a tag unless this run prepared a
   release version.

5. Verify publication:

   ```bash
   git status --short
   git log -1 --oneline
   git ls-remote <remote> refs/heads/<branch> "refs/tags/v$version"
   ```

**Done when:** release commit and annotated tag exist when versioning was part
of the run, push resolves to the intended remote branch/tag, worktree is clean,
and final report names version, tag, changed paths, tests, warnings, commit,
and push result.

## Final report

Return a terse release record:

- Pi candidate and peer range;
- each integration updated and reason;
- fixes applied or upstream fixes consumed;
- baseline/candidate verification results;
- known warnings and deferred risks;
- report path;
- commit hash, release tag when created, and push target.
