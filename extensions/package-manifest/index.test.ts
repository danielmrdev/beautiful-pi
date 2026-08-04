const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));

const expectedDependencies = {
  "@ogulcancelik/pi-codex-compaction": "0.1.3",
  "@hypabolic/pi-hypa": "0.1.12",
  "@plannotator/pi-extension": "0.25.1",
  "@tintinweb/pi-subagents": "0.14.3",
  "@juicesharp/rpiv-ask-user-question": "2.4.0",
  "pi-rtk-optimizer": "0.9.0",
  "@juicesharp/rpiv-btw": "2.4.0",
  "pi-blackhole": "0.4.3",
};

const expectedPublishFiles = [
  "extensions",
  "themes",
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
    "../@ogulcancelik/pi-codex-compaction/index.ts",
    "../@hypabolic/pi-hypa/extensions/index.ts",
    "../@plannotator/pi-extension/index.ts",
    "../@tintinweb/pi-subagents/src/index.ts",
    "../@juicesharp/rpiv-ask-user-question/index.ts",
    "../pi-rtk-optimizer/index.ts",
    "../@juicesharp/rpiv-btw/index.ts",
    "../pi-blackhole/dist/index.js",
  ],
  skills: [],
  prompts: ["../@juicesharp/rpiv-btw/prompts/btw-system.txt"],
  themes: ["./themes/tokyo-night.json", "./themes/tokyo-night-nord.json"],
};

test("package catalog pins selected integrations and resources explicitly", () => {
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.equal(packageJson.bundledDependencies, undefined);
  assert.deepEqual(packageJson.files, expectedPublishFiles);
  assert.deepEqual(packageJson.dependencies, expectedDependencies);
  assert.deepEqual(packageJson.pi, {
    ...expectedManifest,
    image: "https://raw.githubusercontent.com/danielmrdev/beautiful-pi/main/assets/beautiful-pi-screenshot.png",
  });

  for (const entries of Object.values(expectedManifest)) {
    assert.ok(entries.every((entry) => !/[?*{}]/.test(entry)));
  }

  for (const entry of [...expectedManifest.extensions, ...expectedManifest.themes]) {
    if (entry.startsWith("./")) {
      assert.equal(
        existsSync(resolve(__dirname, "../../", entry)),
        true,
        `missing package resource: ${entry}`,
      );
    }
  }
});
