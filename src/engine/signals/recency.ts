/**
 * Recency signal — time since the package's last published update.
 *
 * The key insight: legitimate packages receive security patches, bug fixes, and
 * dependency bumps on a regular basis.  Slopsquats and holding packages are
 * typically published once and then left untouched, so a stale `lastUpdate`
 * (or one that is identical to the initial publish date) is a strong indicator
 * of a holding / abandoned package.
 *
 * Scoring bands (days since lastUpdate):
 *   missing lastUpdate          → 0.3  (unknown, treat as suspicious)
 *   never updated (< 1 day gap) → 0.1  (single-publish, likely holding)
 *   ≥ 365 days                  → 0.1  (abandoned, very suspicious)
 *    60 – 364 days              → 0.6  (stale but once-active)
 *    30 –  59 days              → 0.9  (maintained, recently patched)
 *     1 –  29 days              → 0.3  (too new to establish track record)
 */

type Metadata = {
  exists: boolean;
  publishedAt?: string;
  lastUpdate?: string;
} | null;

export function scoreRecency(metadata: Metadata): number {
  if (!metadata || !metadata.lastUpdate) {
    return 0.3;
  }

  const lastUpdateMs = new Date(metadata.lastUpdate).getTime();
  if (Number.isNaN(lastUpdateMs)) {
    return 0.3;
  }

  // Detect packages that have never been updated since initial publication.
  // A gap of less than one day between creation and last-modified means the
  // registry entry was written once and never touched — a classic holding pattern.
  if (metadata.publishedAt) {
    const publishedMs = new Date(metadata.publishedAt).getTime();
    if (!Number.isNaN(publishedMs)) {
      const gapDays = (lastUpdateMs - publishedMs) / (1000 * 60 * 60 * 24);
      if (gapDays < 1) {
        return 0.1;
      }
    }
  }

  const daysSinceUpdate = (Date.now() - lastUpdateMs) / (1000 * 60 * 60 * 24);

  if (daysSinceUpdate >= 365) return 0.1; // abandoned / very stale
  if (daysSinceUpdate >= 60)  return 0.6; // stale
  if (daysSinceUpdate >= 30)  return 0.9; // actively maintained
  return 0.3;                              // too new — no track record yet
}
