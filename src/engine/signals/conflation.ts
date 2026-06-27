/**
 * Conflation signal — detects packages whose names are suspiciously similar to
 * well-known npm packages, indicating likely typosquatting.
 *
 * Two similarity heuristics are combined and the maximum is used:
 *
 *  1. Prefix match: if the candidate name starts with a popular package name
 *     followed by a separator (-, _, @, .), similarity scales from 0.6 (long
 *     suffix) down to just above 0.6 but at least 0.6.
 *  2. Levenshtein similarity: 1 - dist / max(len(a), len(b)) — catches letter
 *     transpositions, substitutions, and insertions like "reakt" or "lodosh".
 *
 * Scoring thresholds (similarity → returned score):
 *   >= 0.95  → 0.1  (very suspicious, near-exact name clone)
 *   0.80–0.95 → 0.3  (moderately suspicious, short suffix or 1-char typo)
 *   0.60–0.80 → 0.6  (weak signal, long scoped suffix or 2-char edit)
 *   < 0.60   → 1.0  (no strong similarity; signal not applied)
 */

/**
 * Top 75 npm packages (by approximate download popularity) used as reference
 * targets when checking for typosquatting similarity.  Only single-hyphen-free
 * or short hyphenated names are included to keep prefix matching well-defined.
 */
export const POPULAR_NPM_PACKAGES: readonly string[] = [
  "react",        "lodash",       "express",      "typescript",   "axios",
  "chalk",        "commander",    "debug",        "dotenv",       "glob",
  "jest",         "mocha",        "moment",       "mongoose",     "next",
  "nodemon",      "prettier",     "ramda",        "rxjs",         "webpack",
  "vue",          "angular",      "svelte",       "vite",         "eslint",
  "rollup",       "parcel",       "esbuild",      "tailwindcss",  "gatsby",
  "nuxt",         "astro",        "remix",        "prisma",       "sequelize",
  "typeorm",      "knex",         "passport",     "jsonwebtoken", "bcrypt",
  "helmet",       "cors",         "redis",        "mongodb",      "uuid",
  "dayjs",        "luxon",        "marked",       "sharp",        "puppeteer",
  "playwright",   "cypress",      "vitest",       "jasmine",      "sinon",
  "chai",         "got",          "superagent",   "ky",           "ws",
  "kafkajs",      "zod",          "yup",          "joi",          "graphql",
  "fastify",      "koa",          "hapi",         "nestjs",       "babel",
  "postcss",      "sass",         "bluebird",     "classnames",   "immer",
];

/**
 * Compute Levenshtein edit distance between two strings.
 * Standard Wagner-Fischer DP, O(m*n) time, O(min(m,n)) space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string as rows to minimise the working array.
  if (a.length > b.length) return levenshtein(b, a);

  const row = new Uint16Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) row[i] = i;

  for (let j = 1; j <= b.length; j++) {
    let prevDiag = row[0];
    row[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const saved = row[i];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[i] = Math.min(row[i] + 1, row[i - 1] + 1, prevDiag + cost);
      prevDiag = saved;
    }
  }

  return row[a.length];
}

// Characters that can legitimately appear immediately after a package name
// when it is used as a scoping prefix (e.g. "react-dom", "react_utils").
const SEPARATOR_PATTERN = /^[-_@.]/;

/**
 * Compute similarity in [0, 1] between a single candidate name and one popular
 * package, combining prefix-match and Levenshtein heuristics.
 *
 * Exported for unit tests and diagnostic tooling; callers should generally use
 * `scoreConflation` or `bestSimilarity` instead.
 */
export function pairSimilarity(name: string, popular: string): number {
  // ── Prefix match ──────────────────────────────────────────────────────────
  // If the candidate starts with the popular name followed by a separator,
  // treat this as a scoped variant.  The shorter the suffix, the closer the
  // similarity (capped so the result stays in [0.6, 1.0)).
  if (name.startsWith(popular) && name.length > popular.length) {
    const suffix = name.slice(popular.length);
    if (SEPARATOR_PATTERN.test(suffix)) {
      const suffixLen = suffix.length;
      // Linearly interpolate: suffix of length 1 → sim ≈ 0.98,
      //                       suffix of length 20+ → sim = 0.60.
      return 0.6 + 0.4 * (1 - Math.min(suffixLen, 20) / 20);
    }
  }

  // ── Levenshtein similarity ─────────────────────────────────────────────────
  const dist = levenshtein(name, popular);
  const maxLen = Math.max(name.length, popular.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/** Result of the best-match search across the popular package list. */
export interface BestSimilarityResult {
  /** Highest similarity found across all popular packages. */
  similarity: number;
  /** The popular package that produced the highest similarity. */
  matchedPackage: string;
}

/**
 * Find the popular package most similar to `name` and return both the
 * similarity score and the matched package name.
 *
 * The comparison is done in lower-case regardless of `name`'s casing.
 */
export function bestSimilarity(name: string): BestSimilarityResult {
  const lower = name.toLowerCase();
  let best = 0;
  let bestPkg = "";

  for (const popular of POPULAR_NPM_PACKAGES) {
    const sim = pairSimilarity(lower, popular);
    if (sim > best) {
      best = sim;
      bestPkg = popular;
    }
  }

  return { similarity: best, matchedPackage: bestPkg };
}

/**
 * Score a package name based on its phonetic/typographic similarity to the
 * top 75 npm packages.
 *
 * Returns a value in [0, 1] where lower means more suspicious:
 *   0.1 — very high similarity (>= 0.95): likely a near-exact clone or typosquat
 *   0.3 — high similarity   (0.80–0.95): short scoped suffix or single-char typo
 *   0.6 — moderate similarity (0.60–0.80): longer suffix or two-char edit
 *   1.0 — low similarity    (< 0.60):    name does not resemble any top package
 *
 * The optional `context` parameter is accepted for API uniformity with other
 * signals but is not used in this implementation.
 */
export function scoreConflation(packageName: string, _context?: string): number {
  const { similarity } = bestSimilarity(packageName);

  // Exact match (similarity === 1.0) means the candidate IS a popular package,
  // not a typosquat of one. It must not be penalized — this is what previously
  // mis-flagged legitimate names like chalk, axios, and commander.
  if (similarity >= 1.0) return 1.0;

  // Below the confidence threshold — do not apply the signal.
  if (similarity < 0.6) return 1.0;

  if (similarity >= 0.95) return 0.1;
  if (similarity >= 0.80) return 0.3;
  return 0.6; // 0.60 <= similarity < 0.80
}
