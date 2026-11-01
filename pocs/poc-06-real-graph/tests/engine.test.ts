import { expect, test } from "bun:test";
import { analyze } from "../src/engine/analyze";
import { depths, names, shopCopy } from "./helpers";

test("ground truth on the EXTRACTED graph: calculateVAT", async () => {
  const { db } = await shopCopy();
  const r = analyze(db, { symbol: "calculateVAT" })!;
  expect(depths(r.callers)).toEqual({ checkoutCart: 1, generateInvoice: 2, submitOrder: 2, sendInvoice: 3, handleWebhook: 3 });
  expect(names(r.tests)).toEqual(["billing.test.ts", "cart.test.ts", "orders.test.ts", "vat.test.ts"]);
  expect(r.tests.find((t) => t.node.name === "vat.test.ts")!.node.title).toBe("VAT Calculation Cases");
  expect(names(r.specs)).toEqual(["ADR-004", "ADR-009"]); // ADR-007 sits on formatMoney, a callee: correctly NOT impacted
  expect(names(r.rules)).toEqual(["RULE-ORD-01", "RULE-VAT-01", "RULE-VAT-02"]);
  expect(names(r.tickets)).toEqual(["ENG-102", "ENG-110"]);
  expect(r.untested).toEqual([]);
  expect(r.risk.level).toBe("HIGH");
});

test("cycle and depth cap on real code (reserveStock <-> releaseStock)", async () => {
  const { db } = await shopCopy();
  const r = analyze(db, { symbol: "reserveStock", maxDepth: 6 })!;
  expect(names(r.callers)).toContain("releaseStock");
  expect(names(r.callers)).not.toContain("reserveStock");
  expect(analyze(db, { symbol: "calculateVAT", maxDepth: 1 })!.callers.map((c) => c.node.name)).toEqual(["checkoutCart"]);
});

test("homonyms: same-file and relative-import resolution stay STRICT, unresolvable ones are INFERRED 1/n", async () => {
  const { db } = await shopCopy();
  const r = analyze(db, { symbol: "formatMoney" })!;
  expect(r.target.matches).toHaveLength(2); // billing.ts and legacy/format.ts
  const by = Object.fromEntries(r.callers.map((c) => [c.node.name, c]));
  expect(by.generateInvoice!.confidence).toBe("strict"); // defined in its own file: shadows the homonym
  expect(by.renderPrice!.confidence).toBe("strict"); // `from "./legacy/format"` proves the target
  expect(by.monthlyReport!.confidence).toBe("inferred"); // `from "@shop/billing"`: alias, two candidates
  expect(by.monthlyReport!.score).toBe(0.5);
  // and the proven edges point to ONE target each
  const targets = (caller: string) => db.query<{ path: string }, [string]>("SELECT t.path FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id WHERE s.name = ? AND t.name = 'formatMoney' AND e.relation_type = 'CALLS'").all(caller).map((x) => x.path);
  expect(targets("generateInvoice")).toEqual(["src/billing.ts"]);
  expect(targets("renderPrice")).toEqual(["src/legacy/format.ts"]);
  expect(targets("monthlyReport").sort()).toEqual(["src/billing.ts", "src/legacy/format.ts"]);
  expect(analyze(db, { symbol: "calculateVAT" })!.callers.every((c) => c.confidence === "strict")).toBe(true);
});

test("untested symbol is flagged (no test imports it)", async () => {
  const { db } = await shopCopy();
  const r = analyze(db, { symbol: "sendInvoice" })!;
  expect(r.untested.map((u) => u.name)).toEqual(["sendInvoice"]);
});

test("file target = union of its symbols", async () => {
  const { db } = await shopCopy();
  const r = analyze(db, { file: "src/tax/vat.ts" })!;
  expect(r.target.matches).toHaveLength(2);
  expect(names(r.callers)).toContain("checkoutCart");
});
