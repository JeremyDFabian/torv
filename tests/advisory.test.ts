import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyAdvisories,
  fetchMalwareAdvisory,
  __clearAdvisoryCache,
  type OsvVuln,
} from "../src/engine/signals/advisory.js";

// ── Recorded OSV shapes (trimmed to the fields the classifier reads) ─────────

/** free-claude: MAL- advisory whose affected range is introduced at "0" → whole package is malware. */
const wholePackageMal: OsvVuln = {
  id: "MAL-2026-6232",
  summary: "Malicious code in free-claude (npm)",
  affected: [
    {
      package: { name: "free-claude", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }],
      versions: ["1.1.0", "1.0.0", "1.0.1"],
    },
  ],
};

/** crossenv: older GHSA- malware advisory (pre-MAL scheme) tagged CWE-506. */
const ghsaWholePackageMal: OsvVuln = {
  id: "GHSA-c2m4-w5hm-vqjw",
  summary: "crossenv is malware",
  database_specific: { cwe_ids: ["CWE-506"] },
  affected: [
    {
      package: { name: "crossenv", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { last_affected: "1.0.1" }] }],
    },
  ],
};

/** axios: MAL- advisory affecting only specific compromised versions (enumerated, no range). */
const versionSpecificMal: OsvVuln = {
  id: "MAL-2026-2307",
  summary: "Malicious code in axios (npm)",
  affected: [
    {
      package: { name: "axios", ecosystem: "npm" },
      versions: ["0.30.4", "1.14.1"],
    },
  ],
};

/** A regular (non-malware) vulnerability advisory — must be ignored. */
const regularVuln: OsvVuln = {
  id: "GHSA-jr5f-v2jv-69x6",
  summary: "Server-Side Request Forgery in axios",
  database_specific: { cwe_ids: ["CWE-918"] },
  affected: [
    {
      package: { name: "axios", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.8.2" }] }],
    },
  ],
};

/**
 * A regular vuln whose prose mentions "a malicious user" — exactly the shape
 * that a naive keyword match misclassifies. Real example: lodash prototype
 * pollution (CWE-1321), introduced at 0, but NOT malware. Must be "none".
 */
const noisyRegularVuln: OsvVuln = {
  id: "GHSA-p6mc-m468-83gw",
  summary: "Prototype Pollution in lodash",
  details: "A malicious user could exploit this to pollute the object prototype.",
  database_specific: { cwe_ids: ["CWE-1321", "CWE-770"] },
  affected: [
    {
      package: { name: "lodash", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
    },
  ],
};

// ── classifyAdvisories (pure) ────────────────────────────────────────────────

describe("classifyAdvisories", () => {
  it("returns 'none' for no advisories", () => {
    expect(classifyAdvisories([])).toBe("none");
  });

  it("returns 'none' when only non-malware vulnerabilities are present", () => {
    expect(classifyAdvisories([regularVuln])).toBe("none");
  });

  it("returns 'whole-package' for a MAL- advisory introduced at version 0", () => {
    expect(classifyAdvisories([wholePackageMal])).toBe("whole-package");
  });

  it("recognizes an older GHSA- malware advisory via CWE-506", () => {
    expect(classifyAdvisories([ghsaWholePackageMal])).toBe("whole-package");
  });

  it("does NOT treat a regular vuln as malware just because its prose says 'malicious'", () => {
    // Regression: live OSV mis-flagged lodash/axios when matching the word
    // "malicious" in advisory details. Only MAL- ids and CWE-506 count.
    expect(classifyAdvisories([noisyRegularVuln])).toBe("none");
  });

  it("returns 'version-specific' for a MAL- advisory affecting only enumerated versions", () => {
    expect(classifyAdvisories([versionSpecificMal])).toBe("version-specific");
  });

  it("prioritizes 'whole-package' when both whole-package and version-specific malware exist", () => {
    expect(classifyAdvisories([versionSpecificMal, wholePackageMal])).toBe("whole-package");
  });

  it("ignores regular vulns even when a version-specific malware advisory is present", () => {
    // axios real case: 34 regular GHSAs + 1 version-specific MAL → version-specific.
    expect(classifyAdvisories([regularVuln, versionSpecificMal])).toBe("version-specific");
  });

  it("treats a CWE-506 advisory with an enumerated-only version list as version-specific", () => {
    const v: OsvVuln = {
      id: "GHSA-yyyy",
      summary: "Malicious code in a few releases",
      database_specific: { cwe_ids: ["CWE-506"] },
      affected: [{ versions: ["1.2.3"] }],
    };
    expect(classifyAdvisories([v])).toBe("version-specific");
  });
});

// ── fetchMalwareAdvisory (network, mocked) ───────────────────────────────────

describe("fetchMalwareAdvisory", () => {
  beforeEach(() => {
    __clearAdvisoryCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockOsv(status: number, body: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
      })),
    );
  }

  it("classifies a whole-package malware response as 'whole-package'", async () => {
    mockOsv(200, { vulns: [wholePackageMal] });
    expect(await fetchMalwareAdvisory("free-claude", "npm")).toBe("whole-package");
  });

  it("classifies an empty vulns response as 'none'", async () => {
    mockOsv(200, { vulns: [] });
    expect(await fetchMalwareAdvisory("lodash", "npm")).toBe("none");
  });

  it("classifies a missing vulns field as 'none'", async () => {
    mockOsv(200, {});
    expect(await fetchMalwareAdvisory("lodash", "npm")).toBe("none");
  });

  it("fails open with 'unknown' on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await fetchMalwareAdvisory("anything", "npm")).toBe("unknown");
  });

  it("fails open with 'unknown' on a non-200 status", async () => {
    mockOsv(500, {});
    expect(await fetchMalwareAdvisory("anything", "npm")).toBe("unknown");
  });

  it("maps the pypi ecosystem to OSV's 'PyPI' name in the request body", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ vulns: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchMalwareAdvisory("requests", "pypi");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.package.ecosystem).toBe("PyPI");
    expect(body.package.name).toBe("requests");
  });

  it("caches results so a repeated lookup does not hit the network twice", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ vulns: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchMalwareAdvisory("lodash", "npm");
    await fetchMalwareAdvisory("lodash", "npm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup (so a later retry can succeed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await fetchMalwareAdvisory("flaky", "npm")).toBe("unknown");

    mockOsv(200, { vulns: [wholePackageMal] });
    expect(await fetchMalwareAdvisory("flaky", "npm")).toBe("whole-package");
  });
});
