import { expect, test } from "bun:test";
import { appendFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../src/engine/analyze";
import { applyChange, indexAll } from "../src/graph/invalidate";
import { openDb } from "../src/graph/schema";
import { edgeDump, names, nodeDump, shopCopy } from "./helpers";

test("an edit changes the blast radius immediately (new caller appears, <50ms)", async () => {
  const { root, db } = await shopCopy();
  expect(names(analyze(db, { symbol: "applyRounding" })!.callers)).not.toContain("auditTotals");
  appendFileSync(join(root, "src/cart.ts"), "\n// @ticket ENG-200\nexport function auditTotals(n: number) { return applyRounding(n); }\n");
  const a = await applyChange(db, root, "src/cart.ts", "change");
  expect(a.applied && a.ms).toBeLessThan(50);
  const r = analyze(db, { symbol: "applyRounding" })!;
  expect(names(r.callers)).toContain("auditTotals");
  expect(names(analyze(db, { symbol: "auditTotals" })!.tickets)).toEqual(["ENG-200"]);
  rmSync(root, { recursive: true, force: true });
});

test("incremental graph == full reindex after add / change / unlink (edges, nodes, confidence)", async () => {
  const { root, db } = await shopCopy();
  writeFileSync(join(root, "src/extra.ts"), 'import { formatMoney } from "./billing";\nexport function pretty(n: number) { return formatMoney(n); }\n');
  await applyChange(db, root, "src/extra.ts", "add");
  appendFileSync(join(root, "src/legacy/format.ts"), "\nexport function legacyOnly() { return 1; }\n");
  await applyChange(db, root, "src/legacy/format.ts", "change");
  unlinkSync(join(root, "docs/adr/007-invoicing.md"));
  await applyChange(db, root, "docs/adr/007-invoicing.md", "unlink");
  const full = openDb(":memory:");
  await indexAll(full, root);
  expect(edgeDump(db)).toBe(edgeDump(full));
  expect(nodeDump(db)).toBe(nodeDump(full));
  rmSync(root, { recursive: true, force: true });
});

test("a new homonym flips an unresolvable strict edge to inferred, and removing it flips back; a same-file target never flips", async () => {
  const { root, db } = await shopCopy();
  writeFileSync(join(root, "src/use.ts"), 'import { applyRounding } from "@alias/vat";\nexport function u(n: number) { return applyRounding(n); }\n');
  await applyChange(db, root, "src/use.ts", "add");
  const conf = (caller: string, name: string) => db.query<{ confidence: string; score: number; path: string }, [string, string]>("SELECT e.confidence, e.score, t.path FROM edges e JOIN nodes t ON t.id = e.target_id JOIN nodes s ON s.id = e.source_id WHERE s.name = ? AND t.name = ? AND e.relation_type = 'CALLS' ORDER BY t.path").all(caller, name);
  expect(conf("u", "applyRounding")).toEqual([{ confidence: "strict", score: 1, path: "src/tax/vat.ts" }]);
  writeFileSync(join(root, "src/dup.ts"), "export function applyRounding(n: number) { return n; }\nexport function applyDiscount(n: number) { return n; }\n");
  await applyChange(db, root, "src/dup.ts", "add");
  expect(conf("u", "applyRounding").map((e) => [e.confidence, e.score, e.path])).toEqual([["inferred", 0.5, "src/dup.ts"], ["inferred", 0.5, "src/tax/vat.ts"]]);
  // calculateVAT -> applyRounding lives in the same file as its homonym-free definition: unaffected
  expect(conf("calculateVAT", "applyRounding").map((e) => [e.confidence, e.path])).toEqual([["strict", "src/tax/vat.ts"]]);
  // checkoutCart -> applyDiscount is defined in cart.ts itself: the new homonym must not touch it
  expect(conf("checkoutCart", "applyDiscount").map((e) => [e.confidence, e.path])).toEqual([["strict", "src/cart.ts"]]);
  unlinkSync(join(root, "src/dup.ts"));
  await applyChange(db, root, "src/dup.ts", "unlink");
  expect(conf("u", "applyRounding")).toEqual([{ confidence: "strict", score: 1, path: "src/tax/vat.ts" }]);
  rmSync(root, { recursive: true, force: true });
});

test("orphan tickets are garbage-collected when their last reference disappears", async () => {
  const { root, db } = await shopCopy();
  unlinkSync(join(root, "docs/adr/009-order-flow.md"));
  await applyChange(db, root, "docs/adr/009-order-flow.md", "unlink");
  expect(db.query("SELECT 1 FROM nodes WHERE id = 'ticket:ENG-110'").all()).toHaveLength(0);
  expect(db.query("SELECT 1 FROM nodes WHERE id = 'ticket:ENG-102'").all()).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});
