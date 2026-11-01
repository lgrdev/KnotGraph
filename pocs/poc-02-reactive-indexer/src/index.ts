import { join, resolve } from "node:path";
import { regenerateFile } from "./builder/claude-md";
import { renderBlocks } from "./builder/blocks";
import { openDb } from "./graph/db";
import { indexAll } from "./graph/invalidate";
import { startWatcher } from "./watcher/watcher";
import { runBench } from "./bench";

const [cmd, rootArg] = process.argv.slice(2);
const root = resolve(rootArg ?? ".");
const claudePath = join(root, "CLAUDE.md");

function regen(db: ReturnType<typeof openDb>) {
  const r = regenerateFile(claudePath, renderBlocks(db));
  for (const w of r.warnings) console.error(`[knotgraph] ${w}`);
  return r.changed;
}

switch (cmd) {
  case "build": {
    const db = openDb(join(root, ".knotgraph", "graph.db"));
    console.log(JSON.stringify(await indexAll(db, root)));
    console.log(regen(db) ? "CLAUDE.md updated" : "CLAUDE.md unchanged");
    break;
  }
  case "watch": {
    const db = openDb(join(root, ".knotgraph", "graph.db"));
    console.error(`[knotgraph] cold index`, JSON.stringify(await indexAll(db, root)));
    regen(db);
    let timer: Timer | undefined;
    const w = startWatcher(db, root, (e) => {
      console.error(`[knotgraph] ${e.kind} ${e.path} ${e.applied ? `reindexed in ${e.ms.toFixed(1)}ms` : "unchanged"}`);
      if (!e.applied) return;
      clearTimeout(timer);
      timer = setTimeout(() => regen(db) && console.error("[knotgraph] CLAUDE.md updated"), 100);
    });
    await w.ready;
    console.error(`[knotgraph] watching ${root}`);
    process.on("SIGINT", async () => { await w.close(); process.exit(0); });
    break;
  }
  case "bench":
    await runBench();
    break;
  default:
    console.error("usage: index.ts watch|build <root> | bench");
    process.exit(1);
}
