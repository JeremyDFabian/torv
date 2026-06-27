import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Verdict } from "../src/engine/types.js";

// vi.hoisted ensures the mock function is created before any module imports so
// the vi.mock factory closure can reference it safely.
const { mockScorePackage } = vi.hoisted(() => {
  return { mockScorePackage: vi.fn() };
});

vi.mock("../src/engine/score.js", () => ({
  scorePackage: mockScorePackage,
}));

// Import after mocks are registered.
import { runCli, parsePackageJson, parseRequirementsTxt } from "../src/cli/index.js";

// ---------------------------------------------------------------------------
// Shared fixture verdicts
// ---------------------------------------------------------------------------

function makeVerdict(overrides: Partial<Verdict> & Pick<Verdict, "name">): Verdict {
  return {
    name: overrides.name,
    ecosystem: overrides.ecosystem ?? "npm",
    tier: overrides.tier ?? "green",
    signals: overrides.signals ?? [
      { signal: "age",      score: 0.9,  reason: "published 800 days ago (score 0.9)" },
      { signal: "adoption", score: 0.95, reason: "npm weekly downloads (score 0.95)" },
      { signal: "registry", score: 1.0,  reason: "exists on npm (score 1.0)" },
      { signal: "versions", score: 0.95, reason: "50 versions (score 0.95)" },
    ],
    reasons: overrides.reasons ?? [
      "published 800 days ago (score 0.9)",
      "npm weekly downloads (score 0.95)",
      "exists on npm (score 1.0)",
      "50 versions (score 0.95)",
    ],
  };
}

const greenLodash = makeVerdict({ name: "lodash" });

