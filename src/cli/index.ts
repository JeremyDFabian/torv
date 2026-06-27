/**
 * torv CLI — verify dependencies listed in a package.json or requirements.txt.
 *
 * Usage:
 *   torv <path/to/package.json>
 *   torv <path/to/requirements.txt>
 *
 * Exit codes:
 *   0 — scan completed (table output shows per-package verdicts; caller inspects reds)
 *   1 — file not found, unreadable, or unparseable
 */

import { readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { fileURLToPath } from "url";
import { scorePackage } from "../engine/score.js";
import type { Ecosystem, Verdict } from "../engine/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Dependency {
  name: string;
  ecosystem: Ecosystem;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Extract package names from package.json dependencies and devDependencies.
 * All packages are tagged as npm ecosystem.
 *
 * Throws SyntaxError if the content is not valid JSON.
 * Throws TypeError if the parsed value is not an object.
 */
export function parsePackageJson(content: string): Dependency[] {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("package.json root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const deps: Dependency[] = [];

  for (const section of ["dependencies", "devDependencies"] as const) {
    const block = obj[section];
    if (block === undefined || block === null) continue;
    if (typeof block !== "object" || Array.isArray(block)) {
      throw new TypeError(`package.json "${section}" must be an object`);
    }
    for (const name of Object.keys(block as Record<string, unknown>)) {
      deps.push({ name, ecosystem: "npm" });
    }
  }

  return deps;
}

/**
 * Extract package names from a requirements.txt file.
 * Handles the most common specifier formats: ==, >=, <=, !=, ~=, >, <
 * Skips blank lines and comments (lines starting with #).
 * All packages are tagged as pypi ecosystem.
 */
export function parseRequirementsTxt(content: string): Dependency[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      // Strip version specifiers, extras, environment markers, and options.
      // A package name runs up to the first specifier char or whitespace.
      const name = line.split(/[=<>!~;[\s]/)[0].trim();
      return name;
    })
    .filter((name) => name.length > 0)
    .map((name) => ({ name, ecosystem: "pypi" as Ecosystem }));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Print a left-aligned table of verdicts.
 * All columns except REASONS are padded to their maximum content width.
 */
function printTable(verdicts: Verdict[]): void {
  if (verdicts.length === 0) return;

  const headers = ["NAME", "ECOSYSTEM", "TIER", "REASONS"] as const;
  const rows: string[][] = verdicts.map((v) => [
    v.name,
    v.ecosystem,
    v.tier,
    v.reasons.join(", "),
  ]);

  // Column widths for the first three fixed-width columns only.
  const fixedCount = headers.length - 1;
  const colWidths: number[] = Array.from({ length: fixedCount }, (_, i) =>
    Math.max(
      headers[i].length,
      ...rows.map((r) => r[i].length),
    )
  );

  const GAP = 2;

  function formatRow(cols: string[]): string {
    const fixed = cols
      .slice(0, fixedCount)
      .map((cell, i) => cell.padEnd(colWidths[i] + GAP));
    return fixed.join("") + cols[fixedCount];
  }

  console.log(formatRow([...headers]));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

// ---------------------------------------------------------------------------
// Core runner (exported for programmatic / test use)
// ---------------------------------------------------------------------------

/**
 * Run the torv CLI against a single dependency file.
 *
 * Returns 0 on a successful scan (even when red packages are found) and 1 if
 * the file cannot be read or parsed.
 */
export async function runCli(filepath: string): Promise<number> {
  const absPath = resolve(filepath);

  if (!existsSync(absPath)) {
    console.error(`torv: file not found: ${absPath}`);
    return 1;
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`torv: cannot read ${absPath}: ${msg}`);
    return 1;
  }

  let deps: Dependency[];
  const filename = basename(absPath);

  try {
    if (filename === "package.json") {
      deps = parsePackageJson(content);
    } else if (filename === "requirements.txt") {
      deps = parseRequirementsTxt(content);
    } else {
      console.error(
        `torv: unsupported file "${filename}" — expected package.json or requirements.txt`,
      );
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`torv: cannot parse ${filename}: ${msg}`);
    return 1;
  }

  if (deps.length === 0) {
    console.log("No dependencies found.");
    return 0;
  }

  const verdicts = await Promise.all(deps.map((dep) => scorePackage(dep)));

  printTable(verdicts);

  const green = verdicts.filter((v) => v.tier === "green").length;
  const yellow = verdicts.filter((v) => v.tier === "yellow").length;
  const red = verdicts.filter((v) => v.tier === "red").length;

  console.log(`\n${green} green, ${yellow} yellow, ${red} red`);

  return 0;
}

// ---------------------------------------------------------------------------
// Entry point (only when run directly as node dist/cli/index.js)
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const filepath = process.argv[2];

  if (!filepath) {
    console.error("Usage: torv <package.json|requirements.txt>");
    process.exit(1);
  }

  const exitCode = await runCli(filepath);
  process.exit(exitCode);
}
