import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getEnrichedBlastRadius, getNodeProvenance } from "../queries";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

export function createServer(db: Database): McpServer {
  const server = new McpServer({ name: "knotgraph", version: "0.1.0" });
  server.registerTool(
    "get_node_provenance",
    {
      description: "Provenance chain of a function/class: function -> source file -> linked ADR/spec -> matching test suites. Call before modifying a symbol.",
      inputSchema: { symbol_name: z.string().min(1).describe("Function or class name") },
    },
    async ({ symbol_name }) => text(getNodeProvenance(db, symbol_name)),
  );
  server.registerTool(
    "get_enriched_blast_radius",
    {
      description: "Impact of changing/removing a symbol: direct callers, tests to re-run, specs/ADRs impacted.",
      inputSchema: { symbol_name: z.string().min(1).describe("Function or class name") },
    },
    async ({ symbol_name }) => text(getEnrichedBlastRadius(db, symbol_name)),
  );
  return server;
}

export async function serveStdio(db: Database): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
