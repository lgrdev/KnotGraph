use crate::db::{self, Node, Plan};
use crate::parser::{self, is_code_file};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct Indexer {
    pub conn: Connection,
    parser: tree_sitter::Parser,
    pub root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Change,
    Unlink,
}

#[derive(Debug)]
pub struct Applied {
    pub applied: bool,
    pub ms: f64,
}

#[derive(Debug, Default)]
pub struct Stats {
    pub files: usize,
    pub changed: usize,
    pub removed: usize,
    pub ms: f64,
}

pub fn is_ignored(rel: &str) -> bool {
    rel.split('/').any(|s| matches!(s, "node_modules" | ".git" | ".knotgraph" | "dist" | "target"))
}

pub fn is_doc_file(rel: &str) -> bool {
    rel.ends_with(".md") && rel.split('/').any(|s| matches!(s, "docs" | "ADR" | "adr")) && rel.contains('/')
}

pub fn is_indexable(rel: &str) -> bool {
    !is_ignored(rel) && (is_code_file(rel) || is_doc_file(rel))
}

/// FNV-1a 64: stable across runs and Rust versions (std's hasher makes no such promise).
fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn walk(root: &Path, dir: &Path, acc: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if is_ignored(&rel) {
            continue;
        }
        if p.is_dir() {
            walk(root, &p, acc);
        } else if is_indexable(&rel) {
            acc.push(rel);
        }
    }
}

impl Indexer {
    pub fn new(conn: Connection, root: &Path) -> Self {
        Self { conn, parser: parser::new_parser(), root: root.to_path_buf() }
    }

    /// Parse a file into rows (no DB access).
    pub fn plan(&mut self, rel: &str, source: &str) -> Plan {
        let hash = fnv(source);
        let lines = source.split('\n').count() as u32;
        let mut plan = Plan::default();
        let base = rel.rsplit('/').next().unwrap_or(rel).to_string();

        if is_doc_file(rel) {
            let d = parser::parse_doc(rel, source);
            let id = format!("adr:{}", d.id);
            plan.nodes.push(Node { id: id.clone(), kind: "adr", name: d.id, path: rel.into(), hash, start: 1, end: lines, title: Some(d.title) });
            for t in d.implements {
                plan.refs.push((id.clone(), t, "IMPLEMENTS"));
            }
            return plan;
        }

        let p = parser::parse_code(&mut self.parser, rel, source);
        if p.is_test {
            let id = format!("test:{rel}");
            plan.nodes.push(Node { id: id.clone(), kind: "test", name: base, path: rel.into(), hash, start: 1, end: lines, title: None });
            let mut seen = std::collections::BTreeSet::new();
            for (_, callee) in &p.calls {
                if p.imports.contains(callee) && seen.insert(callee.clone()) {
                    plan.refs.push((id.clone(), callee.clone(), "TESTS"));
                }
            }
            return plan;
        }

        let file_id = format!("file:{rel}");
        plan.nodes.push(Node { id: file_id.clone(), kind: "file", name: base, path: rel.into(), hash: hash.clone(), start: 1, end: lines, title: None });
        let id_of = |name: &str| p.symbols.iter().find(|s| s.name == name).map(|s| format!("{}:{}#{}", if s.is_class { "class" } else { "fn" }, rel, s.name));
        for s in &p.symbols {
            let id = id_of(&s.name).unwrap();
            plan.nodes.push(Node { id: id.clone(), kind: if s.is_class { "class" } else { "function" }, name: s.name.clone(), path: rel.into(), hash: hash.clone(), start: s.start, end: s.end, title: None });
            plan.edges.push((file_id.clone(), id, "CONTAINS"));
        }
        for (caller, callee) in &p.calls {
            if let Some(src) = caller.as_deref().and_then(id_of) {
                plan.refs.push((src, callee.clone(), "CALLS"));
            }
        }
        for (adr, _, sym) in &p.refs {
            plan.refs.push((sym.as_deref().and_then(id_of).unwrap_or_else(|| file_id.clone()), adr.clone(), "IMPLEMENTS"));
        }
        plan
    }

    fn stored_hash(&self, rel: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row("SELECT content_hash FROM nodes WHERE path = ?1 LIMIT 1", params![rel], |r| r.get(0)).optional()
    }

    /// Hot path: parse outside the transaction, then purge + insert + scoped resolve in ONE immediate transaction.
    pub fn apply_change(&mut self, rel: &str, kind: Kind) -> rusqlite::Result<Applied> {
        let t0 = Instant::now();
        let source = if kind == Kind::Unlink { None } else { std::fs::read_to_string(self.root.join(rel)).ok() };
        let prev = self.stored_hash(rel)?;
        let done = |applied| Applied { applied, ms: t0.elapsed().as_secs_f64() * 1000.0 };
        match (&source, &prev) {
            (Some(s), Some(h)) if &fnv(s) == h => return Ok(done(false)),
            (None, None) => return Ok(done(false)),
            _ => {}
        }
        let plan = source.as_deref().map(|s| self.plan(rel, s));
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        db::delete_path(&tx, rel)?;
        if let Some(p) = &plan {
            db::apply_plan(&tx, rel, p, now_ms())?;
        }
        db::resolve_for(&tx, rel)?;
        tx.commit()?;
        Ok(done(true))
    }

    /// Cold start: index every file, one global resolve.
    pub fn index_all(&mut self) -> rusqlite::Result<Stats> {
        let t0 = Instant::now();
        let mut files = vec![];
        walk(&self.root.clone(), &self.root.clone(), &mut files);
        let (mut changed, mut removed) = (0, 0);
        self.conn.execute_batch("BEGIN")?;
        for f in &files {
            let Ok(src) = std::fs::read_to_string(self.root.join(f)) else { continue };
            if self.stored_hash(f)?.as_deref() == Some(fnv(&src).as_str()) {
                continue;
            }
            let plan = self.plan(f, &src);
            db::delete_path(&self.conn, f)?;
            db::apply_plan(&self.conn, f, &plan, now_ms())?;
            changed += 1;
        }
        let known: Vec<String> = {
            let mut st = self.conn.prepare("SELECT DISTINCT path FROM nodes")?;
            st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        let present: std::collections::HashSet<&String> = files.iter().collect();
        for p in known.iter().filter(|p| !present.contains(p)) {
            db::delete_path(&self.conn, p)?;
            removed += 1;
        }
        if changed > 0 || removed > 0 {
            db::resolve_all(&self.conn)?;
        }
        self.conn.execute_batch("COMMIT")?;
        Ok(Stats { files: files.len(), changed, removed, ms: t0.elapsed().as_secs_f64() * 1000.0 })
    }
}
