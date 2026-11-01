use rusqlite::{Connection, params};
use std::path::Path;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
  content_hash TEXT NOT NULL, start_line INTEGER NOT NULL DEFAULT 1, end_line INTEGER NOT NULL DEFAULT 1,
  title TEXT, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, relation_type);
CREATE TABLE IF NOT EXISTS refs (source_id TEXT NOT NULL, target_name TEXT NOT NULL, relation_type TEXT NOT NULL, path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_refs_path ON refs(path);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_name);
";

pub struct Node {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub path: String,
    pub hash: String,
    pub start: u32,
    pub end: u32,
    pub title: Option<String>,
}

#[derive(Default)]
pub struct Plan {
    pub nodes: Vec<Node>,
    pub edges: Vec<(String, String, &'static str)>,
    pub refs: Vec<(String, String, &'static str)>,
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Remove every node/ref and every edge touching the file's nodes.
pub fn delete_path(c: &Connection, path: &str) -> rusqlite::Result<()> {
    c.execute(
        "DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE path = ?1) OR target_id IN (SELECT id FROM nodes WHERE path = ?1)",
        params![path],
    )?;
    c.execute("DELETE FROM refs WHERE path = ?1", params![path])?;
    c.execute("DELETE FROM nodes WHERE path = ?1", params![path])?;
    Ok(())
}

pub fn apply_plan(c: &Connection, path: &str, plan: &Plan, now_ms: i64) -> rusqlite::Result<()> {
    let mut n = c.prepare_cached("INSERT OR REPLACE INTO nodes (id,type,name,path,content_hash,start_line,end_line,title,indexed_at) VALUES (?,?,?,?,?,?,?,?,?)")?;
    for x in &plan.nodes {
        n.execute(params![x.id, x.kind, x.name, x.path, x.hash, x.start, x.end, x.title, now_ms])?;
    }
    let mut e = c.prepare_cached("INSERT OR IGNORE INTO edges VALUES (?,?,?)")?;
    for (s, t, r) in &plan.edges {
        e.execute(params![s, t, r])?;
    }
    let mut r = c.prepare_cached("INSERT INTO refs VALUES (?,?,?,?)")?;
    for (s, t, rel) in &plan.refs {
        r.execute(params![s, t, rel, path])?;
    }
    Ok(())
}

/// Re-create only the edges involving `path` (as ref owner or as target node): O(file), not O(graph).
pub fn resolve_for(c: &Connection, path: &str) -> rusqlite::Result<()> {
    for side in ["r.path = ?1", "n.path = ?1"] {
        c.prepare_cached(&format!(
            "INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, r.relation_type FROM refs r JOIN nodes n ON n.name = r.target_name
             WHERE r.relation_type IN ('CALLS','TESTS') AND n.type IN ('function','class') AND n.id <> r.source_id AND {side}"
        ))?
        .execute(params![path])?;
        c.prepare_cached(&format!(
            "INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, 'IMPLEMENTS' FROM refs r JOIN nodes n ON n.name = r.target_name
             WHERE r.relation_type = 'IMPLEMENTS' AND n.type = 'adr' AND n.id <> r.source_id AND {side}"
        ))?
        .execute(params![path])?;
    }
    Ok(())
}

/// Full rebuild of resolved edges (cold start).
pub fn resolve_all(c: &Connection) -> rusqlite::Result<()> {
    c.execute("DELETE FROM edges WHERE relation_type IN ('CALLS','TESTS','IMPLEMENTS')", [])?;
    c.execute(
        "INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, r.relation_type FROM refs r JOIN nodes n ON n.name = r.target_name
         WHERE r.relation_type IN ('CALLS','TESTS') AND n.type IN ('function','class') AND n.id <> r.source_id",
        [],
    )?;
    c.execute(
        "INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, 'IMPLEMENTS' FROM refs r JOIN nodes n ON n.name = r.target_name
         WHERE r.relation_type = 'IMPLEMENTS' AND n.type = 'adr' AND n.id <> r.source_id",
        [],
    )?;
    Ok(())
}
