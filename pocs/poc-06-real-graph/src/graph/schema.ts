import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type NodeType = "function" | "class" | "file" | "test" | "adr" | "rule" | "ticket";
export type Relation = "CALLS" | "IMPLEMENTS" | "TESTS" | "CONTAINS" | "CONSTRAINS" | "TRACKS";
export type Confidence = "strict" | "inferred";

export interface NodeRow {
  id: string;
  type: NodeType;
  name: string;
  path: string;
  title: string | null;
  status: string | null;
  content_hash: string;
  start_line: number;
  end_line: number;
  indexed_at: number;
}

const SCHEMA_VERSION = 2;

// Union of PoC 02 (refs table, scoped invalidation) and PoC 03 (confidence/score, rule/ticket nodes) schemas.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('function','class','file','test','adr','rule','ticket')),
  name TEXT NOT NULL, path TEXT NOT NULL, title TEXT, status TEXT,
  content_hash TEXT NOT NULL, start_line INTEGER NOT NULL DEFAULT 1, end_line INTEGER NOT NULL DEFAULT 1,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('CALLS','IMPLEMENTS','TESTS','CONTAINS','CONSTRAINS','TRACKS')),
  confidence TEXT NOT NULL DEFAULT 'strict' CHECK (confidence IN ('strict','inferred')),
  score REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, relation_type);
-- Name-based references (CALLS / TESTS / IMPLEMENTS) awaiting resolution against current nodes.
CREATE TABLE IF NOT EXISTS refs (source_id TEXT NOT NULL, target_name TEXT NOT NULL, relation_type TEXT NOT NULL, path TEXT NOT NULL, hint TEXT);
CREATE INDEX IF NOT EXISTS idx_refs_path ON refs(path);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_name);
`;

export function openDb(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
  // The graph is a derived cache: on a schema change, drop it and let the next index rebuild it.
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (version !== SCHEMA_VERSION) {
    db.exec("DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS nodes;");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(SCHEMA);
  return db;
}

export interface PlanNode {
  id: string; type: NodeType; name: string; path: string; title: string | null; status: string | null;
  hash: string; start: number; end: number;
}
export interface PlanEdge { source: string; target: string; rel: Relation; confidence?: Confidence; score?: number }
/** `hint`: module path (no extension) the name was imported from, when known. */
export interface PlanRef { source: string; targetName: string; rel: "CALLS" | "TESTS" | "IMPLEMENTS"; hint?: string | null }
export interface Plan { nodes: PlanNode[]; edges: PlanEdge[]; refs: PlanRef[]; tickets: string[] }

/** Remove every node/ref of a file and every edge touching its nodes. */
export function deletePath(db: Database, path: string): void {
  db.run("DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE path = ?1) OR target_id IN (SELECT id FROM nodes WHERE path = ?1)", [path]);
  db.run("DELETE FROM refs WHERE path = ?", [path]);
  db.run("DELETE FROM nodes WHERE path = ?", [path]);
}

export function applyPlan(db: Database, path: string, p: Plan, now: number): void {
  // Tickets are virtual nodes shared across files: created on demand, garbage-collected when nothing tracks them.
  for (const t of p.tickets) db.run("INSERT OR IGNORE INTO nodes (id,type,name,path,title,status,content_hash,indexed_at) VALUES (?,?,?,?,NULL,NULL,'',?)", [`ticket:${t}`, "ticket", t, `ticket:${t}`, now]);
  for (const n of p.nodes) db.run("INSERT OR REPLACE INTO nodes (id,type,name,path,title,status,content_hash,start_line,end_line,indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [n.id, n.type, n.name, n.path, n.title, n.status, n.hash, n.start, n.end, now]);
  for (const e of p.edges) db.run("INSERT OR REPLACE INTO edges VALUES (?,?,?,?,?)", [e.source, e.target, e.rel, e.confidence ?? "strict", e.score ?? 1]);
  for (const r of p.refs) db.run("INSERT INTO refs VALUES (?,?,?,?,?)", [r.source, r.targetName, r.rel, path, r.hint ?? null]);
}

export function gcTickets(db: Database): void {
  db.run("DELETE FROM nodes WHERE type = 'ticket' AND NOT EXISTS (SELECT 1 FROM edges WHERE source_id = nodes.id)");
}

/**
 * Candidate ranking for a reference to `name`:
 *   0 = defined in the same file, 1 = defined in the module the name was imported from, 2 = any other node of that name.
 * Only the best rank present is kept. One survivor => strict; several => inferred, score 1/n.
 */
const RESOLVE = (typeFilter: string, rels: string, cond: string) => `
INSERT OR REPLACE INTO edges (source_id,target_id,relation_type,confidence,score)
WITH c AS (
  SELECT r.rowid rid, r.source_id, n.id target_id, r.relation_type rel,
         CASE WHEN n.path = r.path THEN 0
              WHEN r.hint IS NOT NULL AND (substr(n.path, 1, length(r.hint) + 1) = r.hint || '.' OR substr(n.path, 1, length(r.hint) + 7) = r.hint || '/index.') THEN 1
              ELSE 2 END prio
    FROM refs r JOIN nodes n ON n.name = r.target_name AND n.type IN (${typeFilter})
   WHERE r.relation_type IN (${rels}) AND n.id <> r.source_id AND (${cond})
), m AS (SELECT *, MIN(prio) OVER (PARTITION BY rid) mp FROM c),
f AS (SELECT *, COUNT(*) OVER (PARTITION BY rid) cnt FROM m WHERE prio = mp)
SELECT source_id, target_id, rel,
       CASE WHEN cnt > 1 THEN 'inferred' ELSE 'strict' END,
       CASE WHEN cnt > 1 THEN 1.0 / cnt ELSE 1.0 END
  FROM f`;

const CODE_T = "'function','class'";

/**
 * Resolve name-based refs into edges. A reference to a name that matches several nodes becomes
 * several `inferred` edges (score 1/n); a unique match is `strict`.
 * `names`/`path` restrict the work to what a single file change can affect:
 *  - the file's own refs (outward), and
 *  - every ref anywhere that targets a name the file defined before or defines now (inbound, and
 *    re-evaluation of strict/inferred when a homonym appears or disappears).
 */
export function resolveScoped(db: Database, path: string, names: string[]): void {
  const q = names.map(() => "?").join(",");
  if (names.length) {
    db.run(
      `DELETE FROM edges WHERE relation_type IN ('CALLS','TESTS','IMPLEMENTS') AND EXISTS (
         SELECT 1 FROM refs r WHERE r.source_id = edges.source_id AND r.relation_type = edges.relation_type
           AND r.target_name IN (${q}) AND r.target_name = (SELECT name FROM nodes WHERE id = edges.target_id))`,
      names,
    );
  }
  const cond = names.length ? `r.path = ? OR r.target_name IN (${q})` : "r.path = ?";
  const params = [path, ...names];
  db.run(RESOLVE(CODE_T, "'CALLS','TESTS'", cond), params);
  db.run(RESOLVE("'adr'", "'IMPLEMENTS'", cond), params);
}

export function resolveAll(db: Database): void {
  db.run("DELETE FROM edges WHERE relation_type IN ('CALLS','TESTS','IMPLEMENTS')");
  db.run(RESOLVE(CODE_T, "'CALLS','TESTS'", "1=1"));
  db.run(RESOLVE("'adr'", "'IMPLEMENTS'", "1=1"));
}
