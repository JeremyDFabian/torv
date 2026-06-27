import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegistryMetadata } from "../src/engine/registries/npm.js";

// vi.hoisted creates values before any imports so they can be safely referenced
// inside vi.mock factory closures.
const { mockFetcher, mockGetRegistryFetcher } = vi.hoisted(() => {
  const mockFetcher = vi.fn();
  const mockGetRegistryFetcher = vi.fn(() => mockFetcher);
  return { mockFetcher, mockGetRegistryFetcher };
});

// Mock the registry factory so scorePackage never hits the network for package
// metadata. The signal mocks below give us full numeric control.
vi.mock("../src/engine/registries/index.js", () => ({
  getRegistryFetcher: mockGetRegistryFetcher,
}));

vi.mock("../src/engine/signals/age.js",        () => ({ scoreAge:        vi.fn() }));
vi.mock("../src/engine/signals/adoption.js",   () => ({ scoreAdoption:   vi.fn() }));
vi.mock("../src/engine/signals/registry.js",   () => ({ scoreRegistry:   vi.fn() }));
vi.mock("../src/engine/signals/versions.js",   () => ({ scoreVersions:   vi.fn() }));
vi.mock("../src/engine/signals/conflation.js", () => ({ scoreConflation: vi.fn() }));
vi.mock("../src/engine/signals/grounding.js",  () => ({ scoreGrounding:  vi.fn() }));
vi.mock("../src/engine/signals/recency.js",    () => ({ scoreRecency:    vi.fn() }));
vi.mock("../src/engine/signals/advisory.js",   () => ({ fetchMalwareAdvisory: vi.fn() }));

import { scoreAge }        from "../src/engine/signals/age.js";
import { scoreAdoption }   from "../src/engine/signals/adoption.js";
import { scoreRegistry }   from "../src/engine/signals/registry.js";
import { scoreVersions }   from "../src/engine/signals/versions.js";
import { scoreConflation } from "../src/engine/signals/conflation.js";
import { scoreGrounding }  from "../src/engine/signals/grounding.js";
import { scoreRecency }    from "../src/engine/signals/recency.js";
import { fetchMalwareAdvisory } from "../src/engine/signals/advisory.js";
import { scorePackage }    from "../src/engine/score.js";

const mockScoreAge        = vi.mocked(scoreAge);
const mockScoreAdoption   = vi.mocked(scoreAdoption);
const mockScoreRegistry   = vi.mocked(scoreRegistry);
const mockScoreVersions   = vi.mocked(scoreVersions);
const mockScoreConflation = vi.mocked(scoreConflation);
const mockScoreGrounding  = vi.mocked(scoreGrounding);
const mockScoreRecency    = vi.mocked(scoreRecency);
const mockFetchAdvisory   = vi.mocked(fetchMalwareAdvisory);

/** Metadata for a package with a long track record. */
const richMetadata: RegistryMetadata = {
  exists:          true,
  publishedAt:     new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
  weeklyDownloads: 50_000,
  versionCount:    500,
};

