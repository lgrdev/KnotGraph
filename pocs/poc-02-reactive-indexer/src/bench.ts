import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBlocks } from "./builder/blocks";
import { regenerateFile } from "./builder/claude-md";
import { openDb } from "./graph/db";
import { indexAll } from "./graph/invalidate";
import { startWatcher, type WatchEvent } from "./watcher/watcher";

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fileBody(f: number, rev: number): string {
  let s = f ? `import { fn${f - 1}_0 } from "./m${f - 1}";\n` : "";
  for (let i = 0; i < 5; i++) {
    s += `${i === 0 ? `// @ref ADR-${String((f % 10) + 1).padStart(3, "0")}\n` : ""}export function fn${f}_${i}(x: number): number {\n  const a = x + ${i} + ${rev};\n  const b = a * 2;\n  if (b > 10) {\n    return b - 1;\n  }\n  ${f && i === 0 ? `return fn${f - 1}_0(b);` : "return b;"}\n}\n\n`;
  }
  return s;
}

/** 200 files (~10k LOC) + 10 ADRs; 100 single-file edits through the real chokidar watcher. */
export async function runBench() {
  const root = mkdtempSync(join(tmpdir(), "kg2-bench-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  for (let f = 0; f < 200; f++) writeFileSync(join(root, "src", `m${f}.ts`), fileBody(f, 0));
  for (let d = 1; d <= 10; d++) writeFileSync(join(root, "docs", `ADR-${String(d).padStart(3, "0")}-x.md`), `---\nid: ADR-${String(d).padStart(3, "0")}\n---\n# ADR ${d}\n`);
  const claude = join(root, "CLAUDE.md");
  const manual = "# Bench\nmanual\n";
  const initial = `${manual}<!-- KNOTGRAPH:ARCHITECTURE:START -->\n<!-- KNOTGRAPH:ARCHITECTURE:END -->\n<!-- KNOTGRAPH:MAP:START -->\n<!-- KNOTGRAPH:MAP:END -->\nend\n`;
  writeFileSync(claude, initial);

  const db = openDb(join(root, ".knotgraph", "graph.db"));
  const cold = await indexAll(db, root);

  const waiters = new Map<string, (e: WatchEvent) => void>();
  const w = startWatcher(db, root, (e) => waiters.get(e.path)?.(e));
  await w.ready;

  const apply: number[] = [], e2e: number[] = [], regenMs: number[] = [];
  for (let i = 1; i <= 100; i++) {
    const f = i % 200, rel = `src/m${f}.ts`;
    const got = new Promise<WatchEvent>((res) => waiters.set(rel, res));
    const t0 = performance.now();
    writeFileSync(join(root, rel), fileBody(f, i));
    const ev = await got;
    e2e.push(performance.now() - t0);
    apply.push(ev.ms);
    const t1 = performance.now();
    regenerateFile(claude, renderBlocks(db));
    regenMs.push(performance.now() - t1);
  }
  const final = regenerateFile(claude, renderBlocks(db));
  const preserved = final.text.startsWith(manual) && final.text.endsWith("end\n");

  await w.idle();
  const rss = process.memoryUsage().rss / 1048576;
  const c0 = process.cpuUsage(), h0 = performance.now();
  await sleep(5000);
  const cpu = process.cpuUsage(c0);
  const cpuPct = ((cpu.user + cpu.system) / 1000 / (performance.now() - h0)) * 100;
  await w.close();

  const row = (n: string, v: string, t: string, ok: boolean) => console.log(`${n.padEnd(34)} ${v.padStart(10)}   (target ${t})  ${ok ? "PASS" : "FAIL"}`);
  console.log(`files=${cold.files} cold=${cold.ms.toFixed(0)}ms`);
  row("reindex txn p50", `${pct(apply, 0.5).toFixed(1)}ms`, "<50ms", pct(apply, 0.5) < 50);
  row("reindex txn p95", `${pct(apply, 0.95).toFixed(1)}ms`, "<50ms", pct(apply, 0.95) < 50);
  console.log(`${"event e2e p50/p95 (incl. chokidar)".padEnd(34)} ${pct(e2e, 0.5).toFixed(1)} / ${pct(e2e, 0.95).toFixed(1)} ms`);
  console.log(`${"CLAUDE.md regen p50/p95".padEnd(34)} ${pct(regenMs, 0.5).toFixed(1)} / ${pct(regenMs, 0.95).toFixed(1)} ms`);
  row("manual sections preserved", String(preserved), "100%", preserved);
  row("RSS", `${rss.toFixed(1)}MB`, "<50MB", rss < 50);
  row("idle CPU (5s)", `${cpuPct.toFixed(2)}%`, "~0%", cpuPct < 1);
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
