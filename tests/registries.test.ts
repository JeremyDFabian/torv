import { describe, it, expect, vi, beforeEach } from "vitest";

// Each test calls vi.resetModules() so the module-level cache in npm.ts /
// pypi.ts starts empty for every case.  fetch is stubbed before the dynamic
// import so the stub is in place before any module code runs.

// ---------------------------------------------------------------------------
// fetchNpmMetadata
// ---------------------------------------------------------------------------

describe("fetchNpmMetadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns exists:true with metadata on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          name: "lodash",
          time: {
            created: "2012-01-10T12:00:00.000Z",
            modified: "2023-05-01T08:00:00.000Z",
            downloads: 42_000_000,
            "4.17.21": "2021-02-02T18:00:00.000Z",
          },
        }),
      })
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("lodash");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      exists: true,
      publishedAt: "2012-01-10T12:00:00.000Z",
      weeklyDownloads: 42_000_000,
    });
  });

  it("returns {exists:false} on a 404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 404,
      })
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("this-package-does-not-exist-xyz");

    expect(result).toEqual({ exists: false });
  });

  it("returns null when fetch throws (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("any-package");

    expect(result).toBeNull();
  });

  it("returns null when response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("bad-json-pkg");

    expect(result).toBeNull();
  });

  it("omits weeklyDownloads when time.downloads is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          name: "sparse-pkg",
          time: {
            created: "2020-06-15T00:00:00.000Z",
          },
        }),
      })
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("sparse-pkg");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      exists: true,
      publishedAt: "2020-06-15T00:00:00.000Z",
    });
    // weeklyDownloads key should be absent (undefined), not 0 or null.
    expect(
      (result as { weeklyDownloads?: number }).weeklyDownloads
    ).toBeUndefined();
  });

  it("returns cached result on second call without re-fetching", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        name: "cached-pkg",
        time: { created: "2019-03-01T00:00:00.000Z" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    await fetchNpmMetadata("cached-pkg");
    await fetchNpmMetadata("cached-pkg");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("counts versions from time keys, excluding created and modified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          name: "versioned-pkg",
          time: {
            created: "2018-01-01T00:00:00.000Z",
            modified: "2023-01-01T00:00:00.000Z",
            "1.0.0": "2018-01-01T00:00:00.000Z",
            "1.1.0": "2019-01-01T00:00:00.000Z",
            "2.0.0": "2020-01-01T00:00:00.000Z",
          },
        }),
      })
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("versioned-pkg");

    expect(result).toMatchObject({ exists: true, versionCount: 3 });
  });

  it("returns null on a non-200/404 status (fail closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 500 })
    );

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const result = await fetchNpmMetadata("server-error-pkg");

    expect(result).toBeNull();
  });

  it("does not cache a null result from a network failure", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          name: "retry-pkg",
          time: { created: "2021-01-01T00:00:00.000Z" },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchNpmMetadata } = await import(
      "../src/engine/registries/npm.js"
    );

    const first = await fetchNpmMetadata("retry-pkg");
    expect(first).toBeNull();

    const second = await fetchNpmMetadata("retry-pkg");
    expect(second).toMatchObject({ exists: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// fetchPypiMetadata
// ---------------------------------------------------------------------------

describe("fetchPypiMetadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns exists:true with metadata on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          info: {
            name: "requests",
            created: "2011-02-14T12:00:00.000Z",
            downloads: 8_000_000,
          },
          releases: {
            "1.0.0": [],
            "2.0.0": [],
            "2.31.0": [],
          },
        }),
      })
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("requests");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      exists: true,
      publishedAt: "2011-02-14T12:00:00.000Z",
      weeklyDownloads: 8_000_000,
      versionCount: 3,
    });
  });

  it("returns {exists:false} on a 404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 404 })
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("this-package-does-not-exist-xyz");

    expect(result).toEqual({ exists: false });
  });

  it("returns null when fetch throws (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("any-package");

    expect(result).toBeNull();
  });

  it("returns null when response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("bad-json-pkg");

    expect(result).toBeNull();
  });

  it("omits weeklyDownloads when info.downloads is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          info: {
            name: "sparse-pkg",
            created: "2020-06-15T00:00:00.000Z",
          },
          releases: { "1.0.0": [] },
        }),
      })
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("sparse-pkg");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      exists: true,
      publishedAt: "2020-06-15T00:00:00.000Z",
    });
    expect(
      (result as { weeklyDownloads?: number }).weeklyDownloads
    ).toBeUndefined();
  });

  it("omits publishedAt when info.created is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          info: { name: "no-date-pkg" },
          releases: { "1.0.0": [] },
        }),
      })
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("no-date-pkg");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ exists: true, versionCount: 1 });
    expect(
      (result as { publishedAt?: string }).publishedAt
    ).toBeUndefined();
  });

  it("returns cached result on second call without re-fetching", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        info: { name: "cached-pkg", created: "2019-03-01T00:00:00.000Z" },
        releases: { "1.0.0": [] },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    await fetchPypiMetadata("cached-pkg");
    await fetchPypiMetadata("cached-pkg");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null on a non-200/404 status (fail closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 503 })
    );

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const result = await fetchPypiMetadata("server-error-pkg");

    expect(result).toBeNull();
  });

  it("does not cache a null result from a network failure", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          info: { name: "retry-pkg", created: "2021-01-01T00:00:00.000Z" },
          releases: { "1.0.0": [] },
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchPypiMetadata } = await import(
      "../src/engine/registries/pypi.js"
    );

    const first = await fetchPypiMetadata("retry-pkg");
    expect(first).toBeNull();

    const second = await fetchPypiMetadata("retry-pkg");
    expect(second).toMatchObject({ exists: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getRegistryFetcher
// ---------------------------------------------------------------------------

describe("getRegistryFetcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns fetchNpmMetadata for the npm ecosystem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          name: "express",
          time: { created: "2010-12-29T00:00:00.000Z" },
        }),
      })
    );

    const { getRegistryFetcher } = await import(
      "../src/engine/registries/index.js"
    );

    const fetcher = getRegistryFetcher("npm");
    const result = await fetcher("express");

    expect(result).toMatchObject({ exists: true });
    // Confirm the URL hit the npm registry, not PyPI.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("registry.npmjs.org");
  });

  it("returns fetchPypiMetadata for the pypi ecosystem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          info: { name: "flask", created: "2010-04-06T00:00:00.000Z" },
          releases: { "2.3.0": [] },
        }),
      })
    );

    const { getRegistryFetcher } = await import(
      "../src/engine/registries/index.js"
    );

    const fetcher = getRegistryFetcher("pypi");
    const result = await fetcher("flask");

    expect(result).toMatchObject({ exists: true });
    // Confirm the URL hit PyPI, not npm.
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain("pypi.org");
  });
});
