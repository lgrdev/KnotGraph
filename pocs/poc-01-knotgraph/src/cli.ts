import { join, resolve } from "node:path";
import { openDb } from "./db";
import { indexAll } from "./indexer";
import { serveStdio } from "./mcp/server";
import { startWatcher } from "./watcher";
import { runBench } from "./bench";

const [cmd, rootArg] = process.argv.slice(2);
const root = resolve(rootArg ?? ".");
const dbPath = () => join(root, ".knotgraph", "graph.db");

switch (cmd) {
  case "index": {
    const s = await indexAll(openDb(dbPath()), root);
    console.log(JSON.stringify(s));
    break;
  }
  case "serve": {
    const db = openDb(dbPath());
    await indexAll(db, root);
    startWatcher(db, root, (p, ms) => console.error(`[knotgraph] reindexed ${p} in ${ms.toFixed(1)}ms`));
    process.stdin.on("end", () => process.exit(0)); // client gone -> stop watcher
    await serveStdio(db); // stdout reserved for MCP; logs go to stderr
    break;
  }
  case "bench":
    await runBench();
    break;
  default:
    console.error("usage: cli.ts index|serve <root> | bench");
    process.exit(1);
}
