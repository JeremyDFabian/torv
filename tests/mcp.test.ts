import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Verdict } from "../src/engine/types.js";

// vi.hoisted ensures the mock function exists before any module is imported so
// the vi.mock factory closure can reference it safely.
const { mockScorePackage } = vi.hoisted(() => ({
  mockScorePackage: vi.fn<() => Promise<Verdict>>(),
}));

vi.mock("../src/engine/score.js", () => ({
  scorePackage: mockScorePackage,
}));

// Import after mocks are registered.
import { createServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const greenVerdict: Verdict = {
  name:      "lodash",
  ecosystem: "npm",
  tier:      "green",
  signals: [
    { signal: "age",      score: 0.9,  reason: "published 800 days ago (score 0.9)" },
    { signal: "adoption", score: 0.95, reason: "npm weekly downloads (score 0.95)" },
    { signal: "registry", score: 1.0,  reason: "exists on npm (score 1.0)" },
    { signal: "versions", score: 0.95, reason: "50 versions (score 0.95)" },
  ],
  reasons: [
    "published 800 days ago (score 0.9)",
    "npm weekly downloads (score 0.95)",
    "exists on npm (score 1.0)",
    "50 versions (score 0.95)",
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spins up a linked server + client pair connected via InMemoryTransport.
 * The caller is responsible for closing both after the test.
 */
async function makeConnectedPair(): Promise<{ client: Client }> {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server: verify_dependency tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool invocation", () => {
    it("calls scorePackage with the supplied name and ecosystem", async () => {
      mockScorePackage.mockResolvedValueOnce(greenVerdict);
      const { client } = await makeConnectedPair();

      await client.callTool({ name: "verify_dependency", arguments: { name: "lodash", ecosystem: "npm" } });

      expect(mockScorePackage).toHaveBeenCalledOnce();
      expect(mockScorePackage).toHaveBeenCalledWith({ name: "lodash", ecosystem: "npm" });
    });

    it("forwards the optional context field to scorePackage", async () => {
      mockScorePackage.mockResolvedValueOnce(greenVerdict);
      const { client } = await makeConnectedPair();

      await client.callTool({
        name: "verify_dependency",
        arguments: { name: "lodash", ecosystem: "npm", context: "found in existing repo import" },
      });

      expect(mockScorePackage).toHaveBeenCalledWith({
        name:      "lodash",
        ecosystem: "npm",
        context:   "found in existing repo import",
      });
    });
  });

  describe("result shape", () => {
    it("returns the Verdict as JSON in a text content block", async () => {
      mockScorePackage.mockResolvedValueOnce(greenVerdict);
      const { client } = await makeConnectedPair();

      const result = await client.callTool({ name: "verify_dependency", arguments: { name: "lodash", ecosystem: "npm" } });

      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");

      const parsed: Verdict = JSON.parse(content[0].text);
      expect(parsed.name).toBe("lodash");
      expect(parsed.ecosystem).toBe("npm");
      expect(parsed.tier).toBe("green");
      expect(parsed.signals).toHaveLength(4);
      expect(parsed.reasons).toHaveLength(4);
    });

    it("round-trips signal scores and reasons faithfully", async () => {
      mockScorePackage.mockResolvedValueOnce(greenVerdict);
      const { client } = await makeConnectedPair();

      const result = await client.callTool({ name: "verify_dependency", arguments: { name: "lodash", ecosystem: "npm" } });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Verdict = JSON.parse(content[0].text);

      const bySignal = Object.fromEntries(parsed.signals.map(s => [s.signal, s]));
      expect(bySignal["age"].score).toBe(0.9);
      expect(bySignal["registry"].score).toBe(1.0);
      expect(parsed.reasons[0]).toBe("published 800 days ago (score 0.9)");
    });

    it("propagates a red tier verdict from scorePackage", async () => {
      const redVerdict: Verdict = {
        ...greenVerdict,
        name: "fake-pkg-xyzzy",
        tier: "red",
        signals: greenVerdict.signals.map(s => ({ ...s, score: 0.1 })),
        reasons: ["not found on npm (score 0.0)"],
      };
      mockScorePackage.mockResolvedValueOnce(redVerdict);
      const { client } = await makeConnectedPair();

      const result = await client.callTool({ name: "verify_dependency", arguments: { name: "fake-pkg-xyzzy", ecosystem: "npm" } });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Verdict = JSON.parse(content[0].text);
      expect(parsed.tier).toBe("red");
    });

    it("works for pypi packages", async () => {
      const pypiVerdict: Verdict = { ...greenVerdict, name: "requests", ecosystem: "pypi" };
      mockScorePackage.mockResolvedValueOnce(pypiVerdict);
      const { client } = await makeConnectedPair();

      const result = await client.callTool({ name: "verify_dependency", arguments: { name: "requests", ecosystem: "pypi" } });

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: Verdict = JSON.parse(content[0].text);
      expect(parsed.ecosystem).toBe("pypi");
      expect(parsed.name).toBe("requests");
    });
  });
});
