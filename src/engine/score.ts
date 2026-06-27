import type { VerifyInput, Verdict, SignalScore, Tier } from "./types.js";
import { getRegistryFetcher } from "./registries/index.js";
import { scoreAge } from "./signals/age.js";
import { scoreAdoption } from "./signals/adoption.js";
import { scoreRegistry } from "./signals/registry.js";
import { scoreVersions } from "./signals/versions.js";

/**
 * Maps an overall numeric score to a safety tier.
 *
 * Thresholds are inclusive-left, exclusive-right:
 *   [0.0, 0.3) → "red"    — high confidence bad
 *   [0.3, 0.7) → "yellow" — uncertain, cannot verify
 *   [0.7, 1.0] → "green"  — high confidence good
 *
 * Network failures bypass this mapping and always produce "yellow" (fail-closed).
 */
function scoreToTier(score: number): Tier {
  if (score < 0.3) return "red";
  if (score < 0.7) return "yellow";
  return "green";
}

export async function scorePackage(input: VerifyInput): Promise<Verdict> {
  const fetchRegistry = getRegistryFetcher(input.ecosystem);
  const metadata = await fetchRegistry(input.name);

  // Fail-closed: if the registry lookup failed (network error, timeout, unexpected
  // status), we cannot verify the package. Lack of evidence is not evidence of
  // badness — degrade all signals to their "unknown" defaults and force yellow so
  // the caller is warned but not falsely alarmed.
  if (metadata === null) {
    const failReason = "registry lookup failed — cannot verify, defaulting to yellow";
    const signals: SignalScore[] = [
      { signal: "age",      score: 0.2, reason: failReason },
      { signal: "adoption", score: 0.3, reason: failReason },
      { signal: "registry", score: 0,   reason: failReason },
      { signal: "versions", score: 0.5, reason: failReason },
    ];
    return {
      name:      input.name,
      ecosystem: input.ecosystem,
      tier:      "yellow",
      signals,
      reasons:   [failReason],
    };
  }

  const ageScore      = await scoreAge(metadata);
  const adoptionScore = await scoreAdoption(metadata, input.name);
  const registryScore = await scoreRegistry(metadata);
  const versionsScore = await scoreVersions(metadata);

  // Build human-readable reasons
  let ageReason: string;
  if (metadata.exists && metadata.publishedAt) {
    const days = Math.floor(
      (Date.now() - new Date(metadata.publishedAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    ageReason = `published ${days} days ago (score ${ageScore.toFixed(1)})`;
  } else {
    ageReason = `published unknown days ago (score ${ageScore.toFixed(1)})`;
  }

  const adoptionReason =
    `${input.ecosystem} weekly downloads (score ${adoptionScore.toFixed(1)})`;

  const registryReason = metadata.exists
    ? `exists on ${input.ecosystem} (score ${registryScore.toFixed(1)})`
    : `not found on ${input.ecosystem} (score ${registryScore.toFixed(1)})`;

  const versionsReason =
    metadata.exists && metadata.versionCount !== undefined
      ? `${metadata.versionCount} versions (score ${versionsScore.toFixed(1)})`
      : `version count unknown (score ${versionsScore.toFixed(1)})`;

  const signals: SignalScore[] = [
    { signal: "age",      score: ageScore,      reason: ageReason },
    { signal: "adoption", score: adoptionScore,  reason: adoptionReason },
    { signal: "registry", score: registryScore,  reason: registryReason },
    { signal: "versions", score: versionsScore,  reason: versionsReason },
  ];

  const overallScore = (ageScore + adoptionScore + registryScore + versionsScore) / 4;

  return {
    name:      input.name,
    ecosystem: input.ecosystem,
    tier:      scoreToTier(overallScore),
    signals,
    reasons:   [ageReason, adoptionReason, registryReason, versionsReason],
  };
}
