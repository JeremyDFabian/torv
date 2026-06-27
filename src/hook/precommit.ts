/**
 * Pre-commit hook engine for torv.
 *
 * Parses staged dependency files, computes which packages are NEW relative to
 * HEAD, scores each new package via the engine, and decides whether to block
 * the commit.
 *
 * Exit contract (returned integer from runHook):
 *   0 — allow commit (all green, or all reds are allowlisted)
 *   1 — block commit (at least one red package is not in the allowlist)
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { resolve, relative, basename } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { scorePackage } from "../engine/score.js";
import type { Ecosystem, Verdict } from "../engine/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single dependency extracted from a manifest file. */
export interface Dep {
  name: string;
  /** Declared version string (e.g. "^4.17.21", "==2.28.0"). Empty when unspecified. */
  version: string;
  ecosystem: Ecosystem;
}

/** Dependencies bucketed by their scored tier. */
export interface ScoredBuckets {
  red: Verdict[];
  yellow: Verdict[];
  green: Verdict[];
}

// ---------------------------------------------------------------------------
// Internal content parsers
//
// These operate on raw string content so they can be reused when parsing HEAD
// versions fetched from git, in addition to parsing files on disk.
// ---------------------------------------------------------------------------

function parsePackageJsonContent(content: string): Dep[] {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("package.json root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const deps: Dep[] = [];

  for (const section of ["dependencies", "devDependencies"] as const) {
    const block = obj[section];
    if (block === undefined || block === null) continue;
    if (typeof block !== "object" || Array.isArray(block)) {
      throw new TypeError(`package.json "${section}" must be an object`);
    }
    for (const [name, version] of Object.entries(
      block as Record<string, unknown>,
    )) {
      deps.push({ name, version: String(version), ecosystem: "npm" });
    }
  }

  return deps;
}

function parseRequirementsTxtContent(content: string): Dep[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      // A package name runs up to the first specifier character or whitespace.
      const nameMatch = line.match(/^([A-Za-z0-9_.-]+)/);
      if (!nameMatch) return [];
      const name = nameMatch[1];
      // Extract pinned version from == specifier if present.
      const versionMatch = line.match(/==([^\s;[,]+)/);
      const version = versionMatch ? versionMatch[1] : "";
      return [{ name, version, ecosystem: "pypi" as Ecosystem }];
    });
}

/**
 * Minimal parser for pyproject.toml [project].dependencies arrays.
 *
 * Handles the PEP 508 inline array format used by most modern Python projects.
 * Does not require an external TOML library; relies on the fact that
 * dependency entries are one string literal per line inside the brackets.
 */
