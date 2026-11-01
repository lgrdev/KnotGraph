import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { indexAll, reindexFile } from "./indexer";
import { getEnrichedBlastRadius, getNodeProvenance } from "./queries";

/** Generate ~10k LOC TS (200 files x 50 lines) + 10 ADRs, then measure KPIs. */
export async function runBench() {
  const root = mkdtempSync(join(tmpdir(), "kg-bench-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  for (let f = 0; f < 200; f++) {
    let s = f ? `import { fn${f - 1}_0 } from "./m${f - 1}";\n` : "";
    for (let i = 0; i < 5; i++) {
      s += `${i === 0 ? "// @ref ADR-" + String((f % 10) + 1).padStart(3, "0") + "\n" : ""}export function fn${f}_${i}(x: number): number {\n  const a = x + ${i};\n  const b = a * 2;\n  if (b > 10) {\n    return b - 1;\n  }\n  ${f && i === 0 ? `return fn${f - 1}_0(b);` : "return b;"}\n}\n\n`;
    }
    writeFileSync(join(root, "src", `m${f}.ts`), s);
  }
  for (let d = 1; d <= 10; d++) writeFileSync(join(root, "docs", `ADR-${String(d).padStart(3, "0")}-x.md`), `---\nid: ADR-${String(d).padStart(3, "0")}\n---\n# ADR ${d}\n## Decision\ntext\n`);

  const db = openDb(join(root, ".knotgraph", "graph.db"));
  const cold = await indexAll(db, root);
  appendFileSync(join(root, "src", "m100.ts"), "\nexport function extra() { return 1; }\n");
  const inc = await reindexFile(db, root, "src/m100.ts");
  const lat: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    (i % 2 ? getNodeProvenance : getEnrichedBlastRadius)(db, `fn${i}_0`);
    lat.push(performance.now() - t);
  }
  lat.sort((a, b) => a - b);
  const p95 = lat[Math.floor(lat.length * 0.95)]!;
  const row = (name: string, v: number, lim: number) => `${name.padEnd(22)} ${v.toFixed(1).padStart(8)}ms  (limit ${lim}ms)  ${v < lim ? "PASS" : "FAIL"}`;
  console.log(`files=${cold.files}`);
  console.log(row("cold start", cold.ms, 3000));
  console.log(row("incremental reindex", inc.ms, 500));
  console.log(row("MCP query p95", p95, 50));
  rmSync(root, { recursive: true, force: true });
}
