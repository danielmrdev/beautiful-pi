/**
 * Universal module resolution patch for CJS require() failing on
 * packages that have ESM-only "exports" fields (missing "require" condition).
 *
 * When tsx transpiles `import` to CJS `require()`, Node's CJS resolver
 * can't match "import" conditions in the exports map, raising:
 *   ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined
 *
 * This hook intercepts Module._resolveFilename and, when the error is
 * about missing exports, attempts to resolve by:
 *   1. Reading package.json from the package directory (walking up from parent)
 *   2. Looking for a valid entry point via: exports.import -> dist/index.js -> main
 *
 * Inspired by https://github.com/nicepkg/require-add-exports
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const _require = createRequire(import.meta.url);
const Module = _require("module");
const origResolveFilename = Module._resolveFilename;
const origFindPath = Module._findPath;

/**
 * Try to resolve a package entry point by walking the file system.
 */
function resolvePackageEntry(packageDir, subpath) {
  let realDir;
  try {
    realDir = realpathSync(packageDir);
  } catch {
    return null;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(realDir, "package.json"), "utf-8"));
  } catch {
    return null;
  }

  // If subpath, try the subpath against exports or dist directory
  if (subpath) {
    // 1. Try dist/<subpath>.js
    const distJs = join(realDir, "dist", subpath + ".js");
    if (existsSync(distJs)) return distJs;

    // 2. Try dist/<subpath>/index.js
    const distIndex = join(realDir, "dist", subpath, "index.js");
    if (existsSync(distIndex)) return distIndex;

    // 3. Check exports for matching subpath
    if (pkg.exports && typeof pkg.exports === "object") {
      const subExport = pkg.exports["./" + subpath];
      if (subExport) {
        const importTarget = subExport.import || subExport.default || subExport;
        if (typeof importTarget === "string") {
          const candidate = join(realDir, importTarget);
          if (existsSync(candidate)) return candidate;
        }
      }
    }

    return null;
  }

  // No subpath - resolve main entry
  // 1. Try exports["."].import
  if (pkg.exports?.["."]?.import) {
    const candidate = join(realDir, pkg.exports["."].import);
    if (existsSync(candidate)) return candidate;
  }

  // 2. Try exports["."].default
  if (pkg.exports?.["."]?.default) {
    const candidate = join(realDir, pkg.exports["."].default);
    if (existsSync(candidate)) return candidate;
  }

  // 3. Try "main" field
  if (pkg.main) {
    const candidate = join(realDir, pkg.main);
    if (existsSync(candidate)) return candidate;
  }

  // 4. Try dist/index.js
  const distIndex = join(realDir, "dist", "index.js");
  if (existsSync(distIndex)) return distIndex;

  // 5. Try index.js
  const indexJs = join(realDir, "index.js");
  if (existsSync(indexJs)) return indexJs;

  return null;
}

/**
 * Extract package name and optional subpath from a bare specifier.
 * e.g. "@scope/name/sub" => { name: "@scope/name", subpath: "sub" }
 *       "bare-name/sub"   => { name: "bare-name", subpath: "sub" }
 */
function parseBareSpecifier(request) {
  if (request.startsWith("@")) {
    // Scoped package: @scope/name[/subpath]
    const firstSlash = request.indexOf("/");
    const secondSlash = request.indexOf("/", firstSlash + 1);
    if (secondSlash === -1) {
      return { name: request, subpath: null };
    }
    return {
      name: request.slice(0, secondSlash),
      subpath: request.slice(secondSlash + 1),
    };
  }
  // Non-scoped: name[/subpath]
  const slash = request.indexOf("/");
  if (slash === -1) {
    return { name: request, subpath: null };
  }
  return {
    name: request.slice(0, slash),
    subpath: request.slice(slash + 1),
  };
}

/**
 * Walk up from parent to find the node_modules directory containing a package.
 */
function findPackageDir(packageName, parentDir) {
  let dir = parentDir;
  while (true) {
    const candidate = resolve(dir, "node_modules", packageName);
    if (existsSync(candidate)) {
      try {
        const stats = statSync(candidate);
        if (stats.isDirectory()) {
          const pkgJson = join(candidate, "package.json");
          if (existsSync(pkgJson)) return candidate;
        }
      } catch {
        // skip
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Patch Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  // Try original resolution first
  try {
    return origResolveFilename.call(this, request, parent, isMain, options);
  } catch (err) {
    if (err?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw err;
  }

  // Only handle bare specifiers (not relative, absolute, or built-in)
  if (
    request.startsWith(".") ||
    request.startsWith("/") ||
    request.startsWith("node:") ||
    request === "module"
  ) {
    throw err;
  }

  const parsed = parseBareSpecifier(request);
  const parentDir = parent
    ? dirname(parent.filename || parent.path || "")
    : process.cwd();

  const pkgDir = findPackageDir(parsed.name, parentDir);
  if (!pkgDir) throw err;

  const resolved = resolvePackageEntry(pkgDir, parsed.subpath);
  if (resolved) return resolved;

  throw err;
};
