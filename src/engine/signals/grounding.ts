/**
 * Grounding signal — scores a package based on whether it is already anchored
 * in the local repository.  A package that appears in existing source imports
 * or in the project's lockfile is almost certainly legitimate; one suggested
 * from scratch by an agent with no prior repo presence is more suspicious.
 *
 * Scoring rules (in priority order):
 *   1. Found in existing repo imports or lockfile      → 0.9  (grounded)
 *   2. Context contains "found in existing repo import"→ 0.7  (partially grounded)
 *   3. Context contains "suggested by agent"           → 0.3  (ungrounded, suspicious)
 *   4. No context provided, not found in repo          → 0.5  (unknown, neutral)
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

// File extensions that may contain import/require statements.
const SCANNABLE_EXTENSIONS = new Set([".ts", ".js", ".py"]);

/**
 * Recursively collect all scannable source file paths under `dir`.
 * Skips node_modules and .git to avoid scanning dependency trees.
 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await collectSourceFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && SCANNABLE_EXTENSIONS.has(extname(entry.name))) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Build a regex that matches `packageName` appearing as the specifier in an
 * ES-style import or a CommonJS require call.  The pattern is anchored so that
 * a name like "lodash" does not accidentally match "lodash-fp".
 *
 * Matched forms:
 *   import ... from 'pkg'
 *   import 'pkg'
 *   require('pkg')
 *   require("pkg")
 *
 * The closing delimiter may be a quote (exact match) or a '/' (sub-path import
 * such as 'lodash/cloneDeep').  We do not match relative paths (starting with
 * '.' or '/') because those are not package references.
 */
function buildImportPattern(packageName: string): RegExp {
  // Escape any regex special characters in the package name.
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match 'pkg', 'pkg/', "pkg", "pkg/"
  return new RegExp(`(?:from|require)\\s*\\(?\\s*['"]${escaped}['"/]`);
}

/**
 * Search all .ts/.js/.py files under `repoRoot` for an import or require of
 * `packageName`.  Returns `true` as soon as the first match is found.
 */
export async function findImports(repoRoot: string, packageName: string): Promise<boolean> {
  const pattern = buildImportPattern(packageName);
  const files = await collectSourceFiles(repoRoot);

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(content)) return true;
  }

  return false;
}

/**
 * Check whether `packageName` is listed in package-lock.json or
 * requirements.txt under `repoRoot`.
 *
 * package-lock.json (npm v2/v3): package names appear as top-level keys of the
 * `packages` object in the form "node_modules/<name>", and also as keys of
 * the top-level `dependencies` object.
 *
 * requirements.txt (pip): each non-comment line begins with the package name
 * optionally followed by a version specifier, extras, or environment markers.
 */
export async function findInLockfile(repoRoot: string, packageName: string): Promise<boolean> {
  // ── package-lock.json ──────────────────────────────────────────────────────
  try {
    const lockPath = join(repoRoot, "package-lock.json");
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as {
      packages?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };

    if (lock.packages) {
      // v2/v3 format: keys are "node_modules/pkg" or "" (the root)
      const nodeModulesKey = `node_modules/${packageName}`;
      if (nodeModulesKey in lock.packages) return true;
    }

    if (lock.dependencies && packageName in lock.dependencies) return true;
  } catch {
    // File absent or unparseable — fall through to requirements.txt.
  }

  // ── requirements.txt ──────────────────────────────────────────────────────
  try {
    const reqPath = join(repoRoot, "requirements.txt");
    const raw = await readFile(reqPath, "utf8");
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      // Skip blank lines and comments.
      if (!line || line.startsWith("#")) continue;

      // Extract the package name: everything up to the first version specifier,
      // extra, or environment marker character.
      const match = line.match(/^([A-Za-z0-9_.-]+)/);
      if (match && match[1].toLowerCase() === packageName.toLowerCase()) return true;
    }
  } catch {
    // File absent — no lockfile information available.
  }

  return false;
}

/**
 * Score a package's trustworthiness based on how grounded it is in the local
 * repository.
 *
 * @param packageName - The name of the package to evaluate.
 * @param context     - Optional free-text provenance context from the agent.
 * @param repoRoot    - Optional path to the repository root to scan.
 * @returns A score in [0, 1] where higher means more trustworthy.
 */
export async function scoreGrounding(
  packageName: string,
  context?: string,
  repoRoot?: string,
): Promise<number> {
  // Rule 1: direct evidence from the repo takes highest precedence.
  if (repoRoot) {
    try {
      await stat(repoRoot); // verify the directory exists
      const [inImports, inLockfile] = await Promise.all([
        findImports(repoRoot, packageName),
        findInLockfile(repoRoot, packageName),
      ]);
      if (inImports || inLockfile) return 0.9;
    } catch {
      // repoRoot inaccessible — fall through to context rules.
    }
  }

  // Rule 2 & 3: context-based scoring when repo evidence is absent.
  if (context !== undefined) {
    if (context.includes("found in existing repo import")) return 0.7;
    if (context.includes("suggested by agent")) return 0.3;
  }

  // Rule 4: nothing to go on.
  return 0.5;
}
