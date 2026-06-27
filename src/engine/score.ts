import type { VerifyInput, Verdict, SignalScore, Tier } from "./types.js";
import { getRegistryFetcher } from "./registries/index.js";
import { scoreAge } from "./signals/age.js";
import { scoreAdoption } from "./signals/adoption.js";
import { scoreRegistry } from "./signals/registry.js";
import { scoreVersions } from "./signals/versions.js";
import { scoreConflation } from "./signals/conflation.js";
import { scoreGrounding } from "./signals/grounding.js";
import { scoreRecency } from "./signals/recency.js";
import { fetchMalwareAdvisory, type MalwareVerdict } from "./signals/advisory.js";

/**
 * Maps an overall numeric score to a safety tier.
 *
 * Thresholds are inclusive-left, exclusive-right:
 *   [0.0, 0.3) → "red"    — high confidence bad
 *   [0.3, 0.7) → "yellow" — uncertain, cannot verify
 *   [0.7, 1.0] → "green"  — high confidence good
 *
 * Only used for packages that pass all the decisive gates below.
 */
function scoreToTier(score: number): Tier {
  if (score < 0.3) return "red";
  if (score < 0.7) return "yellow";
  return "green";
}

/**
 * A representative [0,1] score for the advisory signal, used only for the
 * human-facing breakdown — the tier itself is decided by the gate, not this.
 */
function advisoryToScore(advisory: MalwareVerdict): number {
  switch (advisory) {
    case "whole-package":    return 0;    // documented malware
    case "version-specific": return 0.5;  // legit package, some bad releases
    case "none":             return 1;    // clean
    case "unknown":          return 0.5;  // couldn't check
  }
}

function advisoryReason(advisory: MalwareVerdict, ecosystem: string): string {
  switch (advisory) {
    case "whole-package":
      return "OSV advisory: package is documented malware — blocked";
    case "version-specific":
      return "OSV advisory: specific past versions were flagged malicious; the package itself is legitimate";
    case "none":
      return `no malware advisory on ${ecosystem}`;
    case "unknown":
      return "advisory database unreachable — malware check skipped (heuristics only)";
  }
}

export async function scorePackage(input: VerifyInput): Promise<Verdict> {
  const fetchRegistry = getRegistryFetcher(input.ecosystem);
  const metadata = await fetchRegistry(input.name);

  // ── GATE 0: fail-closed on a transient registry failure ─────────────────────
  // A null result means a network error / timeout / unexpected status — we could
  // not reach the registry at all. Lack of evidence is not evidence of badness:
  // degrade every signal to its "unknown" default and force yellow so the caller
  // is warned but not falsely alarmed. (Distinct from a definitive 404 below.)
  if (metadata === null) {
    const failReason = "registry lookup failed — cannot verify, defaulting to yellow";
    const signals: SignalScore[] = [
      { signal: "advisory",   score: 0.5, reason: failReason },
      { signal: "age",        score: 0.2, reason: failReason },
      { signal: "adoption",   score: 0.3, reason: failReason },
      { signal: "registry",   score: 0,   reason: failReason },
      { signal: "versions",   score: 0.5, reason: failReason },
      { signal: "conflation", score: 0.5, reason: failReason },
      { signal: "grounding",  score: 0.5, reason: failReason },
      { signal: "recency",    score: 0.3, reason: failReason },
    ];
    return {
      name:      input.name,
      ecosystem: input.ecosystem,
      tier:      "yellow",
      signals,
      reasons:   [failReason],
    };
  }

  // Query OSV for a malware advisory. Fails open to "unknown" so OSV downtime
  // degrades us to heuristics rather than blocking every verdict.
  const advisory = await fetchMalwareAdvisory(input.name, input.ecosystem);

  // ── Heuristic signals (the blend for non-gated packages) ────────────────────
  const ageScore        = await scoreAge(metadata);
  const adoptionScore   = await scoreAdoption(metadata, input.name);
  const registryScore   = await scoreRegistry(metadata);
  const versionsScore   = await scoreVersions(metadata);
  const conflationScore = scoreConflation(input.name);
  const groundingScore  = await scoreGrounding(input.name, input.context, process.cwd());
  const recencyScore    = scoreRecency(metadata);

  // ── Human-readable reasons ──────────────────────────────────────────────────
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
    : `not found on ${input.ecosystem} — name does not resolve (likely hallucinated)`;

  const versionsReason =
    metadata.exists && metadata.versionCount !== undefined
      ? `${metadata.versionCount} versions (score ${versionsScore.toFixed(1)})`
      : `version count unknown (score ${versionsScore.toFixed(1)})`;

  const conflationReason = `conflation distance score ${conflationScore.toFixed(1)}`;
  const groundingReason  = `grounding score ${groundingScore.toFixed(1)}`;
  const recencyReason    = `recency score ${recencyScore.toFixed(1)}`;
  const advReason        = advisoryReason(advisory, input.ecosystem);

  const signals: SignalScore[] = [
    { signal: "advisory",   score: advisoryToScore(advisory), reason: advReason },
    { signal: "age",        score: ageScore,        reason: ageReason },
    { signal: "adoption",   score: adoptionScore,   reason: adoptionReason },
    { signal: "registry",   score: registryScore,   reason: registryReason },
    { signal: "versions",   score: versionsScore,   reason: versionsReason },
    { signal: "conflation", score: conflationScore, reason: conflationReason },
    { signal: "grounding",  score: groundingScore,  reason: groundingReason },
    { signal: "recency",    score: recencyScore,    reason: recencyReason },
  ];

  // The blend is the mean of the seven heuristic signals (the advisory signal is
  // a gate, not an averaged input — averaging it would dilute its authority).
  const blendScore =
    (ageScore + adoptionScore + registryScore + versionsScore +
     conflationScore + groundingScore + recencyScore) / 7;

  // ── Tier via gate cascade, highest precision first ──────────────────────────
  let tier: Tier;
  const reasons: string[] = [];

  if (advisory === "whole-package") {
    // GATE 1 — documented malware. Decisive regardless of how legitimate the
    // package's age / downloads / version history look (holding packages look
    // established on purpose).
    tier = "red";
    reasons.push(advReason);
  } else if (!metadata.exists) {
    // GATE 2 — the name does not resolve on the registry. A definitive 404 is a
    // textbook hallucination / slopsquat precursor.
    tier = "red";
    reasons.push(registryReason);
  } else {
    // No gate — fall through to the heuristic blend.
    tier = scoreToTier(blendScore);
    // A version-specific advisory is informational only; it never changes the
    // tier of an otherwise-legitimate package (e.g. axios after a brief incident).
    if (advisory === "version-specific") {
      reasons.push(advReason);
    }
  }

  // Always append the full per-signal reasons for transparency.
  reasons.push(
    ageReason, adoptionReason, registryReason, versionsReason,
    conflationReason, groundingReason, recencyReason,
  );

  return {
    name:      input.name,
    ecosystem: input.ecosystem,
    tier,
    signals,
    reasons,
  };
}
