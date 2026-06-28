import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Verdict } from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Hoist mock factories before any imports so vi.mock closures can reference them.
// ---------------------------------------------------------------------------

const { mockExecFileSync } = vi.hoisted(() => {
  return {
    mockExecFileSync:
      vi.fn<(file: string, args?: string[], opts?: unknown) => string>(),
  };
});

// Mock child_process so getDiff / gitShowHead never touch a real git repo.
vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

const { mockScorePackage } = vi.hoisted(() => {
  return { mockScorePackage: vi.fn<() => Promise<Verdict>>() };
});

// Mock the scoring engine so scoreNewDeps / runHook never hit the network.
vi.mock("../src/engine/score.js", () => ({
  scorePackage: mockScorePackage,
}));

// Mock appendFileSync to prevent .torv-overrides being written to disk.
const { mockAppendFileSync } = vi.hoisted(() => {
  return { mockAppendFileSync: vi.fn() };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, appendFileSync: mockAppendFileSync };
});

// Import after mocks are registered.
import {
  parsePackageJson,
  parseRequirementsTxt,
  getDiff,
  scoreNewDeps,
  runHook,
} from "../src/hook/precommit.js";

// ---------------------------------------------------------------------------
// Shared verdict factory
// ---------------------------------------------------------------------------

function makeVerdict(
  overrides: Partial<Verdict> & Pick<Verdict, "name">,
): Verdict {
  return {
    name:      overrides.name,
    ecosystem: overrides.ecosystem  ?? "npm",
    tier:      overrides.tier       ?? "green",
    signals:   overrides.signals    ?? [
      { signal: "age",      score: 0.9,  reason: "published 800 days ago (score 0.9)" },
      { signal: "adoption", score: 0.95, reason: "npm weekly downloads (score 0.95)" },
      { signal: "registry", score: 1.0,  reason: "exists on npm (score 1.0)" },
      { signal: "versions", score: 0.95, reason: "50 versions (score 0.95)" },
    ],
    reasons:   overrides.reasons    ?? [
      "published 800 days ago (score 0.9)",
      "npm weekly downloads (score 0.95)",
      "exists on npm (score 1.0)",
      "50 versions (score 0.95)",
    ],
  };
}

// ---------------------------------------------------------------------------
// parsePackageJson
// ---------------------------------------------------------------------------

