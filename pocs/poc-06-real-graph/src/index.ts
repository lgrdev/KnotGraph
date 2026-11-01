import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze } from "./engine/analyze";
import { toMcpPayload } from "./formatters/mcp";
import { toTerminal } from "./formatters/terminal";
import { indexAll } from "./graph/invalidate";
import { openDb } from "./graph/schema";
import { serveStdio } from "./mcp/server";
import { startWatcher } from "./watcher/watcher";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    file: { type: "string" },
    depth: { type: "string", default: "3" },
    json: { type: "boolean", default: false },
  },
});
const [cmd, arg] = positionals;
const root = resolve(values.root!);
const db = () => openDb(join(root, ".knotgraph", "graph.db"));

switch (cmd) {
  case "index": {
    const d = db();
    const s = await indexAll(d, root);
    const c = (q: string) => d.query<{ c: number }, []>(q).get()!.c;
    console.log(JSON.stringify({ ...s, nodes: c("SELECT COUNT(*) c FROM nodes"), edges: c("SELECT COUNT(*) c FROM edges"), inferredEdges: c("SELECT COUNT(*) c FROM edges WHERE confidence='inferred'") }));
    break;
  }
  case "analyze": {
    if (!arg && !values.file) { console.error("usage: analyze <symbol> | analyze --file <path> [--root dir] [--depth N] [--json]"); process.exit(1); }
    const d = db();
    await indexAll(d, root); // warm start: only changed files are re-parsed
    const r = analyze(d, { symbol: arg, file: values.file, maxDepth: Number(values.depth) });
    if (!r) { console.error(`not found: ${arg ?? values.file}`); process.exit(2); }
    console.log(values.json ? JSON.stringify(toMcpPayload(r), null, 2) : toTerminal(r));
    break;
  }
  case "serve": {
    const d = db();
    console.error("[knotgraph] index", JSON.stringify(await indexAll(d, root)));
    startWatcher(d, root, (e) => console.error(`[knotgraph] ${e.kind} ${e.path} ${e.applied ? `reindexed in ${e.ms.toFixed(1)}ms` : "unchanged"}`));
    process.stdin.on("end", () => process.exit(0));
    await serveStdio(d);
    break;
  }
  case "bench": {
    const d = openDb(":memory:");
    const s = await indexAll(d, root);
    const syms = d.query<{ name: string }, []>("SELECT DISTINCT name FROM nodes WHERE type IN ('function','class')").all();
    const lat: number[] = [];
    for (const { name } of syms) { const t = performance.now(); analyze(d, { symbol: name }); lat.push(performance.now() - t); }
    lat.sort((a, b) => a - b);
    console.log(`indexed ${s.files} files in ${s.ms.toFixed(0)}ms; ${syms.length} symbols analysed at depth 3: p50 ${lat[Math.floor(lat.length / 2)]!.toFixed(2)}ms p95 ${lat[Math.floor(lat.length * 0.95)]!.toFixed(2)}ms max ${lat[lat.length - 1]!.toFixed(2)}ms`);
    break;
  }
  default:
    console.error("usage: index.ts index|analyze|serve|bench [--root dir] ...");
    process.exit(1);
}
