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
// metadata.  The signal mocks below give us full numeric control for threshold
// tests without any real fetch calls.
vi.mock("../src/engine/registries/index.js", () => ({
  getRegistryFetcher: mockGetRegistryFetcher,
}));

vi.mock("../src/engine/signals/age.js",      () => ({ scoreAge:      vi.fn() }));
vi.mock("../src/engine/signals/adoption.js",  () => ({ scoreAdoption:  vi.fn() }));
vi.mock("../src/engine/signals/registry.js",  () => ({ scoreRegistry:  vi.fn() }));
vi.mock("../src/engine/signals/versions.js",  () => ({ scoreVersions:  vi.fn() }));

import { scoreAge }      from "../src/engine/signals/age.js";
import { scoreAdoption } from "../src/engine/signals/adoption.js";
import { scoreRegistry } from "../src/engine/signals/registry.js";
import { scoreVersions } from "../src/engine/signals/versions.js";
import { scorePackage }  from "../src/engine/score.js";

const mockScoreAge      = vi.mocked(scoreAge);
const mockScoreAdoption = vi.mocked(scoreAdoption);
const mockScoreRegistry = vi.mocked(scoreRegistry);
const mockScoreVersions = vi.mocked(scoreVersions);

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
    // Default fetcher returns a well-established package; signals produce green.
    mockFetcher.mockResolvedValue(richMetadata);
    mockScoreAge.mockResolvedValue(0.9);
    mockScoreAdoption.mockResolvedValue(0.95);
    mockScoreRegistry.mockResolvedValue(1.0);
    mockScoreVersions.mockResolvedValue(0.95);
  });

  // ---- Ecosystem routing --------------------------------------------------

  describe("ecosystem routing", () => {
    it("calls getRegistryFetcher with 'npm' for npm packages", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(mockGetRegistryFetcher).toHaveBeenCalledWith("npm");
    });

    it("calls getRegistryFetcher with 'pypi' for pypi packages", async () => {
      await scorePackage({ name: "requests", ecosystem: "pypi" });
      expect(mockGetRegistryFetcher).toHaveBeenCalledWith("pypi");
    });

    it("passes the package name to the returned fetcher", async () => {
      await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(mockFetcher).toHaveBeenCalledWith("lodash");
    });
  });

  // ---- Fail-closed behavior -----------------------------------------------

  describe("fail-closed: registry returns null", () => {
    beforeEach(() => {
      mockFetcher.mockResolvedValue(null);
    });

    it("returns yellow tier on network failure", async () => {
      const verdict = await scorePackage({ name: "unreachable", ecosystem: "npm" });
      expect(verdict.tier).toBe("yellow");
    });

    it("sets degraded signal defaults: age 0.2, adoption 0.3, registry 0, versions 0.5", async () => {
      const verdict = await scorePackage({ name: "unreachable", ecosystem: "npm" });
      const bySignal = Object.fromEntries(verdict.signals.map(s => [s.signal, s.score]));
      expect(bySignal["age"]).toBe(0.2);
      expect(bySignal["adoption"]).toBe(0.3);
      expect(bySignal["registry"]).toBe(0);
      expect(bySignal["versions"]).toBe(0.5);
    });

    it("includes the degradation reason in the reasons array", async () => {
      const verdict = await scorePackage({ name: "unreachable", ecosystem: "npm" });
      expect(verdict.reasons).toContain(
        "registry lookup failed — cannot verify, defaulting to yellow"
      );
    });

    it("does not invoke any signal scorer", async () => {
      await scorePackage({ name: "unreachable", ecosystem: "npm" });
      expect(mockScoreAge).not.toHaveBeenCalled();
      expect(mockScoreAdoption).not.toHaveBeenCalled();
      expect(mockScoreRegistry).not.toHaveBeenCalled();
      expect(mockScoreVersions).not.toHaveBeenCalled();
    });
  });

  // ---- Tier assignment ----------------------------------------------------

  describe("tier assignment", () => {
    it("returns green for a well-established package (mean 0.95)", async () => {
      // Default setup: age 0.9, adoption 0.95, registry 1.0, versions 0.95 → mean 0.95
      const verdict = await scorePackage({ name: "lodash", ecosystem: "npm" });
      expect(verdict.tier).toBe("green");
      expect(verdict.name).toBe("lodash");
      expect(verdict.ecosystem).toBe("npm");
      expect(verdict.signals).toHaveLength(4);
      expect(verdict.reasons).toHaveLength(4);
    });

    it("returns red for a package that does not exist (mean 0.25)", async () => {
      mockFetcher.mockResolvedValue({ exists: false });
      mockScoreAge.mockResolvedValue(0.2);
      mockScoreAdoption.mockResolvedValue(0.3);
      mockScoreRegistry.mockResolvedValue(0);
      mockScoreVersions.mockResolvedValue(0.5);
      // mean = (0.2 + 0.3 + 0 + 0.5) / 4 = 0.25 → red
      const verdict = await scorePackage({ name: "fake-pkg-xyzzy", ecosystem: "npm" });
      expect(verdict.tier).toBe("red");
      const registrySignal = verdict.signals.find(s => s.signal === "registry");
      expect(registrySignal?.score).toBe(0);
    });

    it("returns yellow for a recent package with modest activity (mean 0.525)", async () => {
      mockScoreAge.mockResolvedValue(0.3);
      mockScoreAdoption.mockResolvedValue(0.3);
      mockScoreRegistry.mockResolvedValue(1.0);
      mockScoreVersions.mockResolvedValue(0.5);
      // mean = (0.3 + 0.3 + 1.0 + 0.5) / 4 = 0.525 → yellow
      const verdict = await scorePackage({ name: "new-modest-pkg", ecosystem: "npm" });
      expect(verdict.tier).toBe("yellow");
    });
  });

  // ---- Tier thresholds ----------------------------------------------------

  describe("tier thresholds", () => {
    /** Set all four signal mocks to the same score value. */
    function setAllSignals(score: number): void {
      mockScoreAge.mockResolvedValue(score);
      mockScoreAdoption.mockResolvedValue(score);
      mockScoreRegistry.mockResolvedValue(score);
      mockScoreVersions.mockResolvedValue(score);
    }

    it("mean 0.29999 → red (just below 0.3 threshold)", async () => {
      setAllSignals(0.29999);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("red");
    });

    it("mean 0.30001 → yellow (just above 0.3 threshold)", async () => {
      setAllSignals(0.30001);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("yellow");
    });

    it("mean 0.3 exactly → yellow (lower bound of yellow range)", async () => {
      setAllSignals(0.3);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("yellow");
    });

    it("mean 0.69999 → yellow (just below 0.7 threshold)", async () => {
      setAllSignals(0.69999);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("yellow");
    });

    it("mean 0.70001 → green (just above 0.7 threshold)", async () => {
      setAllSignals(0.70001);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("green");
    });

    it("mean 0.7 exactly → green (lower bound of green range)", async () => {
      setAllSignals(0.7);
      const { tier } = await scorePackage({ name: "pkg", ecosystem: "npm" });
      expect(tier).toBe("green");
    });
  });
});
