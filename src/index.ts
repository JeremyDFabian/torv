/**
 * torv — public API.
 *
 * Programmatic entry point for scoring a package's supply-chain risk.
 * The CLI (bin: torv), the MCP server, and the git pre-commit hook all
 * build on top of scorePackage().
 */

export { scorePackage } from "./engine/score.js";
export type {
  Ecosystem,
  Tier,
  VerifyInput,
  SignalScore,
  Verdict,
} from "./engine/types.js";
