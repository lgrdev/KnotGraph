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
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('function','class','file','test','adr','rule','ticket')),
  name         TEXT NOT NULL,
  path         TEXT NOT NULL,
  title        TEXT,
  status       TEXT,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  source_id     TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('CALLS','IMPLEMENTS','TESTS','CONTAINS','CONSTRAINS','TRACKS')),
  confidence    TEXT NOT NULL DEFAULT 'strict' CHECK (confidence IN ('strict','inferred')),
  score         REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, relation_type);
`;

export function openDb(file: string): Database {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
  db.exec(SCHEMA);
  return db;
}

export function addNode(db: Database, n: Omit<NodeRow, "content_hash"> & { content_hash?: string }): void {
  db.run("INSERT OR REPLACE INTO nodes (id,type,name,path,title,status,content_hash) VALUES (?,?,?,?,?,?,?)", [
    n.id, n.type, n.name, n.path, n.title, n.status, n.content_hash ?? `h-${n.id}`,
  ]);
}

export function addEdge(db: Database, s: string, t: string, r: Relation, confidence: Confidence = "strict", score = 1): void {
  db.run("INSERT OR REPLACE INTO edges VALUES (?,?,?,?,?)", [s, t, r, confidence, confidence === "strict" ? 1 : score]);
}
