import { expect, test } from "bun:test";
import { analyze } from "../src/engine/analyze";
import { toMcpPayload } from "../src/formatters/mcp";
import { toTerminal } from "../src/formatters/terminal";
import { openDb } from "../src/graph/schema";
import { seedSample } from "../src/graph/seed";

const db = openDb(":memory:");
seedSample(db);
const r = analyze(db, { symbol: "calculateVAT" })!;

test("MCP payload follows spec §2.3 shape", () => {
  const p = toMcpPayload(r);
  expect(p.target).toBe("calculateVAT");
  expect(typeof p.riskScore).toBe("number");
  expect(p.riskLevel).toBe("HIGH");
  expect(p.blastRadius.codeCallers[0]).toMatchObject({ symbol: "checkoutCart", file: "src/services/cart.ts", depth: 1, confidence: "strict" });
  expect(p.blastRadius.testsToRun).toContainEqual(expect.objectContaining({ file: "tests/vat.test.ts", suite: "VAT Calculation Cases" }));
  expect(p.blastRadius.impactedSpecs).toContainEqual(expect.objectContaining({ id: "ADR-004", title: "EU 2026 VAT Compliance", path: "docs/adr/004-vat.md" }));
  expect(p.recommendations).toContain("Run `tests/vat.test.ts` before committing.");
  expect(p.recommendations).toContain("Review `ADR-004` to ensure business rule alignment.");
  expect(p.provenance.nodes.length).toBeGreaterThan(0);
  expect(JSON.stringify(toMcpPayload(r))).toBe(JSON.stringify(p));
});

test("inferred items expose linkScore; strict do not", () => {
  const p = toMcpPayload(analyze(db, { symbol: "applyDiscount" })!);
  const adr = p.blastRadius.impactedSpecs.find((s) => s.id === "ADR-004")! as any;
  expect(adr.confidence).toBe("inferred");
  expect(adr.linkScore).toBe(0.55);
  expect((p.blastRadius.impactedSpecs.find((s) => s.id === "ADR-007") as any).linkScore).toBeUndefined();
});

test("file target labelled fileSymbols, not ambiguity", () => {
  const p = toMcpPayload(analyze(db, { file: "src/tax/vat.ts" })!) as any;
  expect(p.fileSymbols).toHaveLength(2);
  expect(p.ambiguousMatches).toBeUndefined();
});

test("terminal: plain when color off, ANSI when on", () => {
  const plain = toTerminal(r, false);
  expect(plain).not.toContain("\x1b[");
  expect(plain).toContain("Risk 0.");
  expect(plain).toContain("ADR-009 Order flow [draft]");
  expect(toTerminal(r, true)).toContain("\x1b[");
});
