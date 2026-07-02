# Contributing to torv

Thanks for helping make agent-time dependency verification better. torv is a
security tool, so the contributions we value most are **new attack fixtures** and
**clear, reproducible bug reports** — see [Reporting a new attack pattern](#reporting-a-new-attack-pattern).

## Ways to contribute

- **Report a new attack pattern** — a slopsquat, typosquat, or malicious package
  torv should flag (or a legitimate package it wrongly flags). Open a
  [New attack pattern](https://github.com/JeremyDFabian/torv/issues/new?template=new-attack-pattern.yml)
  issue. These become eval fixtures.
- **Report a bug** — a crash, wrong verdict, or broken surface (CLI, MCP, hook).
  Use the [Bug report](https://github.com/JeremyDFabian/torv/issues/new?template=bug-report.yml) template.
- **Send a PR** — fixes, new signals, docs, or fixtures.

## Development setup

Requires **Node.js ≥ 18**.

```bash
git clone https://github.com/JeremyDFabian/torv.git
cd torv
npm install
npm run build     # tsc
npm test          # vitest
npm run eval      # accuracy against eval/fixtures/
```

Run the CLI against a manifest locally:

```bash
npm run build
node dist/cli/index.js path/to/package.json
```

## Where scoring lives

All verdict logic lives in the engine (`src/engine/`). The CLI, MCP tool, and
pre-commit hook are thin consumers with **no scoring logic of their own** — so
the same package always gets the same verdict on every surface. If you're
changing behavior, change it in the engine and let the tests and eval confirm it.

## Adding an eval fixture

Fixtures live in `eval/fixtures/` as JSON arrays, split by expected verdict:

| File | Expected tier |
|------|---------------|
| `known-good.json` | `green` — legitimate, should never be blocked |
| `known-bad.json` | `red` — documented malware / slopsquats |
| `hard-middle.json` | `yellow` — legit-but-new / niche edge cases |

Each entry has this shape:

```json
{
  "name": "react-codeshift",
  "ecosystem": "npm",
  "expectedTier": "red",
  "note": "LLM conflation of 'jscodeshift' and 'react-codemod'; npm returns 200 (Aikido placeholder)",
  "source": "https://www.aikido.dev/blog/slopsquatting-ai-package-hallucination-attacks"
}
```

- **`source` must be a public, citable reference** (advisory, blog post, registry
  page). Fixtures without a verifiable source can't be merged.
- Add the entry to the file matching its `expectedTier`, then run `npm run eval`
  to confirm torv scores it as expected. If it doesn't, that's a finding worth
  discussing in the PR — it may point at a signal gap.

## Pull requests

1. Add or update tests (`vitest`) for behavior changes.
2. `npm test` and `npm run eval` must pass.
3. Keep commits focused; describe *why*, not just *what*.

By contributing you agree your work is licensed under the project's [MIT License](LICENSE).
