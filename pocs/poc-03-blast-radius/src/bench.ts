import { analyze } from "./engine/analyze";
import { openDb } from "./graph/schema";
import { seedLarge } from "./graph/seed";

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;

export function runBench(n = 10_000) {
  const db = openDb(":memory:");
  const t0 = performance.now();
  seedLarge(db, n);
  const nodes = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM nodes").get()!.c;
  const edges = db.query<{ c: number }, []>("SELECT COUNT(*) c FROM edges").get()!.c;
  console.log(`seed ${nodes} nodes / ${edges} edges in ${(performance.now() - t0).toFixed(0)}ms`);

  for (const depth of [3]) {
    const lat: number[] = [];
    let callers = 0;
    for (let i = 0; i < 300; i++) {
      const sym = `f${(i * 33 + 5000) % n}`;
      const t = performance.now();
      const r = analyze(db, { symbol: sym, maxDepth: depth })!;
      lat.push(performance.now() - t);
      callers += r.callers.length;
    }
    const p95 = pct(lat, 0.95);
    console.log(`depth ${depth}: p50 ${pct(lat, 0.5).toFixed(2)}ms  p95 ${p95.toFixed(2)}ms  max ${Math.max(...lat).toFixed(2)}ms  avg callers ${(callers / lat.length).toFixed(0)}  (target <15ms) ${p95 < 15 ? "PASS" : "FAIL"}`);
  }
  // Worst case: most-called symbol.
  const hot = db.query<{ name: string }, []>("SELECT n.name FROM edges e JOIN nodes n ON n.id=e.target_id WHERE e.relation_type='CALLS' GROUP BY n.id ORDER BY COUNT(*) DESC LIMIT 1").get()!.name;
  const t = performance.now();
  const r = analyze(db, { symbol: hot, maxDepth: 3 })!;
  console.log(`hottest symbol ${hot}: ${(performance.now() - t).toFixed(2)}ms, ${r.callers.length} callers`);
  console.log("plan:", db.query("EXPLAIN QUERY PLAN SELECT source_id FROM edges WHERE target_id='x' AND relation_type='CALLS'").all().map((x: any) => x.detail).join("; "));
}
