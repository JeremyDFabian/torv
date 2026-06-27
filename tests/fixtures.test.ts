import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Tier } from "../src/engine/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = resolve(__dirname, "../eval/fixtures");

const VALID_TIERS = new Set<Tier>(["green", "yellow", "red"]);

interface FixtureEntry {
  name: string;
  ecosystem: string;
  expectedTier: Tier;
  note: string;
  source: string;
}

function loadFixture(filename: string): FixtureEntry[] {
  const raw = readFileSync(resolve(fixturesDir, filename), "utf-8");
  return JSON.parse(raw) as FixtureEntry[];
}

const FIXTURE_FILES = ["known-good.json", "known-bad.json", "hard-middle.json"];

for (const filename of FIXTURE_FILES) {
  describe(`fixture ${filename}`, () => {
    const entries = loadFixture(filename);

    it("is a non-empty array", () => {
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
    });

    it("every entry has a valid expectedTier (green | yellow | red)", () => {
      for (const entry of entries) {
        expect(
          VALID_TIERS.has(entry.expectedTier),
          `"${entry.name}" has invalid tier: "${entry.expectedTier}"`
        ).toBe(true);
      }
    });

    it("every entry has ecosystem npm", () => {
      for (const entry of entries) {
        expect(entry.ecosystem, `"${entry.name}" ecosystem`).toBe("npm");
      }
    });
  });
}
