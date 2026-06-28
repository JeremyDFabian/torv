# README redesign — design

**Date:** 2026-06-28
**Goal:** Rewrite `README.md` to match the polish of famous open-source npm packages (vite, prisma, zod, chalk) while preserving torv's existing substance.

## Decisions (from brainstorming)

- **Install story:** npm/npx primary. `npx torv` and `npm install -g torv` lead; git clone becomes a secondary "build from source / audit it" path.
- **Hero:** Full centered `<p align="center">` hero with name, tagline, badge row, and quick-nav links. No logo image, no ASCII art.
- **Limitations:** Moved out of the README into a new `docs/LIMITATIONS.md` (content preserved verbatim), linked from a single footer line.
- **npm status:** Not yet published. Live-now badges are static; `npm version` + `npm downloads` badges are included with an HTML comment noting they populate on publish.
- **TOC:** No separate Table of Contents block — the hero's quick-nav links cover navigation.
- **License:** State GPL-3.0-or-later (fixes current "Not yet specified").

## README structure

1. **Hero** (centered)
   - `torv` heading + tagline: "Stop AI coding agents from installing hallucinated or malicious packages."
   - Badge row:
     - Static / live-now: `license GPL-3.0`, `node >=18`, `tests 209 passing`, `eval 95.8%`, `MCP`.
     - Populate-on-publish (with HTML comment): `npm version`, `npm downloads`.
   - Quick-nav: Why · Quick start · How it works · Usage · Architecture · Docs

2. **Pitch + core insight** — one paragraph, keep the "existence is not trust" framing.

3. **Features grid** — ~6 emoji bullets:
   - 🛡️ Agent-time blocking (before `npm install`, inside the loop)
   - 🎯 Catches slopsquatting (hallucinated names, not just typosquats)
   - 🔬 Provenance over existence (reputation & grounding)
   - 🚦 Three-tier verdicts (green/yellow/red, fail-closed)
   - 🔌 MCP-native (`verify_dependency` for Claude Code, Cursor, etc.)
   - 📊 95.8% on a real eval set (built from published malware reports)

4. **Quick start** — npx/npm install first, then `.mcp.json` snippet. Git clone in a "Build from source" subsection.

5. **How it works** — keep verdict-tier table + gate-cascade list, lightly tightened.

6. **Usage** — CLI / MCP / pre-commit hook, npm paths, link to `docs/SETUP.md`.

7. **Architecture** — keep `src/` tree + "thin consumers of the engine" note.

8. **Footer** — Reliability (eval numbers + `npm run eval`), Scope & limitations (one-line link to `docs/LIMITATIONS.md`), License (GPL-3.0-or-later), brief Contributing line.

## Files touched

- `README.md` — rewritten.
- `docs/LIMITATIONS.md` — new; receives the current README's Limitations section verbatim.

## Non-goals

- No logo/ASCII art, no comparison-vs-scanners table, no demo gif/asciinema.
- No changes to code, badges infrastructure, or publishing config.
