/**
 * Advisory signal — queries the OSV.dev malicious-packages / vulnerability
 * database to detect packages with a published malware advisory.
 *
 * This is the highest-precision signal in the engine: a package that the
 * security community has already documented as malware is a definitive red,
 * regardless of how old or how downloaded it looks. Most slopsquats and
 * hallucinated-then-weaponized names end up here once reported.
 *
 * The subtlety the classifier must handle: OSV also records *version-specific*
 * compromises of otherwise-legitimate packages (e.g. a brief supply-chain
 * incident affecting two axios releases). Those must NOT condemn the package
 * name itself. We separate the two cases structurally:
 *
 *   - whole-package    — a malware advisory whose affected range is introduced
 *                        at version "0" (every version is malicious). The
 *                        package exists only to be malware. → gate to red.
 *   - version-specific — a malware advisory affecting only an enumerated set of
 *                        versions, with no introduced-from-0 range. The package
 *                        is legitimate; specific releases were compromised.
 *                        → informational only, never gates.
 *   - none             — no malware advisory (ordinary CVEs are ignored).
 *   - unknown          — OSV could not be reached (fail-open).
 *
 * Failure is fail-open ("unknown"): OSV is an additive signal, so its downtime
 * degrades the engine to its heuristics rather than blocking every verdict.
 */

import type { Ecosystem } from "../types.js";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

/** Minimal subset of the OSV vulnerability object that the classifier reads. */
export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{
      type?: string;
      events?: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
    }>;
    versions?: string[];
  }>;
  database_specific?: { cwe_ids?: string[] };
}

// CWE-506 = "Embedded Malicious Code" — how GitHub Advisory tags malware,
// including older reports published before the OSV "MAL-" feed existed.
const MALWARE_CWE = "CWE-506";

/** Result of classifying a package's advisories. */
export type MalwareVerdict = "whole-package" | "version-specific" | "none" | "unknown";

// OSV uses capitalised ecosystem names; map our lowercase ids onto them.
const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
};

/**
 * Decide whether a single advisory describes malicious code (as opposed to an
 * ordinary vulnerability). Two precise structural markers, either sufficient:
 *   - the OSV id is from the malicious-packages feed ("MAL-…"); or
 *   - the advisory is tagged CWE-506 ("Embedded Malicious Code").
 *
 * We deliberately do NOT scan the free-text summary/details for "malicious":
 * ordinary vulnerability write-ups routinely say "a malicious user could…",
 * which would misclassify legitimate packages (e.g. lodash prototype
 * pollution) as malware.
 */
function isMalwareAdvisory(vuln: OsvVuln): boolean {
  if (vuln.id?.startsWith("MAL-")) return true;
  return (vuln.database_specific?.cwe_ids ?? []).includes(MALWARE_CWE);
}

/**
 * Whether any affected range of this advisory is introduced at version "0",
 * i.e. the whole version history is affected — the package is malware outright.
 */
function affectsWholePackage(vuln: OsvVuln): boolean {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.introduced === "0") return true;
      }
    }
  }
  return false;
}

/**
 * Classify a list of OSV advisories into the malware verdict. Pure and
 * synchronous so it can be unit-tested without any network access.
 */
export function classifyAdvisories(
  vulns: OsvVuln[],
): Exclude<MalwareVerdict, "unknown"> {
  const malware = vulns.filter(isMalwareAdvisory);
  if (malware.length === 0) return "none";
  if (malware.some(affectsWholePackage)) return "whole-package";
  return "version-specific";
}

// Module-level cache keyed by "ecosystem:name". Successful classifications are
// cached for the process lifetime; failures ("unknown") are never cached so a
// later retry can succeed.
const cache = new Map<string, Exclude<MalwareVerdict, "unknown">>();

/** Test-only: reset the cache between cases. */
export function __clearAdvisoryCache(): void {
  cache.clear();
}

/**
 * Query OSV for `name` in `ecosystem` and return the malware verdict.
 * Returns "unknown" (fail-open) on any network, status, or parse failure.
 */
export async function fetchMalwareAdvisory(
  name: string,
  ecosystem: Ecosystem,
): Promise<MalwareVerdict> {
  const key = `${ecosystem}:${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetch(OSV_QUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        package: { name, ecosystem: OSV_ECOSYSTEM[ecosystem] },
      }),
    });
  } catch {
    return "unknown"; // network failure — fail open, do not cache.
  }

  if (response.status !== 200) {
    return "unknown"; // non-200 — fail open, do not cache.
  }

  let data: { vulns?: OsvVuln[] };
  try {
    data = (await response.json()) as { vulns?: OsvVuln[] };
  } catch {
    return "unknown"; // unparseable — fail open, do not cache.
  }

  const verdict = classifyAdvisories(data.vulns ?? []);
  cache.set(key, verdict);
  return verdict;
}
