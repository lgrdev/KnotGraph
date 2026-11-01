mod bench;
mod db;
mod index;
mod parser;
mod watch;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::mpsc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let root = PathBuf::from(args.get(1).map(String::as_str).unwrap_or(".")).canonicalize().unwrap_or_else(|_| PathBuf::from("."));
    let db_path = root.join(".knotgraph").join("graph.db");
    match cmd {
        "index" => {
            let mut ix = index::Indexer::new(db::open(&db_path).expect("open db"), &root);
            let s = ix.index_all().expect("index");
            println!("{{\"files\":{},\"changed\":{},\"removed\":{},\"ms\":{:.1}}}", s.files, s.changed, s.removed, s.ms);
        }
        "watch" => {
            let mut ix = index::Indexer::new(db::open(&db_path).expect("open db"), &root);
            let s = ix.index_all().expect("index");
            eprintln!("[knotgraph] cold index {} files in {:.1}ms", s.files, s.ms);
            let (tx, rx) = mpsc::channel::<watch::Event>();
            let r2 = root.clone();
            std::thread::spawn(move || {
                if let Err(e) = watch::run(ix, &r2, tx, None) {
                    eprintln!("[knotgraph] watcher error: {e}");
                }
            });
            eprintln!("[knotgraph] watching {}", root.display());
            for e in rx {
                eprintln!("[knotgraph] {} {}", e.path, if e.applied { format!("reindexed in {:.2}ms", e.ms) } else { "unchanged".into() });
            }
        }
        "bench" => bench::run(),
        _ => {
            eprintln!("usage: rust-indexer index|watch <root> | bench");
            std::process::exit(1);
        }
    }
}
