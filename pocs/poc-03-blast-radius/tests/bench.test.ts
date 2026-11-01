import { expect, test } from "bun:test";
import { analyze } from "../src/engine/analyze";
import { openDb } from "../src/graph/schema";
import { seedLarge } from "../src/graph/seed";

test("KPI: depth-3 analysis p95 < 15ms on ~10k nodes / ~39k edges", () => {
  const db = openDb(":memory:");
  seedLarge(db, 10_000);
  const lat: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    analyze(db, { symbol: `f${(i * 33 + 5000) % 10_000}`, maxDepth: 3 });
    lat.push(performance.now() - t);
  }
  lat.sort((a, b) => a - b);
  expect(lat[Math.floor(lat.length * 0.95)]!).toBeLessThan(15);
}, 30_000);
