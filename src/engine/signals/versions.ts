/**
 * Score based on version count.
 *
 * npm security holding packages and malicious slopsquats typically have 1–5 versions
 * (one original malicious publish plus the holding claim, or a handful of experimental publishes).
 * Niche-but-legitimate packages have 5–30 versions. Established packages have 50+.
 *
 * Few versions is a red flag; many versions suggests active, legitimate development.
 */

export async function scoreVersions(
  metadata: { exists: boolean; versionCount?: number } | null
): Promise<number> {
  if (!metadata?.exists || metadata.versionCount === undefined) {
    return 0.5; // Unknown, neutral.
  }

  const vc = metadata.versionCount;

  if (vc <= 5) {
    return 0.1; // Very suspicious: holding packages, one-off squats.
  } else if (vc <= 30) {
    return 0.5; // Uncertain: could be niche but legitimate, or ongoing squat campaign.
  } else if (vc <= 100) {
    return 0.75; // Pretty good: sustained development.
  } else {
    return 0.95; // Very established.
  }
}
