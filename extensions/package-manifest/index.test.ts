import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
);

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
  assert.ok(packageJson.files.includes("THIRD-PARTY-NOTICES.md"));
  assert.deepEqual(packageJson.dependencies, expectedDependencies);
  assert.deepEqual(packageJson.pi, {
    ...expectedManifest,
    image: "https://raw.githubusercontent.com/danielmrdev/beautiful-pi/main/assets/beautiful-pi-screenshot.png",
  });

  for (const entries of Object.values(expectedManifest)) {
    assert.ok(entries.every((entry) => !/[?*{}]/.test(entry)));
  }
});