describe("parsePackageJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "torv-hook-pkgjson-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts dependencies and devDependencies with versions", () => {
    const fp = join(tmpDir, "package.json");
    writeFileSync(
      fp,
      JSON.stringify({
        dependencies:    { lodash: "^4.17.21", express: "^4.18.0" },
        devDependencies: { vitest: "^2.0.0" },
      }),
      "utf-8",
    );

    const deps = parsePackageJson(fp);

    expect(deps).toEqual([
      { name: "lodash",   version: "^4.17.21", ecosystem: "npm" },
      { name: "express",  version: "^4.18.0",  ecosystem: "npm" },
      { name: "vitest",   version: "^2.0.0",   ecosystem: "npm" },
    ]);
  });

  it("returns an empty array when neither section is present", () => {
    const fp = join(tmpDir, "package.json");
    writeFileSync(fp, JSON.stringify({ name: "empty" }), "utf-8");
    expect(parsePackageJson(fp)).toEqual([]);
  });

  it("handles a missing devDependencies section", () => {
    const fp = join(tmpDir, "package.json");
    writeFileSync(fp, JSON.stringify({ dependencies: { lodash: "^4" } }), "utf-8");
    const deps = parsePackageJson(fp);
    expect(deps).toEqual([{ name: "lodash", version: "^4", ecosystem: "npm" }]);
  });

  it("throws SyntaxError on invalid JSON", () => {
    const fp = join(tmpDir, "package.json");
    writeFileSync(fp, "{ not valid json", "utf-8");
    expect(() => parsePackageJson(fp)).toThrow(SyntaxError);
  });

  it("throws TypeError when root is not an object", () => {
    const fp = join(tmpDir, "package.json");
    writeFileSync(fp, '"just a string"', "utf-8");
    expect(() => parsePackageJson(fp)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// parseRequirementsTxt
// ---------------------------------------------------------------------------

describe("parseRequirementsTxt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "torv-hook-reqtxt-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses pinned packages (==) and captures version", () => {
    const fp = join(tmpDir, "requirements.txt");
    writeFileSync(fp, "requests==2.28.0\nnumpy==1.24.0\n", "utf-8");
    const deps = parseRequirementsTxt(fp);
    expect(deps).toEqual([
      { name: "requests", version: "2.28.0", ecosystem: "pypi" },
      { name: "numpy",    version: "1.24.0", ecosystem: "pypi" },
    ]);
  });

  it("parses packages with other version specifiers (>=, ~=, etc.) with empty version", () => {
    const fp = join(tmpDir, "requirements.txt");
    writeFileSync(fp, "flask>=2.0\ndjango~=4.2\n", "utf-8");
    const deps = parseRequirementsTxt(fp);
    expect(deps.map((d) => d.name)).toEqual(["flask", "django"]);
    expect(deps.every((d) => d.ecosystem === "pypi")).toBe(true);
  });

  it("parses a bare package name with empty version", () => {
    const fp = join(tmpDir, "requirements.txt");
    writeFileSync(fp, "requests\n", "utf-8");
    expect(parseRequirementsTxt(fp)).toEqual([
      { name: "requests", version: "", ecosystem: "pypi" },
    ]);
  });

  it("ignores comment lines", () => {
    const fp = join(tmpDir, "requirements.txt");
    writeFileSync(fp, "# a comment\nrequests==2.28.0\n", "utf-8");
    expect(parseRequirementsTxt(fp)).toEqual([
      { name: "requests", version: "2.28.0", ecosystem: "pypi" },
    ]);
  });

  it("ignores blank lines", () => {
    const fp = join(tmpDir, "requirements.txt");
    writeFileSync(fp, "\n\nrequests==2.28.0\n\n", "utf-8");
    expect(parseRequirementsTxt(fp)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getDiff — detectNewDeps
// ---------------------------------------------------------------------------

describe("getDiff (detectNewDeps)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "torv-hook-diff-"));

    // Default: git root is tmpDir; HEAD lookup throws (file not in HEAD).
    mockExecFileSync.mockImplementation((_file: string, args: string[] = []) => {
      if (args.includes("rev-parse")) return `${tmpDir}\n`;
      // git show HEAD:... → file not in HEAD
      throw new Error("fatal: Path not found in HEAD");
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("newly added package.json (not in HEAD)", () => {
    it("returns all deps when the file is new", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(
        fp,
        JSON.stringify({ dependencies: { lodash: "^4", express: "^4" } }),
        "utf-8",
      );

      const newDeps = await getDiff(fp);
      expect(newDeps.map((d) => d.name)).toEqual(["lodash", "express"]);
    });

    it("returns an empty array when the new file has no deps", async () => {
      const fp = join(tmpDir, "package.json");
      writeFileSync(fp, JSON.stringify({ name: "empty" }), "utf-8");
      expect(await getDiff(fp)).toEqual([]);
    });
  });

  describe("package.json already in HEAD", () => {
    it("returns only deps absent from HEAD", async () => {
      const fp = join(tmpDir, "package.json");

      // Staged version has lodash (existing) + axios (new).
      writeFileSync(
        fp,
        JSON.stringify({ dependencies: { lodash: "^4", axios: "^1" } }),
        "utf-8",
      );

      // HEAD only had lodash.
      const headContent = JSON.stringify({ dependencies: { lodash: "^4" } });
      mockExecFileSync.mockImplementation((_file: string, args: string[] = []) => {
        if (args.includes("rev-parse")) return `${tmpDir}\n`;
        if (args.includes("show")) return headContent;
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const newDeps = await getDiff(fp);
      expect(newDeps.map((d) => d.name)).toEqual(["axios"]);
    });

    it("returns empty array when no new deps were added", async () => {
      const fp = join(tmpDir, "package.json");
      const content = JSON.stringify({ dependencies: { lodash: "^4" } });
      writeFileSync(fp, content, "utf-8");

      // HEAD has the same deps.
      mockExecFileSync.mockImplementation((_file: string, args: string[] = []) => {
        if (args.includes("rev-parse")) return `${tmpDir}\n`;
        if (args.includes("show")) return content;
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      expect(await getDiff(fp)).toEqual([]);
    });
  });

  describe("newly added requirements.txt", () => {
    it("returns all deps for a new requirements.txt", async () => {
      const fp = join(tmpDir, "requirements.txt");
      writeFileSync(fp, "requests==2.28.0\nnumpy>=1.24.0\n", "utf-8");

      const newDeps = await getDiff(fp);
      expect(newDeps.map((d) => d.name)).toEqual(["requests", "numpy"]);
      expect(newDeps.every((d) => d.ecosystem === "pypi")).toBe(true);
    });
  });

  it("returns empty array for unrecognised file types", async () => {
    const fp = join(tmpDir, "Pipfile");
    writeFileSync(fp, "requests = '*'\n", "utf-8");
    expect(await getDiff(fp)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scoreNewDeps — red / yellow / green buckets
// ---------------------------------------------------------------------------

describe("scoreNewDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("places all packages in green when all verdicts are green", async () => {
    mockScorePackage
      .mockResolvedValueOnce(makeVerdict({ name: "lodash", tier: "green" }))
      .mockResolvedValueOnce(makeVerdict({ name: "express", tier: "green" }));

    const buckets = await scoreNewDeps([
      { name: "lodash",  version: "^4", ecosystem: "npm" },
      { name: "express", version: "^4", ecosystem: "npm" },
    ]);

    expect(buckets.green.map((v) => v.name)).toEqual(["lodash", "express"]);
    expect(buckets.yellow).toHaveLength(0);
    expect(buckets.red).toHaveLength(0);
  });

  it("places suspicious packages in red", async () => {
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "halluc-pkg", tier: "red" }),
    );

    const buckets = await scoreNewDeps([
      { name: "halluc-pkg", version: "^1", ecosystem: "npm" },
    ]);

    expect(buckets.red.map((v) => v.name)).toEqual(["halluc-pkg"]);
    expect(buckets.green).toHaveLength(0);
    expect(buckets.yellow).toHaveLength(0);
  });

  it("places uncertain packages in yellow", async () => {
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "new-pkg", tier: "yellow" }),
    );

    const buckets = await scoreNewDeps([
      { name: "new-pkg", version: "^0.1", ecosystem: "npm" },
    ]);

    expect(buckets.yellow.map((v) => v.name)).toEqual(["new-pkg"]);
    expect(buckets.red).toHaveLength(0);
    expect(buckets.green).toHaveLength(0);
  });

  it("correctly splits a mixed batch into all three buckets", async () => {
    mockScorePackage
      .mockResolvedValueOnce(makeVerdict({ name: "safe",    tier: "green"  }))
      .mockResolvedValueOnce(makeVerdict({ name: "sketchy", tier: "yellow" }))
      .mockResolvedValueOnce(makeVerdict({ name: "evil",    tier: "red"    }));

    const buckets = await scoreNewDeps([
      { name: "safe",    version: "^4", ecosystem: "npm" },
      { name: "sketchy", version: "^1", ecosystem: "npm" },
      { name: "evil",    version: "^1", ecosystem: "npm" },
    ]);

    expect(buckets.green.map((v) => v.name)).toEqual(["safe"]);
    expect(buckets.yellow.map((v) => v.name)).toEqual(["sketchy"]);
    expect(buckets.red.map((v) => v.name)).toEqual(["evil"]);
  });

  it("calls scorePackage with the correct name and ecosystem for each dep", async () => {
    mockScorePackage.mockResolvedValue(makeVerdict({ name: "x", tier: "green" }));

    await scoreNewDeps([
      { name: "requests", version: "==2.28.0", ecosystem: "pypi" },
    ]);

    expect(mockScorePackage).toHaveBeenCalledWith({
      name: "requests",
      ecosystem: "pypi",
    });
  });

  it("returns empty buckets when the dep list is empty", async () => {
    const buckets = await scoreNewDeps([]);
    expect(buckets.red).toHaveLength(0);
    expect(buckets.yellow).toHaveLength(0);
    expect(buckets.green).toHaveLength(0);
    expect(mockScorePackage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runHook — exit codes
// ---------------------------------------------------------------------------

describe("runHook", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "torv-hook-run-"));

    // Simulate all staged files as newly added (not in HEAD).
    mockExecFileSync.mockImplementation((_file: string, args: string[] = []) => {
      if (args.includes("rev-parse")) return `${tmpDir}\n`;
      throw new Error("fatal: Path not found in HEAD");
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Red package, not in allowlist → exit 1 ----------------------------

  it("returns 1 when a red package is not in the allowlist", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(
      pkgJson,
      JSON.stringify({ dependencies: { "halluc-pkg": "^1" } }),
      "utf-8",
    );
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "halluc-pkg", tier: "red" }),
    );

    const allowlistPath = join(tmpDir, "torv-allow.txt");
    // allowlist does not exist → empty

    const exitCode = await runHook([pkgJson], allowlistPath);
    expect(exitCode).toBe(1);
  });

  it("returns 1 even when some packages are green, if at least one red is unallowed", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(
      pkgJson,
      JSON.stringify({ dependencies: { lodash: "^4", "halluc-pkg": "^1" } }),
      "utf-8",
    );
    mockScorePackage
      .mockResolvedValueOnce(makeVerdict({ name: "lodash",     tier: "green" }))
      .mockResolvedValueOnce(makeVerdict({ name: "halluc-pkg", tier: "red"   }));

    const exitCode = await runHook([pkgJson], join(tmpDir, "allow.txt"));
    expect(exitCode).toBe(1);
  });

  // ---- Red package, in allowlist → exit 0 --------------------------------

  it("returns 0 when a red package is in the allowlist", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(
      pkgJson,
      JSON.stringify({ dependencies: { "halluc-pkg": "^1" } }),
      "utf-8",
    );
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "halluc-pkg", tier: "red" }),
    );

    const allowlistPath = join(tmpDir, "allow.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowedRedPackages: ["halluc-pkg"], reason: "test" }),
      "utf-8",
    );

    const exitCode = await runHook([pkgJson], allowlistPath);
    expect(exitCode).toBe(0);
  });

  it("logs the override to .torv-overrides when an allowlisted red package is encountered", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(
      pkgJson,
      JSON.stringify({ dependencies: { "halluc-pkg": "^1" } }),
      "utf-8",
    );
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "halluc-pkg", tier: "red" }),
    );

    const allowlistPath = join(tmpDir, "allow.json");
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowedRedPackages: ["halluc-pkg"], reason: "test" }),
      "utf-8",
    );

    await runHook([pkgJson], allowlistPath);

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(path).toBe(".torv-overrides");
    const entry = JSON.parse((content as string).trim()) as Record<string, unknown>;
    expect(entry["package"]).toBe("halluc-pkg");
    expect(entry["tier"]).toBe("red");
    expect(typeof entry["timestamp"]).toBe("string");
    expect(entry["approvedBy"]).toBe("user");
  });

  // ---- Yellow packages → exit 0 (warn but allow) -------------------------

  it("returns 0 for yellow packages (warn but do not block)", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(
      pkgJson,
      JSON.stringify({ dependencies: { "new-pkg": "^0.1" } }),
      "utf-8",
    );
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "new-pkg", tier: "yellow" }),
    );

    const exitCode = await runHook([pkgJson], join(tmpDir, "allow.txt"));
    expect(exitCode).toBe(0);
  });

  // ---- Green packages → exit 0 -------------------------------------------

  it("returns 0 when all new packages are green", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(
      pkgJson,
      JSON.stringify({ dependencies: { lodash: "^4" } }),
      "utf-8",
    );
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "lodash", tier: "green" }),
    );

    const exitCode = await runHook([pkgJson], join(tmpDir, "allow.txt"));
    expect(exitCode).toBe(0);
  });

  // ---- No new deps → exit 0 ----------------------------------------------

  it("returns 0 when the staged file has no dependencies", async () => {
    const pkgJson = join(tmpDir, "package.json");
    writeFileSync(pkgJson, JSON.stringify({ name: "empty-project" }), "utf-8");

    const exitCode = await runHook([pkgJson], join(tmpDir, "allow.txt"));
    expect(exitCode).toBe(0);
    expect(mockScorePackage).not.toHaveBeenCalled();
  });

  // ---- Unsupported files are skipped → exit 0 ----------------------------

  it("skips unsupported file types and returns 0", async () => {
    const otherFile = join(tmpDir, "Gemfile");
    writeFileSync(otherFile, 'gem "rails"\n', "utf-8");

    const exitCode = await runHook([otherFile], join(tmpDir, "allow.txt"));
    expect(exitCode).toBe(0);
    expect(mockScorePackage).not.toHaveBeenCalled();
  });

  // ---- requirements.txt integration --------------------------------------

  it("returns 1 for a red package in a new requirements.txt", async () => {
    const reqTxt = join(tmpDir, "requirements.txt");
    writeFileSync(reqTxt, "evil-lib==0.0.1\n", "utf-8");
    mockScorePackage.mockResolvedValueOnce(
      makeVerdict({ name: "evil-lib", tier: "red", ecosystem: "pypi" }),
    );

    const exitCode = await runHook([reqTxt], join(tmpDir, "allow.txt"));
    expect(exitCode).toBe(1);
  });
});
