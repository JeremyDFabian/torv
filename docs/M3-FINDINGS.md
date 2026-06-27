# Step 7 / M3 Findings: Conflation + Grounding Signals

## Summary

Step 7 / M3 added two differentiator signals intended to improve red-bucket accuracy (slopsquat detection):

- **Conflation distance** — phonetic/semantic similarity to popular npm packages
- **Grounding** — checks whether a package name is grounded in existing repo imports or lockfile

**Result:** No improvement on red bucket; regression on yellow bucket.

## Baseline vs M3

| Bucket | Step 3 | Step 7 | Delta |
|--------|--------|--------|-------|
| green  | 100%   | 100%   | ✓ stable |
| yellow | 44.4%  | 27.8%  | ✗ -16.6pp regression |
| red    | 0%     | 0%     | ✗ unchanged |
| **overall** | **52.1%** | **47.9%** | **✗ -4.2pp** |

## Why M3 Signals Didn't Work

### Red bucket (unchanged at 0%)

All 24 red fixtures are false negatives — they score green or yellow when they should score red.

**Root cause:** Conflation and grounding cannot distinguish:
- **Legitimate niche packages** (low adoption, old, few versions, no existing imports)
- **Slopsquat holding packages** (identical registry signature)

Examples:
- `crossenv` (2017 malware, now holding): 4 versions, ~3K/week downloads, old → looks like a niche real package
- `react-codeshift` (documented slopsquat): matched by conflation to "react" (score 0.3, suspicious), but the baseline age/adoption/registry signals are strong enough to override it

Conflation only helps if the slopsquat is a typo of a top package. Many slopsquats aren't obvious typos; they're completely fabricated names that happen to resolve on npm because they were registered and later claimed by security teams.

### Yellow bucket (regressed 44.4% → 27.8%)

13 hard-middle packages (intended to be yellow) now score green:
- `bun-plugin-html`, `hattip`, `sonik`, `deno2node`, `pkg-exports`, etc.

**Root cause:** Grounding signal defaults to neutral (0.5) when repo scan finds nothing. For low-adoption real packages:
- Age: 0.9 (old)
- Adoption: 0.3–0.6 (low, but real)
- Registry: 1.0 (exists)
- Versions: 0.5 (5–30 versions, upper range)
- **Conflation: 1.0 (not similar to top packages, high confidence)**
- **Grounding: 0.5 (not found in repo, neutral default)**

Mean = (0.9 + 0.5 + 1.0 + 0.5 + 1.0 + 0.5) / 6 = 0.73 → **green** (threshold at 0.7)

The new signals are too generous for packages that are genuinely on npm but have low adoption.

## What Would Help

### For red bucket

The cheap signals aren't enough. Options:

1. **Recency of last update** — if a package hasn't been updated since creation, it's more likely a holding package or abandoned squat. Real packages get maintenance, fixes, security updates.
2. **Maintainer reputation** — check if the maintainer has other legitimate packages.
3. **Version jump patterns** — slopsquats often have 1–4 versions clustered around publication; real packages have a spread.
4. **Human-curated list** — for known slopsquats (like those in our `known-bad.json` fixture), flag them directly rather than inferring.

### For yellow bucket

The grounding signal's neutral default (0.5) is too high for low-adoption packages. Options:

1. **Lower the grounding default** — 0.5 → 0.3 (unknown grounding is more suspicious)
2. **Weight grounding higher** — if a package isn't found in any repo and has no context hint, downweight it relative to registry signals
3. **Composite scoring** — packages with *all* low/neutral signals (not grounded, low adoption, few versions) should stay yellow, not drift to green

## Conclusion

M3's conflation and grounding signals improved our understanding of the problem space but didn't solve the red-bucket gap. The real differentiator is likely **recency** (time since last update) or **behavioral signals** that require deeper package history analysis.

Red-bucket detection with only cheap registry signals is a hard ceiling. M3 marked the limit of this approach.
