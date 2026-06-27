import { describe, it, expect } from "vitest";
import type { Verdict, Tier } from "../src/engine/types.js";

describe("Verdict contract", () => {
  it("constructs a valid Verdict and typechecks", () => {
    const verdict: Verdict = {
      name: "express",
      ecosystem: "npm",
      tier: "green",
      signals: [
        { signal: "registry-age", score: 0.95, reason: "Package published 12 years ago" },
        { signal: "download-volume", score: 0.98, reason: "Over 100M weekly downloads" },
      ],
      reasons: ["Well-established package with long history and high adoption."],
    };

    const validTiers: Tier[] = ["green", "yellow", "red"];
    expect(validTiers).toContain(verdict.tier);
    expect(Array.isArray(verdict.signals)).toBe(true);
    expect(verdict.signals.length).toBeGreaterThan(0);

    // Each signal score must be in [0, 1]
    for (const s of verdict.signals) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  });

  it("constructs a red Verdict for a suspicious package", () => {
    const verdict: Verdict = {
      name: "expresss",
      ecosystem: "npm",
      tier: "red",
      signals: [
        { signal: "registry-age", score: 0.02, reason: "Package published 1 day ago" },
        { signal: "download-volume", score: 0.01, reason: "Fewer than 10 downloads" },
      ],
      reasons: ["Newly published package with near-zero adoption — likely squatted name."],
    };

    expect(verdict.tier).toBe("red");
    expect(verdict.signals).toHaveLength(2);
  });

  it("constructs a yellow Verdict for an uncertain package", () => {
    const verdict: Verdict = {
      name: "some-internal-lib",
      ecosystem: "npm",
      tier: "yellow",
      signals: [
        { signal: "registry-age", score: 0.5, reason: "Registry lookup failed — defaulting to uncertain" },
      ],
      reasons: ["Could not verify package — treating as unverified (fail-closed)."],
    };

    expect(verdict.tier).toBe("yellow");
    expect(verdict.ecosystem).toBe("npm");
  });
});
