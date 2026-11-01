use crate::index::{Indexer, Kind, is_indexable};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

pub struct Event {
    pub path: String,
    pub applied: bool,
    pub ms: f64,
}

/// Watch src/, docs/, ADR/ (those that exist). Runs on the calling thread until the channel closes.
/// Events are coalesced per path over a short window and applied serially.
pub fn run(mut ix: Indexer, root: &Path, on_event: Sender<Event>, ready: Option<Sender<()>>) -> notify::Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut w = RecommendedWatcher::new(tx, Config::default())?;
    for d in ["src", "docs", "ADR"] {
        let p = root.join(d);
        if p.is_dir() {
            w.watch(&p, RecursiveMode::Recursive)?;
        }
    }
    if let Some(r) = ready {
        let _ = r.send(());
    }
    loop {
        let Ok(first) = rx.recv() else { return Ok(()) };
        let mut paths = BTreeSet::new();
        let mut collect = |e: notify::Result<notify::Event>| {
            // Ignore Access events: our own read of the file would otherwise re-trigger us forever.
            if let Some(e) = e.ok().filter(|e| !e.kind.is_access() && !e.kind.is_other()) {
                for p in e.paths {
                    if let Ok(rel) = p.strip_prefix(root) {
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if is_indexable(&rel) {
                            paths.insert(rel);
                        }
                    }
                }
            }
        };
        collect(first);
        while let Ok(e) = rx.recv_timeout(Duration::from_millis(5)) {
            collect(e);
        }
        for rel in paths {
            // Existence decides the kind: robust against rename/create/modify event flavours.
            let kind = if root.join(&rel).is_file() { Kind::Change } else { Kind::Unlink };
            match ix.apply_change(&rel, kind) {
                Ok(a) => {
                    if on_event.send(Event { path: rel, applied: a.applied, ms: a.ms }).is_err() {
                        return Ok(());
                    }
                }
                Err(e) => eprintln!("[knotgraph] error on {rel}: {e}"),
            }
        }
    }
}
