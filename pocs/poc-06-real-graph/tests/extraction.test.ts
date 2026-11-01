import { expect, test } from "bun:test";
import { parseCode } from "../src/parsers/code";
import { parseDoc } from "../src/parsers/docs";
import { names, shopCopy } from "./helpers";

test("code parser: @ticket and test suite names", async () => {
  const c = await parseCode("src/x.ts", "// @ticket ENG-1\nexport function f() {}\n");
  expect(c.tickets).toEqual([{ id: "ENG-1", line: 1, symbol: "f" }]);
  const t = await parseCode("tests/x.test.ts", 'import { f } from "../src/x";\ndescribe("My suite", () => { test("a", () => f()); });\n');
  expect(t.suites[0]).toBe("My suite");
  expect(t.isTest).toBe(true);
});

test("doc parser: rules (map and string forms), tickets (list and csv), status", () => {
  const d = parseDoc("docs/adr/1.md", '---\nid: ADR-1\nstatus: draft\nrules:\n  - R-1: first rule\n  - "R-2: second rule"\ntickets: ENG-1, ENG-2\n---\n# T\n');
  expect(d.status).toBe("draft");
  expect(d.rules).toEqual([{ id: "R-1", text: "first rule" }, { id: "R-2", text: "second rule" }]);
  expect(d.tickets).toEqual(["ENG-1", "ENG-2"]);
});

test("real graph: node and edge types extracted from the shop repo", async () => {
  const { db } = await shopCopy();
  const types = Object.fromEntries(db.query<{ type: string; c: number }, []>("SELECT type, COUNT(*) c FROM nodes GROUP BY type").all().map((r) => [r.type, r.c]));
  expect(types).toMatchObject({ adr: 4, rule: 5, ticket: 2, test: 5 });
  const rels = Object.fromEntries(db.query<{ r: string; c: number }, []>("SELECT relation_type r, COUNT(*) c FROM edges GROUP BY relation_type").all().map((r) => [r.r, r.c]));
  for (const r of ["CALLS", "TESTS", "IMPLEMENTS", "CONTAINS", "CONSTRAINS", "TRACKS"]) expect(rels[r]).toBeGreaterThan(0);
  expect(names(db.query<any, []>("SELECT * FROM nodes WHERE type='ticket'").all().map((n) => ({ node: n })))).toEqual(["ENG-102", "ENG-110"]);
});
