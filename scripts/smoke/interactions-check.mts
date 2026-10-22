import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import "../../test/setup.mjs";

const [installedDir] = process.argv.slice(2);
if (!installedDir) {
  console.error("usage: interactions-check.mts <installed-beautiful-pi-dir>");
  process.exit(2);
}

const fromPackage = createRequire(join(installedDir, "package.json"));
const [btw, todo, helpers] = await Promise.all([
  import(pathToFileURL(fromPackage.resolve("@juicesharp/rpiv-btw/index.ts")).href),
  import(pathToFileURL(fromPackage.resolve("@juicesharp/rpiv-todo/index.ts")).href),
  import(pathToFileURL(join(installedDir, "extensions/test-helpers.ts")).href),
]);

const pi = helpers.fakePi();
btw.default(pi);
todo.default(pi);

assert.ok(pi.commands.has("btw"), "/btw command registered");
assert.ok(pi.commands.has("todos"), "/todos command registered");
assert.ok(pi.toolRegistrations.has("todo"), "todo tool registered");
console.log("✓ bundled /btw, /todos, and todo tool register");
