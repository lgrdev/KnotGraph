import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type NodeType = "function" | "class" | "file" | "adr" | "test";
export type RelationType = "CALLS" | "IMPLEMENTS" | "TESTS" | "CONTAINS";

export interface NodeRow {
  id: string;
  type: NodeType;
  name: string;
  path: string;
  content_hash: string;
  start_line: number;
  end_line: number;
  title: string | null;
  indexed_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('function','class','file','adr','test')),
  name         TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_line   INTEGER NOT NULL DEFAULT 1,
  end_line     INTEGER NOT NULL DEFAULT 1,
  title        TEXT,
  indexed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  source_id     TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('CALLS','IMPLEMENTS','TESTS','CONTAINS')),
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, relation_type);

-- Name-based references awaiting resolution (rebuilt into edges by resolveEdges).
CREATE TABLE IF NOT EXISTS refs (
  source_id     TEXT NOT NULL,
  target_name   TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  path          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_path ON refs(path);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_name);
`;

export function openDb(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
  db.exec(SCHEMA);
  return db;
}

/** Remove every node/ref/edge belonging to a file (edges touching its nodes included). */
export function deletePath(db: Database, path: string): void {
  db.run(
    "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE path = ?1) OR target_id IN (SELECT id FROM nodes WHERE path = ?1)",
    [path],
  );
  db.run("DELETE FROM refs WHERE path = ?", [path]);
  db.run("DELETE FROM nodes WHERE path = ?", [path]);
}

export function insertNode(db: Database, n: NodeRow): void {
  db.run(
    "INSERT OR REPLACE INTO nodes (id,type,name,path,content_hash,start_line,end_line,title,indexed_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [n.id, n.type, n.name, n.path, n.content_hash, n.start_line, n.end_line, n.title, n.indexed_at],
  );
}

export function insertEdge(db: Database, s: string, t: string, r: RelationType): void {
  db.run("INSERT OR IGNORE INTO edges VALUES (?,?,?)", [s, t, r]);
}

export function insertRef(db: Database, source: string, targetName: string, r: RelationType, path: string): void {
  db.run("INSERT INTO refs VALUES (?,?,?,?)", [source, targetName, r, path]);
}

/** Rebuild CALLS/TESTS/IMPLEMENTS edges from refs. CALLS/TESTS target code symbols, IMPLEMENTS targets adr nodes. */
export function resolveEdges(db: Database): void {
  db.run("DELETE FROM edges WHERE relation_type IN ('CALLS','TESTS','IMPLEMENTS')");
  db.run(`INSERT OR IGNORE INTO edges
    SELECT r.source_id, n.id, r.relation_type FROM refs r
    JOIN nodes n ON n.name = r.target_name
    WHERE r.relation_type IN ('CALLS','TESTS') AND n.type IN ('function','class') AND n.id <> r.source_id`);
  db.run(`INSERT OR IGNORE INTO edges
    SELECT r.source_id, n.id, 'IMPLEMENTS' FROM refs r
    JOIN nodes n ON n.name = r.target_name AND n.type = 'adr'
    WHERE r.relation_type = 'IMPLEMENTS' AND n.id <> r.source_id`);
}

/** Re-create only the edges that involve `path` (as ref owner or as target node). O(file), not O(graph). */
export function resolveEdgesFor(db: Database, path: string): void {
  for (const [rels, targetTypes] of [
    ["'CALLS','TESTS'", "'function','class'"],
    ["'IMPLEMENTS'", "'adr'"],
  ] as const) {
    const rel = rels === "'IMPLEMENTS'" ? "'IMPLEMENTS'" : "r.relation_type";
    for (const side of ["r.path = ?1", "n.path = ?1"]) {
      db.run(
        `INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, ${rel} FROM refs r
         JOIN nodes n ON n.name = r.target_name
         WHERE r.relation_type IN (${rels}) AND n.type IN (${targetTypes}) AND n.id <> r.source_id AND ${side}`,
        [path],
      );
    }
  }
}
