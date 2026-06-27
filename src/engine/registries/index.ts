/**
 * Registry fetcher factory.
 *
 * Callers that know only the ecosystem string can use getRegistryFetcher to
 * obtain the right fetcher without importing registry-specific modules
 * directly.
 */

import { fetchNpmMetadata } from "./npm.js";
import { fetchPypiMetadata } from "./pypi.js";

export type { RegistryMetadata } from "./npm.js";

/**
 * Returns the registry fetcher function for the given ecosystem.
 * The returned function shares the module-level cache of its registry module.
 */
export function getRegistryFetcher(
  ecosystem: "npm" | "pypi"
): (name: string) => Promise<import("./npm.js").RegistryMetadata | null> {
  if (ecosystem === "npm") return fetchNpmMetadata;
  return fetchPypiMetadata;
}
