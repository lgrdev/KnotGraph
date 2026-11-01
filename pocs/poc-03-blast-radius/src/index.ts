import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runBench } from "./bench";
import { analyze } from "./engine/analyze";
import { toMcpPayload } from "./formatters/mcp";
import { toTerminal } from "./formatters/terminal";
import { openDb } from "./graph/schema";
import { seedSample } from "./graph/seed";
import { serveStdio } from "./mcp/server";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string", default: ".knotgraph/blast.db" },
    file: { type: "string" },
    depth: { type: "string", default: "3" },
    json: { type: "boolean", default: false },
  },
});
const [cmd, arg] = positionals;
const dbPath = resolve(values.db!);

function openExisting() {
  if (!existsSync(dbPath)) {
    console.error(`No graph at ${dbPath}. Run \`seed\` first.`);
    process.exit(1);
  }
  return openDb(dbPath);
}

switch (cmd) {
  case "seed": {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true }); // fresh graph
    seedSample(openDb(dbPath));
    console.log(`seeded ${dbPath}`);
    break;
  }
  case "analyze": {
    if (!arg && !values.file) { console.error("usage: analyze <symbol> | analyze --file <path> [--depth N] [--json]"); process.exit(1); }
    const r = analyze(openExisting(), { symbol: arg, file: values.file, maxDepth: Number(values.depth) });
    if (!r) { console.error(`not found: ${arg ?? values.file}`); process.exit(2); }
    console.log(values.json ? JSON.stringify(toMcpPayload(r), null, 2) : toTerminal(r));
    break;
  }
  case "serve":
    await serveStdio(openExisting());
    break;
  case "bench":
    runBench();
    break;
  default:
    console.error("usage: index.ts seed | analyze <symbol> | serve | bench   (options: --db --file --depth --json)");
    process.exit(1);
}
