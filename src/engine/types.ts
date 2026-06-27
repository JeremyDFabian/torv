/**
 * Shared verdict contract — every surface (CLI, MCP tool, pre-commit hook) consumes
 * exactly these types. Nothing in cli/, mcp/, or hook/ may define its own verdict shape;
 * all scoring logic flows through the engine and returns a Verdict.
 */

/** The package ecosystem being verified. */
export type Ecosystem = "npm" | "pypi";

/**
 * Safety tier assigned to a package after all signals are combined.
 *
 * - green  — looks legitimate; no strong risk indicators
 * - yellow — uncertain; low confidence or missing data (fail-closed default)
 * - red    — strong indicators of hallucination or malicious squatting
 */
export type Tier = "green" | "yellow" | "red";

/** Input to the verification engine. */
export interface VerifyInput {
  /** Package name as typed by the agent or found in a dependency file. */
  name: string;
  /** Registry ecosystem to query. */
  ecosystem: Ecosystem;
  /**
   * Optional provenance context supplied by the agent — e.g. "found in existing
   * repo import" or "agent suggested from scratch". Used by the grounding signal.
   */
  context?: string;
}

/**
 * The contribution of a single signal to the overall verdict.
 * score is in [0, 1]: 0 = maximally suspicious, 1 = maximally trustworthy.
 */
export interface SignalScore {
  /** Short machine-readable signal identifier, e.g. "registry-age". */
  signal: string;
  /** Numeric score in [0, 1]. */
  score: number;
  /** Human-readable explanation of why this score was assigned. */
  reason: string;
}

/** The final output of the engine for a single package. */
export interface Verdict {
  /** Package name that was verified. */
  name: string;
  /** Ecosystem in which the package was looked up. */
  ecosystem: Ecosystem;
  /** Overall safety tier. */
  tier: Tier;
  /** Per-signal breakdown that produced the tier. */
  signals: SignalScore[];
  /** Human-readable summary reasons, suitable for display to the developer. */
  reasons: string[];
}
