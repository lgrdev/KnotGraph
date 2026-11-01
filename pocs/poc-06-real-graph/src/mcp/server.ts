import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyze } from "../engine/analyze";
import { toMcpPayload } from "../formatters/mcp";

const text = (v: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError: true } : {}) });

export function createServer(db: Database): McpServer {
  const server = new McpServer({ name: "knotgraph-blast-radius", version: "0.1.0" });
  server.registerTool(
    "get_enriched_blast_radius",
    {
      description:
        "Impact of changing a symbol or file: callers (multi-hop), tests to re-run, impacted specs/ADRs, governing rules, open tickets, and a 0..1 risk score. Items carry confidence strict|inferred.",
      inputSchema: {
        symbol_name: z.string().min(1).optional().describe("Function or class name"),
        file_path: z.string().min(1).optional().describe("Repo-relative file path (union of its symbols)"),
        max_depth: z.number().int().min(1).max(6).default(3).describe("Caller traversal depth"),
      },
    },
    async ({ symbol_name, file_path, max_depth }) => {
      if (!symbol_name && !file_path) return text({ error: "Provide symbol_name or file_path" }, true);
      const r = analyze(db, { symbol: symbol_name, file: file_path, maxDepth: max_depth });
      return r ? text(toMcpPayload(r)) : text({ found: false, target: symbol_name ?? file_path }, true);
    },
  );
  return server;
}

export async function serveStdio(db: Database): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
