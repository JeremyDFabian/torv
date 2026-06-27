import { describe, it, expect } from "vitest";
import { scoreRecency } from "../src/engine/signals/recency.js";

/** Returns an ISO timestamp exactly `n` days before now. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("scoreRecency", () => {
  // ---- Missing / unresolvable data ----------------------------------------

  it("returns 0.3 when metadata is null", () => {
    expect(scoreRecency(null)).toBe(0.3);
  });

  it("returns 0.3 when lastUpdate is absent", () => {
    expect(scoreRecency({ exists: true })).toBe(0.3);
  });

  it("returns 0.3 when lastUpdate is an invalid date string", () => {
    expect(scoreRecency({ exists: true, lastUpdate: "not-a-date" })).toBe(0.3);
  });

  // ---- Never-updated (< 1 day gap between creation and last modified) ------

  it("returns 0.1 when publishedAt and lastUpdate are identical (never updated)", () => {
    const ts = daysAgo(400);
    expect(scoreRecency({ exists: true, publishedAt: ts, lastUpdate: ts })).toBe(0.1);
  });

  it("returns 0.1 when gap between creation and last modified is under one day", () => {
    const publishedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const lastUpdate  = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(); // +1 hour
    expect(scoreRecency({ exists: true, publishedAt, lastUpdate })).toBe(0.1);
  });

  // ---- Primary scoring bands -----------------------------------------------

  it("returns 0.1 for a package last updated 5 years ago (very suspicious)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(5 * 365) })).toBe(0.1);
  });

  it("returns 0.3 for a package last updated 10 days ago (too new, no track record)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(10) })).toBe(0.3);
  });

  it("returns 0.6 for a package last updated 60 days ago (stale)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(60) })).toBe(0.6);
  });

  it("returns 0.9 for a package last updated 30 days ago (maintained)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(30) })).toBe(0.9);
  });

  // ---- Boundary conditions -------------------------------------------------

  it("returns 0.1 at exactly 365 days (lower bound of abandoned range)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(365) })).toBe(0.1);
  });

  it("returns 0.6 at exactly 60 days (lower bound of stale range)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(60) })).toBe(0.6);
  });

  it("returns 0.9 at exactly 30 days (lower bound of maintained range)", () => {
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(30) })).toBe(0.9);
  });

  // ---- publishedAt absent does not block the daysSinceUpdate path ----------

  it("scores by days-since-update even when publishedAt is missing", () => {
    // 90 days ago, no publishedAt → should still land in the stale (0.6) bucket.
    expect(scoreRecency({ exists: true, lastUpdate: daysAgo(90) })).toBe(0.6);
  });

  it("scores maintained (0.9) when publishedAt is invalid but lastUpdate is valid", () => {
    expect(scoreRecency({
      exists:      true,
      publishedAt: "bad-date",
      lastUpdate:  daysAgo(45),
    })).toBe(0.9);
  });
});
