import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { VerifyInput, Tier } from "../src/engine/types";
import { scorePackage } from "../src/engine/score.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A single labeled fixture entry.
 * Extends VerifyInput (name + ecosystem) with the expected tier, a
 * human-readable note, and the source that justified the label.
 */
interface FixtureEntry extends VerifyInput {
  expectedTier: Tier;
  note: string;
  source: string;
}

const VALID_TIERS = new Set<string>(["green", "yellow", "red"]);

function loadFixture(path: string): FixtureEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    console.error(`ERROR: Cannot read fixture file: ${path}`);
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`ERROR: Invalid JSON in fixture file: ${path}`);
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error(`ERROR: Fixture is not an array: ${path}`);
    process.exit(1);
  }

  if (data.length === 0) {
    console.error(`ERROR: Fixture is empty: ${path}`);
    process.exit(1);
  }

  const entries: FixtureEntry[] = [];
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown>;
    const bad: string[] = [];

    if (typeof entry["name"] !== "string" || entry["name"] === "")
      bad.push("name");
    if (typeof entry["ecosystem"] !== "string" || entry["ecosystem"] === "")
      bad.push("ecosystem");
    if (
      typeof entry["expectedTier"] !== "string" ||
      !VALID_TIERS.has(entry["expectedTier"])
    )
      bad.push("expectedTier (must be green | yellow | red)");
    if (typeof entry["note"] !== "string" || entry["note"] === "")
      bad.push("note");
    if (typeof entry["source"] !== "string" || entry["source"] === "")
      bad.push("source");

    if (bad.length > 0) {
      console.error(
        `ERROR: Entry [${i}] in ${path} has missing/invalid fields: ${bad.join(", ")}`
      );
      process.exit(1);
    }

    entries.push(entry as unknown as FixtureEntry);
  }

  return entries;
}

const fixturesDir = resolve(__dirname, "fixtures");
const knownGood = loadFixture(resolve(fixturesDir, "known-good.json"));
const knownBad = loadFixture(resolve(fixturesDir, "known-bad.json"));
const hardMiddle = loadFixture(resolve(fixturesDir, "hard-middle.json"));

const allEntries = [...knownGood, ...knownBad, ...hardMiddle];
const total = allEntries.length;

// ── Run scoring ────────────────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

interface ScoredEntry {
  entry: FixtureEntry;
  actualTier: Tier;
  match: boolean;
}

const results: ScoredEntry[] = new Array(total);

console.log("=== torv eval — scoring ===\n");
console.log(`Scoring ${total} fixtures against npm registry…`);

await runWithConcurrency(
  allEntries.map((entry, i) => ({ entry, i })),
  10,
  async ({ entry, i }) => {
    try {
      const verdict = await scorePackage({ name: entry.name, ecosystem: "npm" });
      results[i] = {
        entry,
        actualTier: verdict.tier,
        match: verdict.tier === entry.expectedTier,
      };
    } catch (err) {
      console.error(`  WARN: scorePackage threw for "${entry.name}": ${err}`);
      // Treat scoring errors as mismatches; assign a sentinel tier
      results[i] = {
        entry,
        actualTier: "yellow", // safe default
        match: false,
      };
    }
  }
);

// ── Aggregate results ─────────────────────────────────────────────────────────

const tiers: Tier[] = ["green", "yellow", "red"];

// Per-bucket counts
const bucketTotal: Record<Tier, number> = { green: 0, yellow: 0, red: 0 };
const bucketMatch: Record<Tier, number> = { green: 0, yellow: 0, red: 0 };

// False positives: expected green, got yellow or red
const falsePositives: ScoredEntry[] = [];
// False negatives: expected red, got green or yellow
const falseNegatives: ScoredEntry[] = [];
// Other mismatches (yellow bucket misses)
const otherMismatches: ScoredEntry[] = [];

let totalMatches = 0;

for (const r of results) {
  const expected = r.entry.expectedTier;
  bucketTotal[expected]++;
  if (r.match) {
    bucketMatch[expected]++;
    totalMatches++;
  } else {
    if (expected === "green") {
      falsePositives.push(r);
    } else if (expected === "red") {
      falseNegatives.push(r);
    } else {
      otherMismatches.push(r);
    }
  }
}

const overallPct = (totalMatches / total) * 100;

function pct(n: number, d: number): string {
  if (d === 0) return "N/A";
  return ((n / d) * 100).toFixed(1) + "%";
}

const TOP_N = 5;

// ── Print report ──────────────────────────────────────────────────────────────

console.log("\n=== torv eval — results ===\n");
console.log(`Overall accuracy: ${overallPct.toFixed(1)}%  (${totalMatches}/${total})`);
console.log();
console.log("Per-bucket accuracy:");
for (const tier of tiers) {
  const acc = pct(bucketMatch[tier], bucketTotal[tier]);
  console.log(`  ${tier.padEnd(6)}: ${acc.padStart(7)}  (${bucketMatch[tier]}/${bucketTotal[tier]})`);
}

console.log();
console.log(`False positives (expected green, scored yellow/red): ${falsePositives.length}`);
if (falsePositives.length > 0) {
  const top = falsePositives.slice(0, TOP_N);
  console.log(`  Top ${Math.min(TOP_N, falsePositives.length)}:`);
  for (const r of top) {
    console.log(`    "${r.entry.name}" → got ${r.actualTier} (expected ${r.entry.expectedTier})`);
  }
}

console.log();
console.log(`False negatives (expected red, scored green/yellow): ${falseNegatives.length}`);
if (falseNegatives.length > 0) {
  const top = falseNegatives.slice(0, TOP_N);
  console.log(`  Top ${Math.min(TOP_N, falseNegatives.length)}:`);
  for (const r of top) {
    console.log(`    "${r.entry.name}" → got ${r.actualTier} (expected ${r.entry.expectedTier})`);
  }
}

if (otherMismatches.length > 0) {
  console.log();
  console.log(`Yellow-bucket misses: ${otherMismatches.length}`);
  const top = otherMismatches.slice(0, TOP_N);
  console.log(`  Top ${Math.min(TOP_N, otherMismatches.length)}:`);
  for (const r of top) {
    console.log(`    "${r.entry.name}" → got ${r.actualTier} (expected ${r.entry.expectedTier})`);
  }
}

console.log();
console.log("Eval complete.");
process.exit(0);