describe("scorePackage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a well-established package, no advisory; heuristics → green.
    mockFetcher.mockResolvedValue(richMetadata);
    mockScoreAge.mockResolvedValue(0.9);
    mockScoreAdoption.mockResolvedValue(0.95);
    mockScoreRegistry.mockResolvedValue(1.0);
    mockScoreVersions.mockResolvedValue(0.95);
    mockScoreConflation.mockReturnValue(0.95);
    mockScoreGrounding.mockResolvedValue(0.95);
    mockScoreRecency.mockReturnValue(0.95);
    mockFetchAdvisory.mockResolvedValue("none");
  });

  /** Set all seven heuristic signal mocks to the same value. */
  function setAllHeuristics(score: number): void {
    mockScoreAge.mockResolvedValue(score);
    mockScoreAdoption.mockResolvedValue(score);
    mockScoreRegistry.mockResolvedValue(score);
    mockScoreVersions.mockResolvedValue(score);
    mockScoreConflation.mockReturnValue(score);
    mockScoreGrounding.mockResolvedValue(score);
    mockScoreRecency.mockReturnValue(score);
  }

  // ---- Ecosystem routing --------------------------------------------------

  describe("ecosystem routing", () => {
    it("calls getRegistryFetcher with the input ecosystem", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(mockGetRegistryFetcher).toHaveBeenCalledWith("npm");
      await scorePackage({ name: "requests", ecosystem: "pypi" });
      expect(mockGetRegistryFetcher).toHaveBeenCalledWith("pypi");
    });

    it("passes the package name to the returned fetcher", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(mockFetcher).toHaveBeenCalledWith("lodash");
    });

    it("queries the advisory database with name and ecosystem", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(mockFetchAdvisory).toHaveBeenCalledWith("lodash", "npm");
    });
  });

  // ---- GATE: documented malware -------------------------------------------

  describe("OSV malware gate", () => {
    it("forces red when OSV reports whole-package malware, even with perfect heuristics", async () => {
      // Every heuristic says 'great' — an aged, popular-looking holding package.
      setAllHeuristics(0.95);
      mockFetchAdvisory.mockResolvedValue("whole-package");
      const verdict = await scorePackage({ name: "crossenv", ecosystem: "npm" });
      expect(verdict.tier).toBe("red");
    });

    it("includes a malware reason and an advisory signal in the verdict", async () => {
      mockFetchAdvisory.mockResolvedValue("whole-package");
      const verdict = await scorePackage({ name: "crossenv", ecosystem: "npm" });
      expect(verdict.signals.some(s => s.signal === "advisory")).toBe(true);
      expect(verdict.reasons.some(r => /malware|malicious/i.test(r))).toBe(true);
    });

    it("the malware gate beats the non-existence gate", async () => {
      // A name that is both absent AND has a malware record → still red (malware reason wins).
      mockFetcher.mockResolvedValue({ exists: false });
      mockFetchAdvisory.mockResolvedValue("whole-package");
      const verdict = await scorePackage({ name: "evil", ecosystem: "npm" });
      expect(verdict.tier).toBe("red");
      expect(verdict.reasons.some(r => /malware|malicious/i.test(r))).toBe(true);
    });
  });

  // ---- GATE: non-existence ------------------------------------------------

  describe("non-existence gate", () => {
    it("forces red when the package does not exist on the registry (404)", async () => {
      mockFetcher.mockResolvedValue({ exists: false });
      mockScoreRegistry.mockResolvedValue(0);
      const verdict = await scorePackage({ name: "totally-made-up-xyzzy", ecosystem: "npm" });
      expect(verdict.tier).toBe("red");
      expect(verdict.reasons.some(r => /not found|does not (exist|resolve)/i.test(r))).toBe(true);
    });
  });

  // ---- GATE: fail-closed on registry failure ------------------------------

  describe("fail-closed: registry returns null", () => {
    beforeEach(() => {
      mockFetcher.mockResolvedValue(null);
    });

    it("returns yellow on a transient registry failure", async () => {
      const verdict = await scorePackage({ name: "unreachable", ecosystem: "npm" });
      expect(verdict.tier).toBe("yellow");
    });

    it("includes the degradation reason", async () => {
      const verdict = await scorePackage({ name: "unreachable", ecosystem: "npm" });
      expect(verdict.reasons.some(r => /cannot verify|defaulting to yellow/i.test(r))).toBe(true);
    });

    it("does not invoke heuristic scorers when the registry is unreachable", async () => {
      await scorePackage({ name: "unreachable", ecosystem: "npm" });
      expect(mockScoreAge).not.toHaveBeenCalled();
      expect(mockScoreVersions).not.toHaveBeenCalled();
    });
  });

  // ---- version-specific advisory (the axios case) -------------------------

  describe("version-specific advisory", () => {
    it("does NOT gate red — an otherwise-good package stays green", async () => {
      // axios: high heuristics, but one past compromised-version advisory.
      mockFetchAdvisory.mockResolvedValue("version-specific");
      const verdict = await scorePackage({ name: "axios", ecosystem: "npm" });
      expect(verdict.tier).toBe("green");
    });

    it("surfaces an informational reason about the flagged versions", async () => {
      mockFetchAdvisory.mockResolvedValue("version-specific");
      const verdict = await scorePackage({ name: "axios", ecosystem: "npm" });
      expect(verdict.reasons.some(r => /version/i.test(r))).toBe(true);
    });
  });

  // ---- advisory fail-open -------------------------------------------------

  describe("advisory fail-open (OSV unreachable)", () => {
    it("falls through to heuristics when the advisory lookup is 'unknown'", async () => {
      mockFetchAdvisory.mockResolvedValue("unknown");
      const verdict = await scorePackage({ name: "lodash", ecosystem: "npm" });
      // Heuristics are all high → green, undisturbed by the OSV outage.
      expect(verdict.tier).toBe("green");
    });
  });

  // ---- Heuristic blend for non-gated packages -----------------------------

  describe("heuristic blend (no gate triggered)", () => {
    it("returns green for a well-established package", async () => {
      const verdict = await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(verdict.tier).toBe("green");
      expect(verdict.name).toBe("lodash");
      expect(verdict.ecosystem).toBe("npm");
    });

    it("returns yellow for a recent package with modest activity", async () => {
      mockScoreAge.mockResolvedValue(0.3);
      mockScoreAdoption.mockResolvedValue(0.3);
      mockScoreVersions.mockResolvedValue(0.5);
      mockScoreRecency.mockReturnValue(0.3);
      // age .3, adoption .3, registry 1, versions .5, conflation .95, grounding .95, recency .3
      // mean ≈ 0.614 → yellow
      const verdict = await scorePackage({ name: "new-modest-pkg", ecosystem: "npm" });
      expect(verdict.tier).toBe("yellow");
    });

    it("blend mean just below 0.3 → red", async () => {
      setAllHeuristics(0.29999);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("red");
    });

    it("blend mean exactly 0.3 → yellow", async () => {
      setAllHeuristics(0.3);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("yellow");
    });

    it("blend mean just below 0.7 → yellow", async () => {
      setAllHeuristics(0.69999);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("yellow");
    });

    it("blend mean exactly 0.7 → green", async () => {
      setAllHeuristics(0.7);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("green");
    });
  });

  // ---- Signal wiring & breakdown ------------------------------------------

  describe("signal wiring", () => {
    it("calls scoreConflation with the package name", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(mockScoreConflation).toHaveBeenCalledWith("lodash");
    });

    it("calls scoreGrounding with the package name, context, and cwd", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm", context: "found in existing repo import" });
      expect(mockScoreGrounding).toHaveBeenCalledWith(
        "lodash",
        "found in existing repo import",
        process.cwd(),
      );
    });

    it("includes all heuristic signals plus the advisory signal in the breakdown", async () => {
      const verdict = await scorePackage({ name: "lodash", ecosystem: "npm" });
      const names = verdict.signals.map(s => s.signal);
      for (const expected of ["advisory", "age", "adoption", "registry", "versions", "conflation", "grounding", "recency"]) {
        expect(names).toContain(expected);
      }
    });

    it("reflects the mocked conflation and grounding scores", async () => {
      mockScoreConflation.mockReturnValue(0.6);
      mockScoreGrounding.mockResolvedValue(0.7);
      const verdict = await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(verdict.signals.find(s => s.signal === "conflation")?.score).toBe(0.6);
      expect(verdict.signals.find(s => s.signal === "grounding")?.score).toBe(0.7);
    });
  });
});
