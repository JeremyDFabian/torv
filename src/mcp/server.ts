import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scorePackage } from "../engine/score.js";
import type { Verdict } from "../engine/types.js";

export const VerifyDependencyInput = z.object({
  name: z.string().describe("Package name"),
  ecosystem: z.enum(["npm", "pypi"]).describe("Package ecosystem"),
  context: z.string().optional().describe(
    "Provenance context: 'found in existing repo import' or 'suggested by agent'",
  ),
});

/**
 * JSON Schema representation of the Verdict interface, returned as the tool's
 * outputSchema so consumers can validate the structured response without
 * parsing types at runtime.
 */
export const verdictOutputSchema = z.object({
  name:      z.string().describe("Package name that was verified"),
  ecosystem: z.enum(["npm", "pypi"]).describe("Ecosystem in which the package was looked up"),
  tier:      z.enum(["green", "yellow", "red"]).describe("Overall safety tier"),
  signals: z.array(
    z.object({
      signal: z.string().describe("Short machine-readable signal identifier"),
      score:  z.number().describe("Numeric score in [0, 1]"),
      reason: z.string().describe("Human-readable explanation of the score"),
    }),
  ).describe("Per-signal breakdown that produced the tier"),
  reasons: z.array(z.string()).describe(
    "Human-readable summary reasons, suitable for display to the developer",
  ),
});

/**
 * Creates and configures the MCP server with the verify_dependency tool.
 * Exported separately from the startup logic so tests can instantiate the
 * server without triggering stdio transport setup.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "torv", version: "0.0.0" });

  server.registerTool(
    "verify_dependency",
    {
      description:
        "Verify the safety of a package before installation. Returns a tiered verdict" +
        " (green/yellow/red) with reasons." +
        " Pass 'context' to indicate whether the name was grounded in existing code or generated fresh.",
      inputSchema:  VerifyDependencyInput.shape,
      outputSchema: verdictOutputSchema.shape,
    },
    async (input) => {
      const verdict: Verdict = await scorePackage(input);
      return {
        // Cast required because Verdict lacks an index signature but is
        // structurally compatible with the SDK's { [x: string]: unknown } constraint.
        structuredContent: verdict as unknown as Record<string, unknown>,
        content: [{ type: "text", text: JSON.stringify(verdict) }],
      };
    },
  );

  return server;
}

// Start the stdio transport only when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
