import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { indexAll } from "../../src/indexer";
import { createServer } from "../../src/mcp/server";

const FIX = join(import.meta.dir, "../../fixtures/dummy-project");

async function client() {
  const db = openDb(":memory:");
  await indexAll(db, FIX);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  return c;
}
const call = async (c: Client, name: string, symbol_name: string) => {
  const t0 = performance.now();
  const r: any = await c.callTool({ name, arguments: { symbol_name } });
  return { json: JSON.parse(r.content[0].text), ms: performance.now() - t0 };
};

test("get_node_provenance(calculateVAT): file, ADR-001, 3 tests, provenance", async () => {
  const { json, ms } = await call(await client(), "get_node_provenance", "calculateVAT");
  const r = json.results[0];
  expect(r.file.path).toBe("src/vat.ts");
  expect(r.adrs.map((a: any) => a.id)).toEqual(["ADR-001"]);
  expect(r.tests.map((t: any) => t.path).sort()).toEqual(["tests/cart.test.ts", "tests/checkout.test.ts", "tests/vat.test.ts"]);
  expect(r.provenance.nodes[0].content_hash).toBeString();
  expect(ms).toBeLessThan(50);
});

test("get_enriched_blast_radius(calculateVAT): callers, tests, specs", async () => {
  const { json } = await call(await client(), "get_enriched_blast_radius", "calculateVAT");
  const r = json.results[0];
  expect(r.direct_callers.map((c: any) => c.name).sort()).toEqual(["cartTotal", "checkout"]);
  expect(r.tests_to_rerun.length).toBe(3);
  expect(r.impacted_specs.map((s: any) => s.id)).toContain("ADR-001");
  expect(r.impacted_specs.map((s: any) => s.id)).not.toContain("ADR-002");
});

test("unknown symbol -> found:false", async () => {
  const { json } = await call(await client(), "get_node_provenance", "nope");
  expect(json.found).toBe(false);
});
