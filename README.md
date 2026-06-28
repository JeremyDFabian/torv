<div align="center">

# torv

**Stop AI coding agents from installing hallucinated or malicious packages.**

</div>

<p align="center">
  <!-- These two populate automatically once `torv` is published to npm. -->
  <a href="https://www.npmjs.com/package/@j2rem1/torv"><img alt="npm version" src="https://img.shields.io/npm/v/@j2rem1/torv.svg?color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/@j2rem1/torv"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@j2rem1/torv.svg?color=cb3837&logo=npm"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="tests" src="https://img.shields.io/badge/tests-209%20passing-success">
  <img alt="eval accuracy" src="https://img.shields.io/badge/eval-95.8%25-success">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-native-7c3aed">
</p>

<p align="center">
  <a href="#why-agent-time">Why</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="docs/SETUP.md">Docs</a>
</p>

---

torv verifies a dependency *before* it gets installed — at the moment an AI agent suggests it, inside the agent loop. It targets **slopsquatting**: LLMs reliably hallucinate the same plausible-but-nonexistent package names, and attackers pre-register those names with malicious payloads, waiting for an agent to install them.

The core insight: **existence is not trust.** A freshly planted trap package resolves cleanly on any registry — installability is not a safety signal. torv looks at *provenance and reputation*, not just whether `npm install` would succeed.

## Features

- 🛡️ **Agent-time blocking** — verifies *before* `npm install` runs, inside the agent loop, not after the fact.
- 🎯 **Catches slopsquatting** — the hallucinated-name attack that typosquat scanners miss.
- 🔬 **Provenance over existence** — scores reputation and repo grounding, not just "does the name resolve."
- 🚦 **Three-tier verdicts** — `green` / `yellow` / `red`, fail-closed by default.
- 🔌 **MCP-native** — one `verify_dependency` tool for Claude Code, Cursor, and any MCP client.
- 📊 **95.8% on a real eval set** — measured against published malware and slopsquatting reports.

## Quick start

Scan a manifest with zero install:

```bash
npx @j2rem1/torv path/to/package.json
npx @j2rem1/torv path/to/requirements.txt
```

Or install the CLI globally (the command is `torv`):

```bash
npm install -g @j2rem1/torv
torv path/to/package.json
```

Wire it into your AI agent over MCP — drop a `.mcp.json` at your repo root:

```json
{
  "mcpServers": {
    "torv": {
      "command": "node",
      "args": ["/absolute/path/to/torv/dist/mcp/server.js"]
    }
  }
}
```

Then tell the agent to call it before installing (paste into `CLAUDE.md` or your client's rules):

> Before running `npm install`, `pip install`, or any equivalent, call the `verify_dependency` MCP tool for each new package. Block on red; ask for confirmation on yellow.

Full setup for Claude Code and Cursor: [`docs/SETUP.md`](docs/SETUP.md).

<details>
<summary><strong>Build from source (audit it yourself)</strong></summary>

<br>

torv is a security tool that asks for trust, so it is meant to be auditable. To run from a local clone:

```bash
git clone https://github.com/JeremyDFabian/torv.git
cd torv
npm install
npm run build      # compiles to dist/
npm test           # 209 tests
```

Requires Node.js 18+.

</details>

## Why agent-time

External scanners run after the fact. Only a tool living inside the agent loop can see the *provenance* of a suggestion — whether a package name was grounded in existing repo code or generated from nothing. torv exposes that as an MCP tool the agent calls before it installs, with a pre-commit hook as the safety net for anything that slips through.

## How it works

Every surface runs the same verdict **engine**, which returns one of three tiers:

| Tier | Meaning | Action |
|------|---------|--------|
| 🟢 `green` | Exists and looks legitimate | Proceed |
| 🟡 `yellow` | Low confidence or can't verify (fail-closed default) | Ask the developer |
| 🔴 `red` | Strong hallucination or malware signal | Block |

The engine decides the tier with a **gate cascade** over a blend of signals:

1. **Malware gate** — a lookup against the [OSV.dev](https://osv.dev) advisory database. A package documented as malware (`MAL-` advisory or `CWE-506`, affecting the whole package) is an immediate `red`, regardless of how established it looks. Holding/squat packages are aged and seeded on purpose; this gate ignores that theatre.
2. **Existence gate** — a name that doesn't resolve on the registry (a definitive 404) is a textbook hallucination → `red`.
3. **Fail-closed** — if the registry itself is unreachable, the verdict degrades to `yellow`, never `green`.
4. **Heuristic blend** — for everything else, a blend of cheaper signals decides green vs yellow: registry age, adoption (downloads), version count, recency, **conflation distance** (name similarity to popular packages — typosquat detection), and **grounding** (is the name anchored in the local repo's imports/lockfile?).

The OSV lookup fails *open* — if OSV is down, torv falls back to heuristics rather than blocking every verdict.

## Usage

### CLI — scan a manifest

```bash
npx @j2rem1/torv path/to/package.json
npx @j2rem1/torv path/to/requirements.txt
```

Prints a per-dependency verdict table and a `green / yellow / red` summary. Supports npm (`package.json`) and PyPI (`requirements.txt`).

### MCP tool — verify before install

torv exposes `verify_dependency` over stdio for Claude Code, Cursor, and other MCP clients. See [Quick start](#quick-start) for the `.mcp.json` snippet and [`docs/SETUP.md`](docs/SETUP.md) for client-specific setup.

### Pre-commit hook — the safety net

A husky hook scores any *new* dependency in staged `package.json` / `requirements.txt` changes and blocks the commit on `red`. Overrides go through a logged allowlist (`.torv-allowlist.json`), not a blunt skip — so an override is reviewable, not silent.

## Architecture

```
src/
  engine/              # THE SPINE — shared by every surface
    types.ts           # the Verdict contract
    score.ts           # gate cascade + heuristic blend
    signals/           # one file per signal, each returns a partial score
      advisory.ts      #   OSV malware lookup (the decisive gate)
      conflation.ts    #   typosquat / name-similarity distance
      grounding.ts     #   is the name anchored in the local repo?
      age, adoption, registry, versions, recency
    registries/        # npm + PyPI metadata fetchers
  cli/                 # scan a manifest, print verdicts
  mcp/                 # verify_dependency over stdio
  hook/                # pre-commit safety net
eval/                  # labeled fixtures + accuracy harness
```

The MCP tool and the hook are thin consumers of the engine — they contain **no scoring logic of their own**, so both surfaces always give the same verdict for the same package.

## Reliability

torv is measured against a labeled eval set (`eval/fixtures/`) built from real published slopsquatting and malware reports (Aikido, Checkmarx, Socket, GitHub advisories), plus top packages and hard "legit-but-new/niche" cases.

```
Overall accuracy: 95.8%  (68/71)
  green :  100.0%  (29/29)   — zero false positives on legitimate packages
  yellow:   94.4%  (17/18)
  red   :   91.7%  (22/24)   — documented malware blocked
```

Run it yourself:

```bash
npm run eval
```

## Scope & limitations

Agent-time verification has honest, inherent limits — coverage gaps, edge-case false negatives, and the "axios problem." They're documented in full here: [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Contributing

Issues and PRs welcome — torv is a security tool, so clear repro steps and eval fixtures for new attack patterns are especially valued. File them at [github.com/JeremyDFabian/torv/issues](https://github.com/JeremyDFabian/torv/issues).

## License

[MIT](LICENSE) © Jeremy Fabian
