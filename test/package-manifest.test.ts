const { test } = require("node:test");
const assert = require("node:assert/strict");
const { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { createRequire } = require("node:module");
const { join, resolve } = require("node:path");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));

const expectedDependencies = {
  "@hypabolic/pi-hypa": "1.2.0",
  "@juicesharp/rpiv-ask-user-question": "2.13.9",
  "@juicesharp/rpiv-btw": "2.13.9",
  "@juicesharp/rpiv-todo": "2.13.9",
  "@ogulcancelik/pi-codex-compaction": "0.1.6",
  "@plannotator/pi-extension": "0.28.26",
  "@tintinweb/pi-subagents": "0.22.0",
  "pi-blackhole": "0.5.15",
};

const expectedPiPeers = {
  "@earendil-works/pi-agent-core": ">=1.2.0 <1.5.0",
  "@earendil-works/pi-ai": ">=1.2.0 <1.5.0",
  "@earendil-works/pi-coding-agent": ">=1.2.0 <1.5.0",
  "@earendil-works/pi-tui": ">=1.2.0 <1.5.0",
};

const expectedPublishFiles = [
  "extensions",
  "assets",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "THIRD-PARTY-NOTICES.md",
];

const expectedManifest = {
  extensions: [
    "./extensions/index.ts",
    "./extensions/compaction/codex-engine.ts",
    "../@hypabolic/pi-hypa/extensions/index.ts",
    "../@plannotator/pi-extension/index.ts",
    "../@tintinweb/pi-subagents/src/index.ts",
    "../@juicesharp/rpiv-ask-user-question/index.ts",
    "../@juicesharp/rpiv-btw/index.ts",
    "../@juicesharp/rpiv-todo/index.ts",
    "./extensions/compaction/blackhole-engine.ts",
  ],
  skills: ["../@plannotator/pi-extension/skills/plannotator/SKILL.md"],
  prompts: ["../@juicesharp/rpiv-btw/prompts/btw-system.txt"],
};

test("compaction engines load through package-local entry points", () => {
  const entries = packageJson.pi.extensions;
  assert.ok(entries.includes("./extensions/compaction/codex-engine.ts"));
  assert.ok(entries.includes("./extensions/compaction/blackhole-engine.ts"));
  assert.ok(
    !entries.some((entry: string) => entry.startsWith("../@ogulcancelik/pi-codex-compaction/") || entry.startsWith("../pi-blackhole/")),
    "sibling paths can load stale versions instead of pinned dependencies",
  );
});

async function withEngineLayout(nested: boolean, check: (load: NodeRequire) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "bpi-engines-"));
  const pkg = join(root, "node_modules", "beautiful-pi");
  const engineDir = join(pkg, "extensions", "compaction");
  try {
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ dependencies: {
      "@ogulcancelik/pi-codex-compaction": "0.1.6",
      "pi-blackhole": "0.5.15",
    } }));
    for (const [name, entry, oldVersion, version] of [
      ["@ogulcancelik/pi-codex-compaction", "index.ts", "0.1.3", "0.1.6"],
      ["pi-blackhole", "dist/index.js", "0.4.3", "0.5.15"],
    ]) {
      const packages = [[join(root, "node_modules", name), oldVersion]];
      if (nested) packages.push([join(pkg, "node_modules", name), version]);
      for (const [dir, installed] of packages) {
        mkdirSync(join(dir, "dist"), { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ version: installed, main: "./dist/index.js" }));
        writeFileSync(join(dir, entry), `module.exports = { default: (pi) => { pi.loadedVersion = ${JSON.stringify(installed)}; return ${JSON.stringify(installed)}; } };\n`);
      }
    }
    for (const engine of ["codex-engine", "blackhole-engine"]) {
      copyFileSync(resolve(__dirname, `../extensions/compaction/${engine}.ts`), join(engineDir, `${engine}.ts`));
    }
    await check(createRequire(join(engineDir, "test.js")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("compaction engines reject stale shared dependencies", async () => {
  await withEngineLayout(false, (load) => {
    for (const engine of ["codex-engine", "blackhole-engine"]) {
      assert.throws(() => load(`./${engine}.ts`), /Compaction dependency version mismatch/);
    }
  });
});

test("compaction engines prefer pinned nested dependencies over stale siblings", async () => {
  await withEngineLayout(true, async (load) => {
    const pi: any = { on() {} };
    load("./codex-engine.ts").default(pi);
    assert.equal(pi.loadedVersion, "0.1.6");
    delete pi.loadedVersion;
    await load("./blackhole-engine.ts").default(pi);
    assert.equal(pi.loadedVersion, "0.5.15");
  });
});

test("package catalog pins selected integrations and resources explicitly", () => {
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.equal(packageJson.bundledDependencies, undefined);
  assert.deepEqual(packageJson.files, expectedPublishFiles);
  assert.deepEqual(packageJson.dependencies, expectedDependencies);
  assert.deepEqual(packageJson.peerDependencies, expectedPiPeers);
  const piDevDependencies = Object.fromEntries(
    Object.entries(packageJson.devDependencies).filter(([name]) =>
      name.startsWith("@earendil-works/pi-"),
    ),
  );
  assert.deepEqual(Object.keys(piDevDependencies).sort(), Object.keys(expectedPiPeers).sort());
  const piDevVersion = packageJson.devDependencies["@earendil-works/pi-coding-agent"];
  assert.equal(typeof piDevVersion, "string");
  assert.ok(Object.values(piDevDependencies).every((version) => version === piDevVersion));
  assert.deepEqual(packageJson.pi, {
    ...expectedManifest,
    image: "https://raw.githubusercontent.com/danielmrdev/beautiful-pi/main/assets/beautiful-pi-screenshot.png",
  });

  for (const entries of Object.values(expectedManifest)) {
    assert.ok(entries.every((entry) => !/[?*{}]/.test(entry)));
  }

  for (const entry of expectedManifest.extensions) {
    if (entry.startsWith("./")) {
      assert.equal(
        existsSync(resolve(__dirname, "../", entry)),
        true,
        `missing package resource: ${entry}`,
      );
    }
  }
});
