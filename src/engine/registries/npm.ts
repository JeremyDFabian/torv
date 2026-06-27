/**
 * Fetches package metadata from the public npm registry.
 *
 * A module-level cache keeps results for the lifetime of the process so that
 * repeated lookups during a single eval run are free.  Only successful (200)
 * and definitive-not-found (404) responses are cached; transient errors are
 * not, so a later retry in a different run can succeed.
 */

/**
 * Normalised metadata shape returned by all registry fetchers.  The same
 * interface is used by both npm and PyPI so that signal scorers are
 * registry-agnostic.
 */
export interface RegistryMetadata {
  exists: boolean;
  publishedAt?: string;
  /** ISO timestamp of the most recent publish/update (npm `time.modified`). */
  lastUpdate?: string;
  weeklyDownloads?: number;
  versionCount?: number;
}

/** @deprecated Use RegistryMetadata instead. */
export type NpmMetadata = RegistryMetadata;

const cache = new Map<string, RegistryMetadata>();

interface NpmRegistryResponse {
  time?: {
    created?: string;
    modified?: string;
    downloads?: number;
    [key: string]: unknown;
  };
}

export async function fetchNpmMetadata(
  name: string
): Promise<RegistryMetadata | null> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
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
    let data: NpmRegistryResponse;
    try {
      data = (await response.json()) as NpmRegistryResponse;
    } catch {
      // Unparseable body — fail closed, do not cache.
      return null;
    }

    const versionCount = data.time
      ? Object.keys(data.time).filter(k => k !== "created" && k !== "modified").length
      : undefined;

    const result: RegistryMetadata = {
      exists: true,
      publishedAt: data.time?.created ?? undefined,
      lastUpdate: data.time?.modified ?? undefined,
      weeklyDownloads:
        typeof data.time?.downloads === "number"
          ? data.time.downloads
          : undefined,
      versionCount,
    };
    cache.set(name, result);
    return result;
  }

  // Any other status (5xx, 429, etc.) — fail closed, do not cache.
  return null;
}
