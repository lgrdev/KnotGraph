import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/graph/db";
import { applyChange, indexAll } from "../src/graph/invalidate";

const FIX = join(import.meta.dir, "../fixtures/sample-repo");

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "kg2-"));
  cpSync(FIX, root, { recursive: true });
  const db = openDb(":memory:");
  await indexAll(db, root);
  return { root, db };
}
const dump = (db: ReturnType<typeof openDb>, path: string) =>
  JSON.stringify([
    db.query("SELECT id,type,name,content_hash FROM nodes WHERE path=? ORDER BY id").all(path),
    db.query("SELECT e.* FROM edges e JOIN nodes n ON n.id=e.source_id WHERE n.path=? ORDER BY 1,2,3").all(path),
  ]);
const edge = (db: ReturnType<typeof openDb>, s: string, t: string, r: string) =>
  db.query("SELECT 1 FROM edges e JOIN nodes a ON a.id=e.source_id JOIN nodes b ON b.id=e.target_id WHERE a.name=? AND b.name=? AND relation_type=?").all(s, t, r).length === 1;

test("change replaces only that file; other files untouched", async () => {
  const { root, db } = await setup();
  const before = dump(db, "src/rates.ts");
  appendFileSync(join(root, "src/vat.ts"), "\nexport function extra() { return calculateVAT(1, 'FR'); }\n");
  const r = await applyChange(db, root, "src/vat.ts", "change");
  expect(r.applied).toBe(true);
  expect(r.ms).toBeLessThan(50);
  expect(dump(db, "src/rates.ts")).toBe(before);
  expect(edge(db, "extra", "calculateVAT", "CALLS")).toBe(true);
  expect(edge(db, "cartTotal", "calculateVAT", "CALLS")).toBe(true); // inbound edge restored
  expect(edge(db, "calculateVAT", "ADR-001", "IMPLEMENTS")).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("unchanged content is skipped", async () => {
  const { root, db } = await setup();
  expect((await applyChange(db, root, "src/vat.ts", "change")).applied).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("unlink removes inbound and outbound edges and nodes", async () => {
  const { root, db } = await setup();
  unlinkSync(join(root, "src/vat.ts"));
  expect((await applyChange(db, root, "src/vat.ts", "unlink")).applied).toBe(true);
  expect(db.query("SELECT 1 FROM nodes WHERE path='src/vat.ts'").all()).toHaveLength(0);
  expect(db.query("SELECT 1 FROM edges WHERE source_id LIKE '%vat.ts%' OR target_id LIKE '%vat.ts%'").all()).toHaveLength(0);
  rmSync(root, { recursive: true, force: true });
});

test("add of new file links to existing symbols; incremental == full reindex", async () => {
  const { root, db } = await setup();
  writeFileSync(join(root, "src/new.ts"), "import { getRate } from './rates';\nexport function useRate() { return getRate('FR'); }\n");
  await applyChange(db, root, "src/new.ts", "add");
  expect(edge(db, "useRate", "getRate", "CALLS")).toBe(true);
  const full = openDb(":memory:");
  await indexAll(full, root);
  const edges = (d: typeof db) => JSON.stringify(d.query("SELECT * FROM edges ORDER BY 1,2,3").all());
  expect(edges(db)).toBe(edges(full));
  rmSync(root, { recursive: true, force: true });
});

test("failed change rolls back (graph intact)", async () => {
  const { root, db } = await setup();
  const before = JSON.stringify(db.query("SELECT * FROM nodes ORDER BY id").all());
  db.run("CREATE TRIGGER boom BEFORE INSERT ON nodes WHEN NEW.name='boom' BEGIN SELECT RAISE(ABORT,'boom'); END");
  writeFileSync(join(root, "src/vat.ts"), "export function boom() {}\n");
  await expect(applyChange(db, root, "src/vat.ts", "change")).rejects.toThrow();
  expect(JSON.stringify(db.query("SELECT * FROM nodes ORDER BY id").all())).toBe(before);
  rmSync(root, { recursive: true, force: true });
});
