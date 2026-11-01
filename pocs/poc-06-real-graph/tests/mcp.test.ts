import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/mcp/server";
import { shopCopy } from "./helpers";

const call = async (c: Client, args: Record<string, unknown>) => {
  const r: any = await c.callTool({ name: "get_enriched_blast_radius", arguments: args });
  return { json: JSON.parse(r.content[0].text), isError: !!r.isError };
};

test("in-memory: payload from the extracted graph, errors", async () => {
  const { db, root } = await shopCopy();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(db).connect(a);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(b);
  const { json } = await call(c, { symbol_name: "calculateVAT" });
  expect(json.riskLevel).toBe("HIGH");
  expect(json.blastRadius.impactedSpecs.map((s: any) => s.id).sort()).toEqual(["ADR-004", "ADR-009"]);
  expect(json.blastRadius.tickets.map((t: any) => t.id).sort()).toEqual(["ENG-102", "ENG-110"]);
  expect(json.blastRadius.tickets[0].status).toBeNull(); // honest: not synced from a tracker
  expect(await call(c, {})).toMatchObject({ isError: true });
  expect(await call(c, { symbol_name: "nope" })).toMatchObject({ isError: true });
  rmSync(root, { recursive: true, force: true });
});

test("stdio serve: cold index + live watcher keeps the MCP answer fresh", async () => {
  const { root } = await shopCopy();
  const t = new StdioClientTransport({ command: "bun", args: ["run", join(import.meta.dir, "../src/index.ts"), "serve", "--root", root] });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(t);
  expect((await call(c, { symbol_name: "applyRounding" })).json.blastRadius.codeCallers.map((x: any) => x.symbol)).not.toContain("liveCaller");
  appendFileSync(join(root, "src/cart.ts"), "\nexport function liveCaller(n: number) { return applyRounding(n); }\n");
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await Bun.sleep(50);
    seen = (await call(c, { symbol_name: "applyRounding" })).json.blastRadius.codeCallers.some((x: any) => x.symbol === "liveCaller");
  }
  expect(seen).toBe(true);
  await c.close();
  rmSync(root, { recursive: true, force: true });
});
