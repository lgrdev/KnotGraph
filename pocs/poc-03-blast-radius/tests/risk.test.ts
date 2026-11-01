import { expect, test } from "bun:test";
import { analyze } from "../src/engine/analyze";
import { DEFAULT_WEIGHTS, computeRisk, type RiskInput } from "../src/engine/risk";
import { openDb } from "../src/graph/schema";
import { seedSample } from "../src/graph/seed";

const base: RiskInput = { callers: [], rules: [], draftSpecs: 0, untestedRatio: 0 };

test("empty -> 0 LOW; clamps at 1.0 HIGH", () => {
  expect(computeRisk(base)).toMatchObject({ score: 0, level: "LOW" });
  const big = computeRisk({ ...base, callers: Array(100).fill({ depth: 1, inferred: false }) });
  expect(big).toMatchObject({ score: 1, level: "HIGH" });
});

test("monotonic: more callers / rules / untested never lowers the score", () => {
  let prev = 0;
  for (let n = 0; n < 15; n++) {
    const s = computeRisk({ ...base, callers: Array(n).fill({ depth: 2, inferred: false }), rules: Array(Math.floor(n / 4)).fill({ depth: 0, inferred: false }) }).score;
    expect(s).toBeGreaterThanOrEqual(prev);
    prev = s;
  }
  expect(computeRisk({ ...base, untestedRatio: 1 }).score).toBeGreaterThan(computeRisk(base).score);
});

test("depth decay and inferred discount", () => {
  const c = (depth: number, inferred = false) => computeRisk({ ...base, callers: [{ depth, inferred }] }).breakdown.callers;
  expect(c(2)).toBeLessThan(c(1));
  expect(c(1, true)).toBeLessThan(c(1));
  expect(c(1, true)).toBeCloseTo(DEFAULT_WEIGHTS.callers * DEFAULT_WEIGHTS.inferredFactor, 2);
});

test("levels thresholds", () => {
  const lvl = (rules: number) => computeRisk({ ...base, rules: Array(rules).fill({ depth: 0, inferred: false }) }).level;
  expect([lvl(1), lvl(2), lvl(4)]).toEqual(["LOW", "MEDIUM", "HIGH"]);
});

test("custom weights respected; analysis is deterministic", () => {
  expect(computeRisk({ ...base, untestedRatio: 1 }, { ...DEFAULT_WEIGHTS, untested: 0.9 }).score).toBe(0.9);
  const db = openDb(":memory:");
  seedSample(db);
  const a = JSON.stringify(analyze(db, { symbol: "calculateVAT" }));
  expect(JSON.stringify(analyze(db, { symbol: "calculateVAT" }))).toBe(a);
  const score = analyze(db, { symbol: "calculateVAT" })!.risk.score;
  expect(score).toBeGreaterThan(0.67); // spec example: HIGH
});