function parsePyprojectTomlContent(content: string): Dep[] {
  const deps: Dep[] = [];
  let inDeps = false;
  let bracketDepth = 0;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Detect the start of a dependencies array: `dependencies = [` or `dependencies=[`
    if (/^dependencies\s*=\s*\[/.test(line)) {
      inDeps = true;
      bracketDepth = 1;
      // Handle single-line arrays: dependencies = ["pkg"]
      const afterBracket = line.slice(line.indexOf("[") + 1);
      for (const chunk of afterBracket.split(",")) {
        const depMatch = chunk.match(/["']([A-Za-z0-9_.-]+)/);
        if (depMatch) {
          const name = depMatch[1];
          const versionMatch = chunk.match(/==([^\s;[,"']+)/);
          deps.push({
            name,
            version: versionMatch ? versionMatch[1] : "",
            ecosystem: "pypi",
          });
        }
      }
      if (afterBracket.includes("]")) inDeps = false;
      continue;
    }

    if (!inDeps) continue;

    bracketDepth += (line.match(/\[/g) ?? []).length;
    bracketDepth -= (line.match(/\]/g) ?? []).length;

    if (bracketDepth <= 0) {
      inDeps = false;
      continue;
    }

    const depMatch = line.match(/["']([A-Za-z0-9_.-]+)/);
    if (depMatch) {
      const name = depMatch[1];
      const versionMatch = line.match(/==([^\s;[,"']+)/);
      deps.push({
        name,
        version: versionMatch ? versionMatch[1] : "",
        ecosystem: "pypi",
      });
    }
  }

  return deps;
}

/** Dispatches to the correct content parser based on filename. */
function parseContentForFilename(filename: string, content: string): Dep[] {
  if (filename === "package.json") return parsePackageJsonContent(content);
  if (filename === "requirements.txt") return parseRequirementsTxtContent(content);
  if (filename === "pyproject.toml") return parsePyprojectTomlContent(content);
  return [];
}

// ---------------------------------------------------------------------------
// Public path-based parsers
// ---------------------------------------------------------------------------

/**
 * Reads package.json at filePath and returns all dependencies with version
 * strings preserved (e.g. "^4.17.21").
 */
export function parsePackageJson(filePath: string): Dep[] {
  const content = readFileSync(filePath, "utf-8");
  return parsePackageJsonContent(content);
}

/**
 * Reads requirements.txt at filePath and returns all packages with version
 * strings captured from == specifiers (empty string when unpinned).
 */
export function parseRequirementsTxt(filePath: string): Dep[] {
  const content = readFileSync(filePath, "utf-8");
  return parseRequirementsTxtContent(content);
}

/**
 * Reads pyproject.toml at filePath and returns deps from [project].dependencies.
 */
export function parsePyprojectToml(filePath: string): Dep[] {
  const content = readFileSync(filePath, "utf-8");
  return parsePyprojectTomlContent(content);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Returns the UTF-8 content of filePath at the HEAD revision, or null if the
 * file does not exist in HEAD (new file, or outside any git repo).
 */
export function gitShowHead(absPath: string): string | null {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const relPath = relative(gitRoot, absPath);
    // Use object notation (HEAD:path) which is safe for paths with spaces.
    return execSync(`git show "HEAD:${relPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getDiff — detect NEW dependencies in a staged file
// ---------------------------------------------------------------------------

/**
 * Compares the staged version of a dependency file against the HEAD version
 * and returns only the packages that are NEW (added or not present in HEAD).
 *
 * If the file does not exist in HEAD (newly added), every dependency is new.
 * Unrecognised file types return an empty array.
 */
export async function getDiff(stagedPath: string): Promise<Dep[]> {
  const absPath = resolve(stagedPath);
  const filename = basename(absPath);

  // Read the current (staged/working-tree) content.
  let stagedContent: string;
  try {
    stagedContent = readFileSync(absPath, "utf-8");
  } catch {
    return [];
  }

  const stagedDeps = parseContentForFilename(filename, stagedContent);
  if (stagedDeps.length === 0) return [];

  const headContent = gitShowHead(absPath);

  // Newly added file — every dependency is new.
  if (headContent === null) return stagedDeps;

  // Parse HEAD deps; on parse error treat all staged deps as new.
  let headDeps: Dep[];
  try {
    headDeps = parseContentForFilename(filename, headContent);
  } catch {
    return stagedDeps;
  }

  const headNames = new Set(headDeps.map((d) => d.name));

  return stagedDeps.filter((d) => !headNames.has(d.name));
}

// ---------------------------------------------------------------------------
// scoreNewDeps — score and bucket a list of deps
// ---------------------------------------------------------------------------

/**
 * Scores each dependency in parallel and groups the results into red / yellow
 * / green buckets.
 */
export async function scoreNewDeps(deps: Dep[]): Promise<ScoredBuckets> {
  const verdicts = await Promise.all(
    deps.map((dep) => scorePackage({ name: dep.name, ecosystem: dep.ecosystem })),
  );

  return {
    red:    verdicts.filter((v) => v.tier === "red"),
    yellow: verdicts.filter((v) => v.tier === "yellow"),
    green:  verdicts.filter((v) => v.tier === "green"),
  };
}

// ---------------------------------------------------------------------------
// Allowlist and override audit trail
//
// Strategy:
//   .torv-allowlist.json is committed to the repository.  It lists packages
//   whose red rating has been reviewed and deliberately accepted by the team.
//   Adding a package here is a conscious, code-reviewed decision — it must
//   carry a human-readable "reason" at the file level.
//
//   .torv-overrides is NOT committed (see .gitignore).  It is an append-only
//   log written at hook-run time: every time a commit is allowed through
//   because a red package was in the allowlist, a timestamped JSON record is
//   appended here.  This gives ops teams an audit trail of "who allowed what,
//   and when" without polluting git history with ephemeral machine-generated
//   data.  The two files together answer two different questions:
//     - "What did we decide to allow?"  → .torv-allowlist.json (git blame-able)
//     - "When was that decision exercised?"  → .torv-overrides (local audit log)
// ---------------------------------------------------------------------------

/**
 * Reads the JSON allowlist at `allowlistPath` and returns the
 * `allowedRedPackages` array.  Returns an empty array when the file is absent
 * or cannot be parsed — callers must treat a missing allowlist as
 * "nothing is allowed" rather than "everything is allowed".
 */
export function loadAllowlist(allowlistPath: string): string[] {
  if (!existsSync(allowlistPath)) return [];
  try {
    const raw = readFileSync(allowlistPath, "utf-8");
    const parsed = JSON.parse(raw) as { allowedRedPackages?: unknown };
    return Array.isArray(parsed.allowedRedPackages)
      ? (parsed.allowedRedPackages as string[])
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Override audit log
// ---------------------------------------------------------------------------

/**
 * Appends one newline-delimited JSON record to the .torv-overrides log.
 *
 * The file is intentionally NOT committed (it is listed in .gitignore).
 * Each record captures the full context of a single allowlist override so
 * that a security audit can reconstruct which commits introduced red packages
 * without needing to re-run scoring.
 */
function logOverride(verdict: Verdict): void {
  const entry =
    JSON.stringify({
      timestamp:  new Date().toISOString(),
      package:    verdict.name,
      tier:       verdict.tier,
      reason:     verdict.reasons.join("; "),
      approvedBy: "user",
    }) + "\n";
  appendFileSync(".torv-overrides", entry, "utf-8");
}

// ---------------------------------------------------------------------------
// runHook — main orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the full pre-commit check over a list of staged dependency files.
 *
 * @param stagedFiles  Absolute or relative paths to the staged manifest files.
 * @param allowlistPath  Path to the JSON allowlist
 *                       (`{ "allowedRedPackages": [...], "reason": "..." }`).
 *                       Non-existent file is treated as an empty list.
 * @returns 0 to allow the commit, 1 to block it.
 */
export async function runHook(
  stagedFiles: string[],
  allowlistPath: string,
): Promise<number> {
  const allowlist = new Set(loadAllowlist(allowlistPath));
  const supported = new Set(["package.json", "requirements.txt", "pyproject.toml"]);

  const allRed: Verdict[] = [];
  const allYellow: Verdict[] = [];
  const allGreen: Verdict[] = [];

  for (const file of stagedFiles) {
    if (!supported.has(basename(file))) continue;

    let newDeps: Dep[];
    try {
      newDeps = await getDiff(file);
    } catch {
      continue;
    }

    if (newDeps.length === 0) continue;

    const { red, yellow, green } = await scoreNewDeps(newDeps);
    allRed.push(...red);
    allYellow.push(...yellow);
    allGreen.push(...green);
  }

  // Report green packages — informational, never blocks.
  for (const v of allGreen) {
    console.log(`${v.name}: green`);
  }

  // Warn about yellow packages — fail-open, do not block the commit.
  for (const v of allYellow) {
    console.warn(
      `torv: WARN  ${v.name} (${v.ecosystem}): yellow — ${v.reasons.join("; ")}`,
    );
  }

  // Partition red packages into blocked vs. allowlisted.
  const blockedReds: Verdict[] = [];
  for (const v of allRed) {
    if (allowlist.has(v.name)) {
      logOverride(v);
      console.warn(
        `torv: OVERRIDE ${v.name} is allowlisted — override logged to .torv-overrides`,
      );
    } else {
      blockedReds.push(v);
    }
  }

  if (blockedReds.length > 0) {
    console.error(
      `\ntorv: BLOCKED — ${blockedReds.length} red package(s) in staged files`,
    );
    for (const v of blockedReds) {
      console.error(`  ${v.name} (${v.ecosystem}): red`);
      for (const s of v.signals) {
        console.error(`    ${s.signal}: ${s.score.toFixed(2)} — ${s.reason}`);
      }
    }
    console.error(
      `\nAdd the package name(s) to the "allowedRedPackages" array in ${allowlistPath} to override.\n`,
    );
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry point (when invoked directly as node dist/hook/precommit.js)
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  // Collect staged dependency files.  If paths are supplied as argv they are
  // used directly (useful for testing and manual invocation).  Otherwise the
  // hook queries git for the files that are currently staged.
  let stagedFiles = process.argv.slice(2);

  if (stagedFiles.length === 0) {
    try {
      const raw = execSync(
        "git diff --cached --name-only --diff-filter=ACM",
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      stagedFiles = raw
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
    } catch {
      // Not inside a git repo, or no staged files — nothing to check.
      process.exit(0);
    }
  }

  const allowlistPath = resolve(process.cwd(), ".torv-allowlist.json");
  const exitCode = await runHook(stagedFiles, allowlistPath);
  process.exit(exitCode);
}
