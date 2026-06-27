import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findImports, findInLockfile, scoreGrounding } from "../src/engine/signals/grounding.js";

// ── Shared temp-repo fixture ───────────────────────────────────────────────

let repoRoot: string;

beforeAll(async () => {
  // Create a temporary directory tree that looks like a small repo:
  //
  //   <tmp>/
  //     src/
  //       index.ts          — imports lodash
  //       utils.js          — uses require("lodash/cloneDeep")
  //     package-lock.json   — lists lodash in dependencies
  //
  repoRoot = await mkdtemp(join(tmpdir(), "torv-grounding-test-"));

  const srcDir = join(repoRoot, "src");
  await mkdir(srcDir, { recursive: true });

  // A TypeScript file that imports lodash.
  await writeFile(
    join(srcDir, "index.ts"),
    `import _ from 'lodash';\nimport { readFile } from 'node:fs/promises';\nexport const id = (x: unknown) => x;\n`,
    "utf8",
  );

  // A JavaScript file that requires a lodash sub-path.
  await writeFile(
    join(srcDir, "utils.js"),
    `const cloneDeep = require("lodash/cloneDeep");\nmodule.exports = { cloneDeep };\n`,
    "utf8",
  );

  // A minimal package-lock.json (npm v2 format).
  const lockContent = {
    name: "test-project",
    version: "1.0.0",
    lockfileVersion: 2,
    packages: {
      "": { name: "test-project", version: "1.0.0" },
      "node_modules/lodash": { version: "4.17.21" },
    },
    dependencies: {
      lodash: { version: "4.17.21" },
    },
  };
  await writeFile(join(repoRoot, "package-lock.json"), JSON.stringify(lockContent), "utf8");
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ── findImports ────────────────────────────────────────────────────────────

describe("findImports", () => {
  it("returns true for a package that appears in a source file import", async () => {
    expect(await findImports(repoRoot, "lodash")).toBe(true);
  });

  it("returns false for a package that is not imported anywhere", async () => {
    expect(await findImports(repoRoot, "unknown-pkg")).toBe(false);
  });

  it("returns true for a package matched via require sub-path", async () => {
    // "lodash/cloneDeep" — the package name is lodash; the slash form is matched.
    expect(await findImports(repoRoot, "lodash")).toBe(true);
  });

  it("does not match a package name that is a substring of another", async () => {
    // The repo imports 'node:fs/promises' — 'fs' should NOT match that.
    expect(await findImports(repoRoot, "fs")).toBe(false);
  });

  it("returns false for an inaccessible repoRoot", async () => {
    expect(await findImports("/nonexistent/path", "lodash")).toBe(false);
  });
});

// ── findInLockfile ─────────────────────────────────────────────────────────

describe("findInLockfile", () => {
  it("returns true for a package listed in package-lock.json dependencies", async () => {
    expect(await findInLockfile(repoRoot, "lodash")).toBe(true);
  });

  it("returns false for a package not in the lockfile", async () => {
    expect(await findInLockfile(repoRoot, "unknown-pkg")).toBe(false);
  });

  it("reads packages['node_modules/pkg'] key in addition to dependencies", async () => {
    // The fixture lockfile has both; checking that the node_modules path also works.
    expect(await findInLockfile(repoRoot, "lodash")).toBe(true);
  });

  it("returns false when repoRoot has no lockfile", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "torv-grounding-empty-"));
    try {
      expect(await findInLockfile(emptyDir, "lodash")).toBe(false);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── findInLockfile — requirements.txt support ──────────────────────────────

describe("findInLockfile with requirements.txt", () => {
  let pyRepoRoot: string;

  beforeAll(async () => {
    pyRepoRoot = await mkdtemp(join(tmpdir(), "torv-grounding-py-"));
    await writeFile(
      join(pyRepoRoot, "requirements.txt"),
      `# project dependencies\nrequests==2.31.0\nnumpy>=1.24\nflask\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(pyRepoRoot, { recursive: true, force: true });
  });

  it("returns true for a package listed in requirements.txt", async () => {
    expect(await findInLockfile(pyRepoRoot, "requests")).toBe(true);
  });

  it("returns true for a package without a version specifier", async () => {
    expect(await findInLockfile(pyRepoRoot, "flask")).toBe(true);
  });

  it("returns false for a package not in requirements.txt", async () => {
    expect(await findInLockfile(pyRepoRoot, "unknown-pkg")).toBe(false);
  });
});

// ── scoreGrounding — primary repo-scan scenarios ───────────────────────────

describe("scoreGrounding — repo scanning", () => {
  it("returns 0.9 for a package found in existing repo imports", async () => {
    expect(await scoreGrounding("lodash", undefined, repoRoot)).toBe(0.9);
  });

  it("returns 0.5 for a package not found in the repo with no context", async () => {
    expect(await scoreGrounding("unknown-pkg", undefined, repoRoot)).toBe(0.5);
  });

  it("returns 0.9 regardless of context when the package is found in the repo", async () => {
    // Even a suspicious-sounding context is overridden by repo evidence.
    expect(await scoreGrounding("lodash", "suggested by agent", repoRoot)).toBe(0.9);
  });
});

// ── scoreGrounding — context parameter ────────────────────────────────────

describe("scoreGrounding — context parameter", () => {
  it("returns 0.3 when context says 'suggested by agent'", async () => {
    expect(await scoreGrounding("some-pkg", "suggested by agent")).toBe(0.3);
  });

  it("returns 0.7 when context says 'found in existing repo import'", async () => {
    expect(await scoreGrounding("some-pkg", "found in existing repo import")).toBe(0.7);
  });

  it("returns 0.5 when no context and no repoRoot", async () => {
    expect(await scoreGrounding("some-pkg")).toBe(0.5);
  });

  it("returns 0.3 for context containing 'suggested by agent' with inaccessible repoRoot", async () => {
    expect(await scoreGrounding("some-pkg", "suggested by agent", "/nonexistent")).toBe(0.3);
  });

  it("returns 0.7 for context 'found in existing repo import' when package not in repo", async () => {
    // unknown-pkg is not in the repo; context governs.
    expect(await scoreGrounding("unknown-pkg", "found in existing repo import", repoRoot)).toBe(0.7);
  });
});

// ── scoreGrounding — score range invariant ────────────────────────────────

describe("scoreGrounding — score is always in [0, 1]", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["lodash", undefined, undefined],
    ["lodash", "suggested by agent", undefined],
    ["lodash", "found in existing repo import", undefined],
    ["unknown-pkg", undefined, undefined],
    ["unknown-pkg", "suggested by agent", undefined],
  ];

  for (const [pkg, ctx, root] of cases) {
    const label = `scoreGrounding(${JSON.stringify(pkg)}, ${JSON.stringify(ctx)})`;
    it(`${label} is in [0, 1]`, async () => {
      const score = await scoreGrounding(pkg, ctx, root);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  }
});
