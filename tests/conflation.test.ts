import { describe, it, expect } from "vitest";
import {
  levenshtein,
  pairSimilarity,
  bestSimilarity,
  scoreConflation,
  POPULAR_NPM_PACKAGES,
} from "../src/engine/signals/conflation.js";

// ── Levenshtein primitive ──────────────────────────────────────────────────

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("react", "react")).toBe(0);
  });

  it("returns length of b when a is empty", () => {
    expect(levenshtein("", "react")).toBe(5);
  });

  it("returns length of a when b is empty", () => {
    expect(levenshtein("react", "")).toBe(5);
  });

  it("counts a single substitution", () => {
    // 'reakt' differs from 'react' by one substitution (a↔k swap position 3)
    expect(levenshtein("reakt", "react")).toBe(1);
  });

  it("counts a single insertion", () => {
    expect(levenshtein("rreact", "react")).toBe(1);
  });

  it("counts a single deletion", () => {
    expect(levenshtein("reac", "react")).toBe(1);
  });

  it("is symmetric", () => {
    expect(levenshtein("lodash", "loadsh")).toBe(levenshtein("loadsh", "lodash"));
  });
});

// ── pairSimilarity ─────────────────────────────────────────────────────────

describe("pairSimilarity", () => {
  it("returns 1.0 for an exact match", () => {
    expect(pairSimilarity("react", "react")).toBe(1);
  });

  it("returns >= 0.6 for a prefix match with a short suffix", () => {
    // 'react-dom' starts with 'react' + '-dom' (suffix length 4)
    const sim = pairSimilarity("react-dom", "react");
    expect(sim).toBeGreaterThanOrEqual(0.6);
  });

  it("gives a shorter suffix a higher similarity than a longer one", () => {
    const simShort = pairSimilarity("react-dom", "react");       // suffix '-dom' (4)
    const simLong  = pairSimilarity("react-codeshift", "react"); // suffix '-codeshift' (10)
    expect(simShort).toBeGreaterThan(simLong);
  });

  it("does NOT apply prefix boost when no separator follows the popular name", () => {
    // 'reacts' starts with 'react' but the next char 's' is not a separator
    const simLevenshtein = 1 - levenshtein("reacts", "react") / Math.max("reacts".length, "react".length);
    expect(pairSimilarity("reacts", "react")).toBeCloseTo(simLevenshtein, 10);
  });

  it("falls back to Levenshtein similarity for unrelated names", () => {
    // A completely different string should produce low similarity
    expect(pairSimilarity("zzzqqqxxx", "react")).toBeLessThan(0.4);
  });
});

// ── bestSimilarity ─────────────────────────────────────────────────────────

describe("bestSimilarity", () => {
  it("returns the popular package and similarity for a prefix-matched name", () => {
    const result = bestSimilarity("react-codeshift");
    expect(result.matchedPackage).toBe("react");
    // suffix '-codeshift' has length 10; sim = 0.6 + 0.4*(1 - 10/20) = 0.80
    expect(result.similarity).toBeCloseTo(0.80, 5);
  });

  it("identifies the correct popular package for a Levenshtein typo", () => {
    const { matchedPackage, similarity } = bestSimilarity("lodosh");
    expect(matchedPackage).toBe("lodash");
    // levenshtein('lodosh', 'lodash') = 1; sim = 1 - 1/6 ≈ 0.833
    expect(similarity).toBeCloseTo(1 - 1 / 6, 5);
  });

  it("returns similarity < 0.6 for a completely unique name", () => {
    const { similarity } = bestSimilarity("zzz-completely-unique-xyz");
    expect(similarity).toBeLessThan(0.6);
  });
});

// ── scoreConflation — main scenarios ──────────────────────────────────────

