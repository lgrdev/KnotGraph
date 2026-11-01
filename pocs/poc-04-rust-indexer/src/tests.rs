use crate::db;
use crate::index::{Indexer, Kind};
use crate::parser;
use crate::watch;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/sample-repo")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, t) = (e.path(), to.join(e.file_name()));
        if p.is_dir() { copy_dir(&p, &t) } else { std::fs::copy(&p, &t).unwrap(); }
    }
}

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn setup(tag: &str) -> (Tmp, Indexer) {
    let root = std::env::temp_dir().join(format!("kg4-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    copy_dir(&fixture(), &root);
    let mut ix = Indexer::new(db::open_memory().unwrap(), &root);
    ix.index_all().unwrap();
    (Tmp(root), ix)
}

fn dump(c: &Connection, sql: &str) -> Vec<String> {
    let mut st = c.prepare(sql).unwrap();
    st.query_map([], |r| Ok(format!("{}|{}|{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).unwrap().map(|r| r.unwrap()).collect()
}

const EDGES: &str = "SELECT source_id, target_id, relation_type FROM edges ORDER BY 1,2,3";

fn has_edge(c: &Connection, s: &str, t: &str, r: &str) -> bool {
    c.query_row(
        "SELECT COUNT(*) FROM edges e JOIN nodes a ON a.id=e.source_id JOIN nodes b ON b.id=e.target_id WHERE a.name=?1 AND b.name=?2 AND e.relation_type=?3",
        [s, t, r],
        |x| x.get::<_, i64>(0),
    )
    .unwrap()
        == 1
}

#[test]
fn parser_extracts_symbols_imports_calls_refs() {
    let mut p = parser::new_parser();
    let src = std::fs::read_to_string(fixture().join("src/vat.ts")).unwrap();
    let c = parser::parse_code(&mut p, "src/vat.ts", &src);
    assert_eq!(c.symbols.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["calculateVAT"]);
    assert!(c.imports.contains(&"getRate".to_string()));
    assert!(c.calls.contains(&(Some("calculateVAT".into()), "getRate".into())));
    assert_eq!(c.refs, vec![("ADR-001".to_string(), 3, Some("calculateVAT".to_string()))]);
}

#[test]
fn parser_handles_arrow_class_method() {
    let mut p = parser::new_parser();
    let c = parser::parse_code(&mut p, "a.ts", "export const f = (x: number) => g(x);\nclass K { m() { return f(1); } }\n");
    let names: Vec<_> = c.symbols.iter().map(|s| (s.name.as_str(), s.is_class)).collect();
    assert_eq!(names, [("f", false), ("K", true), ("m", false)]);
    assert!(c.calls.contains(&(Some("m".into()), "f".into())));
}

#[test]
fn doc_frontmatter() {
    let d = parser::parse_doc("docs/ADR-004-x.md", "---\nid: ADR-004\ntitle: \"VAT\"\nimplements: [ADR-001, ADR-002]\n---\n# Heading\n");
    assert_eq!((d.id.as_str(), d.title.as_str(), d.implements.len()), ("ADR-004", "VAT", 2));
    let d = parser::parse_doc("docs/ADR-009-y.md", "# Order flow\n");
    assert_eq!((d.id.as_str(), d.title.as_str()), ("ADR-009", "Order flow"));
    let d = parser::parse_doc("docs/z.md", "---\nimplements:\n  - A\n  - B\n---\n");
    assert_eq!(d.implements, ["A", "B"]);
}

#[test]
fn cold_index_builds_graph() {
    let (_t, ix) = setup("cold");
    assert!(has_edge(&ix.conn, "calculateVAT", "ADR-001", "IMPLEMENTS"));
    assert!(has_edge(&ix.conn, "cartTotal", "calculateVAT", "CALLS"));
}

#[test]
fn change_touches_only_that_file_and_restores_inbound_edges() {
    let (t, mut ix) = setup("change");
    let before = dump(&ix.conn, "SELECT id, type, content_hash FROM nodes WHERE path='src/rates.ts' ORDER BY 1");
    let mut src = std::fs::read_to_string(t.0.join("src/vat.ts")).unwrap();
    src += "\nexport function extra() { return calculateVAT(1, 'FR'); }\n";
    std::fs::write(t.0.join("src/vat.ts"), src).unwrap();
    let a = ix.apply_change("src/vat.ts", Kind::Change).unwrap();
    assert!(a.applied && a.ms < 50.0);
    assert_eq!(before, dump(&ix.conn, "SELECT id, type, content_hash FROM nodes WHERE path='src/rates.ts' ORDER BY 1"));
    assert!(has_edge(&ix.conn, "extra", "calculateVAT", "CALLS"));
    assert!(has_edge(&ix.conn, "cartTotal", "calculateVAT", "CALLS"));
    assert!(has_edge(&ix.conn, "calculateVAT", "ADR-001", "IMPLEMENTS"));
}

#[test]
fn unchanged_content_skipped() {
    let (_t, mut ix) = setup("same");
    assert!(!ix.apply_change("src/vat.ts", Kind::Change).unwrap().applied);
}

#[test]
fn unlink_removes_nodes_and_all_touching_edges() {
    let (t, mut ix) = setup("unlink");
    std::fs::remove_file(t.0.join("src/vat.ts")).unwrap();
    assert!(ix.apply_change("src/vat.ts", Kind::Unlink).unwrap().applied);
    let n: i64 = ix.conn.query_row("SELECT COUNT(*) FROM nodes WHERE path='src/vat.ts'", [], |r| r.get(0)).unwrap();
    let e: i64 = ix.conn.query_row("SELECT COUNT(*) FROM edges WHERE source_id LIKE '%vat.ts%' OR target_id LIKE '%vat.ts%'", [], |r| r.get(0)).unwrap();
    assert_eq!((n, e), (0, 0));
}

#[test]
fn incremental_equals_full_reindex() {
    let (t, mut ix) = setup("equiv");
    std::fs::write(t.0.join("src/new.ts"), "import { getRate } from './rates';\nexport function useRate() { return getRate('FR'); }\n").unwrap();
    ix.apply_change("src/new.ts", Kind::Change).unwrap();
    let mut full = Indexer::new(db::open_memory().unwrap(), &t.0);
    full.index_all().unwrap();
    assert_eq!(dump(&ix.conn, EDGES), dump(&full.conn, EDGES));
}

#[test]
fn watcher_applies_edits_and_does_not_loop_on_own_reads() {
    let (t, ix) = setup("watch");
    let (etx, erx) = mpsc::channel();
    let (rtx, rrx) = mpsc::channel();
    let root = t.0.clone();
    std::thread::spawn(move || { let _ = watch::run(ix, &root, etx, Some(rtx)); });
    rrx.recv().unwrap();
    std::fs::write(t.0.join("src/fresh.ts"), "export function fresh() { return 1; }\n").unwrap();
    let ev = erx.recv_timeout(Duration::from_secs(3)).expect("event");
    assert!(ev.path == "src/fresh.ts" && ev.applied);
    // Regression: our own read used to emit an inotify Access event -> endless "unchanged" events.
    std::thread::sleep(Duration::from_millis(400));
    let extra: Vec<_> = erx.try_iter().filter(|e| !e.applied).collect();
    assert!(extra.is_empty(), "self-triggered events: {}", extra.len());
    std::fs::remove_file(t.0.join("src/fresh.ts")).unwrap();
    let ev = erx.recv_timeout(Duration::from_secs(3)).expect("unlink event");
    assert!(ev.path == "src/fresh.ts" && ev.applied);
}
