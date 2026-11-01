import type { Database } from "bun:sqlite";
import type { NodeRow } from "./db";

const loc = (n: NodeRow) => ({ path: n.path, line: n.start_line, end_line: n.end_line });
const adrOut = (n: NodeRow) => ({ id: n.name, title: n.title, ...loc(n) });
const testOut = (n: NodeRow) => ({ name: n.name, path: n.path });

function provenanceBlock(db: Database, nodes: NodeRow[]) {
  return {
    source: "knotgraph",
    nodes: nodes.map((n) => ({ id: n.id, path: n.path, content_hash: n.content_hash, indexed_at: new Date(n.indexed_at).toISOString() })),
  };
}

export function findSymbols(db: Database, name: string): NodeRow[] {
  return db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE name = ? AND type IN ('function','class')").all(name);
}

const fileOf = (db: Database, n: NodeRow) => db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(`file:${n.path}`);

/** ADRs implemented by the symbol, or by its file (@ref outside any symbol). */
function adrsFor(db: Database, ids: string[]): NodeRow[] {
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  return db
    .query<NodeRow, string[]>(`SELECT DISTINCT a.* FROM edges e JOIN nodes a ON a.id = e.target_id WHERE e.relation_type='IMPLEMENTS' AND a.type='adr' AND e.source_id IN (${q}) ORDER BY a.name`)
    .all(...ids);
}

function testsFor(db: Database, ids: string[]): NodeRow[] {
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  return db
    .query<NodeRow, string[]>(`SELECT DISTINCT t.* FROM edges e JOIN nodes t ON t.id = e.source_id WHERE e.relation_type='TESTS' AND e.target_id IN (${q}) ORDER BY t.path`)
    .all(...ids);
}

function callers(db: Database, id: string, transitive: boolean): NodeRow[] {
  const sql = transitive
    ? `WITH RECURSIVE c(id) AS (SELECT source_id FROM edges WHERE relation_type='CALLS' AND target_id = ?1
         UNION SELECT e.source_id FROM edges e JOIN c ON e.target_id = c.id WHERE e.relation_type='CALLS')
       SELECT n.* FROM nodes n JOIN c ON n.id = c.id ORDER BY n.path, n.start_line`
    : `SELECT n.* FROM edges e JOIN nodes n ON n.id = e.source_id WHERE e.relation_type='CALLS' AND e.target_id = ?1 ORDER BY n.path, n.start_line`;
  return db.query<NodeRow, [string]>(sql).all(id);
}

export function getNodeProvenance(db: Database, symbol: string) {
  const found = findSymbols(db, symbol);
  if (!found.length) return { found: false, symbol, message: `No function or class named '${symbol}' in graph` };
  const results = found.map((n) => {
    const file = fileOf(db, n);
    const adrs = adrsFor(db, [n.id, ...(file ? [file.id] : [])]);
    const tests = testsFor(db, [n.id]);
    return {
      symbol: { name: n.name, kind: n.type, ...loc(n) },
      file: file ? { path: file.path, name: file.name } : { path: n.path },
      adrs: adrs.map(adrOut),
      tests: tests.map(testOut),
      provenance: provenanceBlock(db, [n, ...(file ? [file] : []), ...adrs, ...tests]),
    };
  });
  return { found: true, ambiguous: results.length > 1, results };
}

export function getEnrichedBlastRadius(db: Database, symbol: string) {
  const found = findSymbols(db, symbol);
  if (!found.length) return { found: false, symbol, message: `No function or class named '${symbol}' in graph` };
  const results = found.map((n) => {
    const direct = callers(db, n.id, false);
    const all = callers(db, n.id, true);
    const ids = [n.id, ...all.map((c) => c.id)];
    const fileIds = [...new Set([n, ...all].map((x) => `file:${x.path}`))];
    const tests = testsFor(db, ids);
    const specs = adrsFor(db, [...ids, ...fileIds]);
    return {
      symbol: { name: n.name, kind: n.type, ...loc(n) },
      direct_callers: direct.map((c) => ({ name: c.name, kind: c.type, ...loc(c) })),
      transitive_caller_count: all.length,
      tests_to_rerun: tests.map(testOut),
      impacted_specs: specs.map(adrOut),
      provenance: provenanceBlock(db, [n, ...direct, ...tests, ...specs]),
    };
  });
  return { found: true, ambiguous: results.length > 1, results };
}
