import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { analyze } from "../src/engine/analyze";
import { callersOf } from "../src/engine/traverse";
import { addEdge, addNode, openDb } from "../src/graph/schema";
import { seedSample } from "../src/graph/seed";

let db: Database;
beforeAll(() => { db = openDb(":memory:"); seedSample(db); });

const names = (xs: { node: { name: string } }[]) => xs.map((x) => x.node.name).sort();
const depths = (xs: { node: { name: string }; depth: number }[]) => Object.fromEntries(xs.map((x) => [x.node.name, x.depth]));

test("ground truth for calculateVAT: callers, tests, specs, rules, tickets (100%)", () => {
  const r = analyze(db, { symbol: "calculateVAT" })!;
  expect(depths(r.callers)).toEqual({ checkoutCart: 1, submitOrder: 2, generateInvoice: 2, handleWebhook: 3, sendInvoice: 3 });
  expect(names(r.tests)).toEqual(["billing.test.ts", "cart.test.ts", "orders.test.ts", "vat.test.ts"]);
  expect(names(r.specs)).toEqual(["ADR-004", "ADR-007", "ADR-009"]);
  expect(names(r.rules)).toEqual(["RULE-INV-01", "RULE-ORD-01", "RULE-VAT-01", "RULE-VAT-02"]);
  expect(names(r.tickets)).toEqual(["TKT-101", "TKT-102", "TKT-103", "TKT-104"]);
  expect(r.untested).toEqual([]);
});

test("depth cap", () => {
  expect(names(analyze(db, { symbol: "calculateVAT", maxDepth: 1 })!.callers)).toEqual(["checkoutCart"]);
  expect(analyze(db, { symbol: "calculateVAT", maxDepth: 6 })!.callers.map((c) => c.node.name)).toContain("handleWebhook");
  // retryOrder is 4 hops away: invisible at default depth, visible at 4
  expect(names(analyze(db, { symbol: "calculateVAT" })!.callers)).not.toContain("retryOrder");
  expect(names(analyze(db, { symbol: "calculateVAT", maxDepth: 4 })!.callers)).toContain("retryOrder");
});

test("cycle terminates; target never lists itself; diamond deduped at min depth", () => {
  const c = callersOf(db, "fn:src/services/inventory.ts#reserveStock", 6);
  expect(c.map((x) => x.node.name).filter((n) => n === "reserveStock")).toEqual([]);
  expect(new Set(c.map((x) => x.node.id)).size).toBe(c.length);
  const d = depths(analyze(db, { symbol: "checkoutCart" })!.callers);
  expect(d.generateInvoice).toBe(1);
  expect(d.submitOrder).toBe(1);
  expect(d.handleWebhook).toBe(2);
});

test("strict vs inferred distinction", () => {
  const r = analyze(db, { symbol: "applyDiscount" })!;
  const adr4 = r.specs.find((s) => s.node.name === "ADR-004")!;
  expect(adr4.confidence).toBe("inferred");
  expect(adr4.score).toBe(0.55);
  expect(r.specs.find((s) => s.node.name === "ADR-007")!.confidence).toBe("strict");
  // pure inferred caller chain in an isolated graph
  const g = openDb(":memory:");
  for (const n of ["A", "B", "C"]) addNode(g, { id: n, type: "function", name: n, path: `${n}.ts`, title: null, status: null });
  addEdge(g, "A", "B", "CALLS", "inferred", 0.4);
  addEdge(g, "B", "C", "CALLS");
  const cs = analyze(g, { symbol: "C" })!.callers;
  expect(cs.map((c) => [c.node.name, c.depth, c.confidence])).toEqual([["B", 1, "strict"], ["A", 2, "inferred"]]);
});

test("file target = union of its symbols; unknown target = null", () => {
  const r = analyze(db, { file: "src/tax/vat.ts" })!;
  expect(r.target.matches.map((m) => m.id).sort()).toEqual(["fn:src/tax/vat.ts#applyRounding", "fn:src/tax/vat.ts#calculateVAT"]);
  expect(names(r.callers)).toContain("checkoutCart");
  expect(analyze(db, { symbol: "nope" })).toBeNull();
});

test("untested symbol flagged", () => {
  const r = analyze(db, { symbol: "formatMoney" })!;
  expect(r.untested.map((u) => u.name)).toEqual(["formatMoney"]);
  expect(r.recommendations.some((x) => x.includes("No test is linked to `formatMoney`"))).toBe(true);
});