const redPkg = makeVerdict({
  name: "halluc-pkg",
  tier: "red",
  reasons: [
    "published 2 days ago (score 0.1)",
    "npm weekly downloads (score 0.05)",
    "not found on npm (score 0.0)",
    "1 versions (score 0.1)",
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all console.log calls during an async function into a single string. */
async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// parsePackageJson — unit tests
// ---------------------------------------------------------------------------

describe("parsePackageJson", () => {
  it("extracts names from dependencies and devDependencies as npm", () => {
    const content = JSON.stringify({
      name: "my-project",
      dependencies: { lodash: "^4.17.21", express: "^4.18.0" },
      devDependencies: { vitest: "^2.0.0" },
    });
    const deps = parsePackageJson(content);
    expect(deps).toEqual([
      { name: "lodash",   ecosystem: "npm" },
      { name: "express",  ecosystem: "npm" },
      { name: "vitest",   ecosystem: "npm" },
    ]);
  });

  it("handles a package.json with neither section", () => {
    const content = JSON.stringify({ name: "empty" });
    expect(parsePackageJson(content)).toEqual([]);
  });

  it("handles missing devDependencies gracefully", () => {
    const content = JSON.stringify({ dependencies: { lodash: "^4" } });
    const deps = parsePackageJson(content);
    expect(deps).toEqual([{ name: "lodash", ecosystem: "npm" }]);
  });

  it("throws SyntaxError on invalid JSON", () => {
    expect(() => parsePackageJson("{ not valid json")).toThrow(SyntaxError);
  });

  it("throws TypeError when root is not an object", () => {
    expect(() => parsePackageJson('"just a string"')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// parseRequirementsTxt — unit tests
// ---------------------------------------------------------------------------

describe("parseRequirementsTxt", () => {
  it("parses ==version lines", () => {
    const deps = parseRequirementsTxt("requests==2.28.0\nnumpy==1.24.0\n");
    expect(deps).toEqual([
      { name: "requests", ecosystem: "pypi" },
      { name: "numpy",    ecosystem: "pypi" },
    ]);
  });

  it("handles >=, <=, ~= specifiers", () => {
    const deps = parseRequirementsTxt("flask>=2.0\ndjango~=4.2\ncertifi<=2024.0\n");
    expect(deps.map((d) => d.name)).toEqual(["flask", "django", "certifi"]);
    expect(deps.every((d) => d.ecosystem === "pypi")).toBe(true);
  });

  it("ignores comment lines", () => {
    const deps = parseRequirementsTxt("# a comment\nrequests==2.28.0\n");
    expect(deps).toEqual([{ name: "requests", ecosystem: "pypi" }]);
  });

  it("ignores blank lines", () => {
    const deps = parseRequirementsTxt("\n\nrequests==2.28.0\n\n");
    expect(deps).toEqual([{ name: "requests", ecosystem: "pypi" }]);
  });

  it("parses a name with no version specifier", () => {
    const deps = parseRequirementsTxt("requests\n");
    expect(deps).toEqual([{ name: "requests", ecosystem: "pypi" }]);
  });
});

// ---------------------------------------------------------------------------
// runCli — integration tests using temp files
// ---------------------------------------------------------------------------

describe("runCli", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "torv-cli-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- File-level errors --------------------------------------------------

  describe("file errors", () => {
    it("returns exit code 1 when the file does not exist", async () => {
      const code = await runCli(join(tmpDir, "nonexistent.json"));
      expect(code).toBe(1);
    });

    it("returns exit code 1 for invalid JSON in package.json", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(fp, "{ not valid json", "utf-8");
      const code = await runCli(fp);
      expect(code).toBe(1);
    });

    it("returns exit code 1 for an unsupported filename", async () => {
      const fp = join(tmpDir, "deps.txt");
      writeFileSync(fp, "requests==2.28.0\n", "utf-8");
      const code = await runCli(fp);
      expect(code).toBe(1);
    });
  });

  // ---- package.json scanning ----------------------------------------------

  describe("package.json scanning", () => {
    it("calls scorePackage for each dependency and returns exit code 0", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(
        fp,
        JSON.stringify({
          dependencies: { lodash: "^4.17.21" },
          devDependencies: { vitest: "^2.0.0" },
        }),
        "utf-8",
      );
      mockScorePackage
        .mockResolvedValueOnce(greenLodash)
        .mockResolvedValueOnce(makeVerdict({ name: "vitest" }));

      const code = await runCli(fp);

      expect(code).toBe(0);
      expect(mockScorePackage).toHaveBeenCalledTimes(2);
      expect(mockScorePackage).toHaveBeenCalledWith({ name: "lodash",  ecosystem: "npm" });
      expect(mockScorePackage).toHaveBeenCalledWith({ name: "vitest",  ecosystem: "npm" });
    });

    it("prints table headers in order: NAME ECOSYSTEM TIER REASONS", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(fp, JSON.stringify({ dependencies: { lodash: "^4" } }), "utf-8");
      mockScorePackage.mockResolvedValueOnce(greenLodash);

      const output = await captureLog(() => runCli(fp));
      const headerLine = output.split("\n")[0];

      expect(headerLine).toMatch(/NAME/);
      expect(headerLine).toMatch(/ECOSYSTEM/);
      expect(headerLine).toMatch(/TIER/);
      expect(headerLine).toMatch(/REASONS/);
      // Columns must appear left-to-right in the correct order.
      expect(headerLine.indexOf("NAME")).toBeLessThan(headerLine.indexOf("ECOSYSTEM"));
      expect(headerLine.indexOf("ECOSYSTEM")).toBeLessThan(headerLine.indexOf("TIER"));
      expect(headerLine.indexOf("TIER")).toBeLessThan(headerLine.indexOf("REASONS"));
    });

    it("prints the package name, ecosystem, tier, and reasons in the data row", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(fp, JSON.stringify({ dependencies: { lodash: "^4" } }), "utf-8");
      mockScorePackage.mockResolvedValueOnce(greenLodash);

      const output = await captureLog(() => runCli(fp));

      expect(output).toContain("lodash");
      expect(output).toContain("npm");
      expect(output).toContain("green");
      expect(output).toContain("published 800 days ago (score 0.9)");
    });

    it("prints a summary line with counts for each tier", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(
        fp,
        JSON.stringify({
          dependencies: { lodash: "^4", "halluc-pkg": "^1" },
        }),
        "utf-8",
      );
      mockScorePackage
        .mockResolvedValueOnce(greenLodash)
        .mockResolvedValueOnce(redPkg);

      const output = await captureLog(() => runCli(fp));

      expect(output).toMatch(/1 green/);
      expect(output).toMatch(/0 yellow/);
      expect(output).toMatch(/1 red/);
    });

    it("returns exit code 0 even when red packages are present", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(fp, JSON.stringify({ dependencies: { "halluc-pkg": "^1" } }), "utf-8");
      mockScorePackage.mockResolvedValueOnce(redPkg);

      const code = await runCli(fp);
      expect(code).toBe(0);
    });

    it("prints 'No dependencies found.' when there are no deps", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(fp, JSON.stringify({ name: "empty-project" }), "utf-8");

      const output = await captureLog(() => runCli(fp));
      expect(output).toContain("No dependencies found.");
      expect(mockScorePackage).not.toHaveBeenCalled();
    });
  });

  // ---- requirements.txt scanning ------------------------------------------

  describe("requirements.txt scanning", () => {
    it("calls scorePackage for each package with pypi ecosystem", async () => {
      const fp = join(tmpDir, "requirements.txt");
      writeFileSync(fp, "requests==2.28.0\nnumpy>=1.24.0\n", "utf-8");
      mockScorePackage
        .mockResolvedValueOnce(makeVerdict({ name: "requests", ecosystem: "pypi" }))
        .mockResolvedValueOnce(makeVerdict({ name: "numpy",    ecosystem: "pypi" }));

      const code = await runCli(fp);

      expect(code).toBe(0);
      expect(mockScorePackage).toHaveBeenCalledTimes(2);
      expect(mockScorePackage).toHaveBeenCalledWith({ name: "requests", ecosystem: "pypi" });
      expect(mockScorePackage).toHaveBeenCalledWith({ name: "numpy",    ecosystem: "pypi" });
    });

    it("ignores comment and blank lines when counting scored packages", async () => {
      const fp = join(tmpDir, "requirements.txt");
      writeFileSync(fp, "# comment\n\nrequests==2.28.0\n\n", "utf-8");
      mockScorePackage.mockResolvedValueOnce(
        makeVerdict({ name: "requests", ecosystem: "pypi" }),
      );

      const code = await runCli(fp);

      expect(code).toBe(0);
      expect(mockScorePackage).toHaveBeenCalledTimes(1);
    });
  });
});
