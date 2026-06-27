/**
 * Fetches package metadata from the public PyPI registry.
 *
 * A module-level cache keeps results for the lifetime of the process so that
 * repeated lookups during a single eval run are free.  Only successful (200)
 * and definitive-not-found (404) responses are cached; transient errors are
 * not, so a later retry in a different run can succeed.
 */

import type { RegistryMetadata } from "./npm.js";

const cache = new Map<string, RegistryMetadata>();

interface PypiRegistryResponse {
  info?: {
    /** First-publish timestamp (not always present in the API). */
    created?: string;
    /** Download count if the registry exposes it. */
    downloads?: number;
    [key: string]: unknown;
  };
  /** Map of version string → list of distribution files for that release. */
  releases?: Record<string, unknown[]>;
}

export async function fetchPypiMetadata(
  name: string
): Promise<RegistryMetadata | null> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  let response: Response;
  try {
    response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  } catch {
    // Network failure or timeout — fail closed, do not cache.
    return null;
  }

  if (response.status === 404) {
    const result: RegistryMetadata = { exists: false };
    cache.set(name, result);
    return result;
  }

  if (response.status === 200) {
    let data: PypiRegistryResponse;
    try {
      data = (await response.json()) as PypiRegistryResponse;
    } catch {
      // Unparseable body — fail closed, do not cache.
      return null;
    }

    const versionCount = data.releases
      ? Object.keys(data.releases).length
      : undefined;

    const result: RegistryMetadata = {
      exists: true,
      publishedAt: data.info?.created ?? undefined,
      weeklyDownloads:
        typeof data.info?.downloads === "number"
          ? data.info.downloads
          : undefined,
      versionCount,
    };
    cache.set(name, result);
    return result;
  }

  // Any other status (5xx, 429, etc.) — fail closed, do not cache.
  return null;
}