describe("scoreConflation", () => {
  // ── High-similarity / low-score: react-codeshift vs react ────────────────

  describe("react-codeshift (prefix of popular 'react')", () => {
    it("reports high similarity to react (>= 0.60)", () => {
      const { similarity } = bestSimilarity("react-codeshift");
      expect(similarity).toBeGreaterThanOrEqual(0.6);
    });

    it("returns a suspicious (low) score", () => {
      // similarity = 0.80 → falls in the 0.80–0.95 band → score 0.3
      expect(scoreConflation("react-codeshift")).toBe(0.3);
    });

    it("score is below 0.5 (clearly suspicious)", () => {
      expect(scoreConflation("react-codeshift")).toBeLessThan(0.5);
    });
  });

  // ── Moderate signal: lodash-fetch-middleware vs lodash ───────────────────

  describe("lodash-fetch-middleware (long suffix of popular 'lodash')", () => {
    it("reports moderate similarity to lodash (>= 0.6 but < 0.8)", () => {
      const { similarity, matchedPackage } = bestSimilarity("lodash-fetch-middleware");
      expect(matchedPackage).toBe("lodash");
      // suffix '-fetch-middleware' has length 17; sim = 0.6 + 0.4*(1 - 17/20) ≈ 0.66
      expect(similarity).toBeGreaterThanOrEqual(0.6);
      expect(similarity).toBeLessThan(0.8);
    });

    it("returns a moderate score of 0.6", () => {
      expect(scoreConflation("lodash-fetch-middleware")).toBe(0.6);
    });
  });

  // ── Unique name: no popular package similarity ────────────────────────────

  describe("zzz-completely-unique-xyz (no popular package match)", () => {
    it("reports low similarity (< 0.6) to all popular packages", () => {
      const { similarity } = bestSimilarity("zzz-completely-unique-xyz");
      expect(similarity).toBeLessThan(0.6);
    });

    it("returns the maximum-trust score of 1.0", () => {
      expect(scoreConflation("zzz-completely-unique-xyz")).toBe(1.0);
    });
  });

  // ── Exact match to a popular package ─────────────────────────────────────

  describe("exact popular package name", () => {
    it("exact 'react' has similarity 1.0 and is NOT penalized — it IS that package, score 1.0", () => {
      // A name identical to a popular package is the real package, not a squat.
      // Penalizing it (the old behavior) wrongly flagged chalk/axios/commander.
      const { similarity } = bestSimilarity("react");
      expect(similarity).toBe(1);
      expect(scoreConflation("react")).toBe(1.0);
    });

    it("does not penalize other exact popular names (chalk, axios, commander)", () => {
      expect(scoreConflation("chalk")).toBe(1.0);
      expect(scoreConflation("axios")).toBe(1.0);
      expect(scoreConflation("commander")).toBe(1.0);
    });

    it("still flags a near-clone that is NOT exactly a popular name", () => {
      // 'reactt' is 0.95+ similar to 'react' but not identical → still suspicious.
      expect(scoreConflation("reactt")).toBeLessThan(0.5);
    });
  });

  // ── Near-exact Levenshtein typos ──────────────────────────────────────────

  describe("single-character typos", () => {
    it("'reakt' (1-char substitution) → similarity ~0.8 → score 0.3", () => {
      const { similarity } = bestSimilarity("reakt");
      // levenshtein('reakt','react') = 1; sim = 1 - 1/5 = 0.8
      expect(similarity).toBeCloseTo(0.8, 5);
      expect(scoreConflation("reakt")).toBe(0.3);
    });

    it("'rreact' (1-char insertion) → similarity ~0.833 → score 0.3", () => {
      const { similarity } = bestSimilarity("rreact");
      expect(similarity).toBeGreaterThan(0.8);
      expect(scoreConflation("rreact")).toBe(0.3);
    });
  });

  // ── Case-insensitivity ────────────────────────────────────────────────────

  describe("case insensitivity", () => {
    it("'React-CodeShift' is treated the same as 'react-codeshift'", () => {
      expect(scoreConflation("React-CodeShift")).toBe(scoreConflation("react-codeshift"));
    });
  });

  // ── Score range invariant ─────────────────────────────────────────────────

  describe("score is always in [0, 1]", () => {
    const sampleNames = [
      "react", "react-dom", "react-codeshift",
      "lodash", "lodash-fetch-middleware",
      "completely-unique-package-zxqvf",
      "xss", "d", "aaaaaaaaaaaaaaaaaaaaaa",
    ];

    for (const name of sampleNames) {
      it(`scoreConflation("${name}") is in [0, 1]`, () => {
        const score = scoreConflation(name);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      });
    }
  });

  // ── Popular package list sanity ───────────────────────────────────────────

  describe("POPULAR_NPM_PACKAGES list", () => {
    it("contains at least 50 entries", () => {
      expect(POPULAR_NPM_PACKAGES.length).toBeGreaterThanOrEqual(50);
    });

    it("contains no duplicate entries", () => {
      const unique = new Set(POPULAR_NPM_PACKAGES);
      expect(unique.size).toBe(POPULAR_NPM_PACKAGES.length);
    });

    it("contains 'react', 'lodash', and 'express'", () => {
      expect(POPULAR_NPM_PACKAGES).toContain("react");
      expect(POPULAR_NPM_PACKAGES).toContain("lodash");
      expect(POPULAR_NPM_PACKAGES).toContain("express");
    });
  });
});
