import { beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { indexAll, reindexFile } from "../src/indexer";
import { parseCode } from "../src/parser/code";

const FIX = join(import.meta.dir, "../fixtures/dummy-project");

test("parser extracts symbols, imports, calls, @ref", async () => {
  const p = await parseCode("src/vat.ts", await Bun.file(join(FIX, "src/vat.ts")).text());
  expect(p.symbols.map((s) => s.name)).toEqual(["calculateVAT", "round"]);
  expect(p.imports).toContain("getRate");
  expect(p.calls).toContainEqual({ caller: "calculateVAT", callee: "getRate" });
  expect(p.refs).toEqual([{ adr: "ADR-001", line: 3, symbol: "calculateVAT" }]);
});

test("incremental reindex updates graph and skips unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "kg-"));
  cpSync(FIX, root, { recursive: true });
  const db = openDb(":memory:");
  expect((await indexAll(db, root)).changed).toBe(10);
  expect((await indexAll(db, root)).changed).toBe(0);
  appendFileSync(join(root, "src/vat.ts"), "\nexport function newFn() { return calculateVAT(1, 'FR'); }\n");
  const s = await reindexFile(db, root, "src/vat.ts");
  expect(s.changed).toBe(1);
  expect(s.ms).toBeLessThan(500);
  const n = db.query("SELECT 1 FROM edges e JOIN nodes a ON a.id=e.source_id WHERE a.name='newFn' AND relation_type='CALLS'").all();
  expect(n.length).toBe(1);
  rmSync(root, { recursive: true, force: true });
});
