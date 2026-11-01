import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/graph/schema";
import { seedSample } from "../src/graph/seed";
import { createServer } from "../src/mcp/server";

async function client() {
  const db = openDb(":memory:");
  seedSample(db);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  return c;
}
const call = async (c: Client, args: Record<string, unknown>) => {
  const r: any = await c.callTool({ name: "get_enriched_blast_radius", arguments: args });
  return { json: JSON.parse(r.content[0].text), isError: !!r.isError };
};

test("symbol, file, depth params", async () => {
  const c = await client();
  const { json } = await call(c, { symbol_name: "calculateVAT" });
  expect(json.riskLevel).toBe("HIGH");
  expect(json.blastRadius.codeCallers.length).toBe(5);
  expect((await call(c, { symbol_name: "calculateVAT", max_depth: 1 })).json.blastRadius.codeCallers).toHaveLength(1);
  expect((await call(c, { file_path: "src/tax/vat.ts" })).json.targetKind).toBe("file");
});

test("errors: missing target, unknown symbol, out-of-range depth", async () => {
  const c = await client();
  expect(await call(c, {})).toMatchObject({ isError: true });
  expect(await call(c, { symbol_name: "nope" })).toMatchObject({ isError: true, json: { found: false } });
  const bad: any = await c.callTool({ name: "get_enriched_blast_radius", arguments: { symbol_name: "calculateVAT", max_depth: 99 } });
  expect(bad.isError).toBe(true);
});

test("stdio server end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kg3-"));
  const dbFile = join(dir, "g.db");
  seedSample(openDb(dbFile));
  const t = new StdioClientTransport({ command: "bun", args: ["run", join(import.meta.dir, "../src/index.ts"), "serve", "--db", dbFile] });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(t);
  expect((await call(c, { symbol_name: "calculateVAT" })).json.riskLevel).toBe("HIGH");
  await c.close();
  rmSync(dir, { recursive: true, force: true });
});
