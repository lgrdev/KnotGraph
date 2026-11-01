use crate::{db, index::Indexer, watch};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn proc_kb(key: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with(key)).and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok())))
        .unwrap_or(0.0)
}

fn cpu_ticks() -> u64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let after = s.rsplit(')').next().unwrap_or("");
    let f: Vec<&str> = after.split_whitespace().collect();
    f.get(11).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) + f.get(12).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
}

fn body(f: usize, rev: usize) -> String {
    let mut s = if f > 0 { format!("import {{ fn{}_0 }} from \"./m{}\";\n", f - 1, f - 1) } else { String::new() };
    for i in 0..5 {
        if i == 0 {
            s += &format!("// @ref ADR-{:03}\n", f % 10 + 1);
        }
        let tail = if f > 0 && i == 0 { format!("return fn{}_0(b);", f - 1) } else { "return b;".into() };
        s += &format!("export function fn{f}_{i}(x: number): number {{\n  const a = x + {i} + {rev};\n  const b = a * 2;\n  if (b > 10) {{\n    return b - 1;\n  }}\n  {tail}\n}}\n\n");
    }
    s
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 * p) as usize).min(v.len() - 1)]
}

/// Same scenario as poc-02's bench: 200 files (~10k LOC) + 10 ADRs, 100 single-file edits through the real watcher.
pub fn run() {
    let root = std::env::temp_dir().join(format!("kg4-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    for f in 0..200 {
        std::fs::write(root.join(format!("src/m{f}.ts")), body(f, 0)).unwrap();
    }
    for d in 1..=10 {
        std::fs::write(root.join(format!("docs/ADR-{d:03}-x.md")), format!("---\nid: ADR-{d:03}\n---\n# ADR {d}\n")).unwrap();
    }
    let rss_before = proc_kb("VmRSS:") / 1024.0;
    let mut ix = Indexer::new(db::open(&root.join(".knotgraph/graph.db")).unwrap(), &root);
    let cold = ix.index_all().unwrap();

    let (etx, erx) = mpsc::channel::<watch::Event>();
    let (rtx, rrx) = mpsc::channel();
    let r2 = root.clone();
    std::thread::spawn(move || {
        let _ = watch::run(ix, &r2, etx, Some(rtx));
    });
    rrx.recv().unwrap();

    let (mut apply, mut e2e) = (vec![], vec![]);
    for i in 1..=100usize {
        let rel = format!("src/m{}.ts", i % 200);
        let t0 = Instant::now();
        std::fs::write(root.join(&rel), body(i % 200, i)).unwrap();
        loop {
            let ev = erx.recv_timeout(Duration::from_secs(5)).expect("event");
            if ev.path == rel && ev.applied {
                e2e.push(t0.elapsed().as_secs_f64() * 1000.0);
                apply.push(ev.ms);
                break;
            }
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    let rss = proc_kb("VmRSS:") / 1024.0;
    let hwm = proc_kb("VmHWM:") / 1024.0;
    let (c0, t0) = (cpu_ticks(), Instant::now());
    std::thread::sleep(Duration::from_secs(5));
    let cpu = (cpu_ticks() - c0) as f64 / 100.0 / t0.elapsed().as_secs_f64() * 100.0;

    let row = |n: &str, v: String, t: &str, ok: bool| println!("{n:<34} {v:>10}   (target {t})  {}", if ok { "PASS" } else { "FAIL" });
    println!("files={} cold={:.0}ms (baseline RSS before indexer {:.1}MB)", cold.files, cold.ms, rss_before);
    let (a50, a95) = (pct(&mut apply, 0.5), pct(&mut apply, 0.95));
    row("reindex txn p50", format!("{a50:.2}ms"), "<50ms", a50 < 50.0);
    row("reindex txn p95", format!("{a95:.2}ms"), "<50ms", a95 < 50.0);
    println!("{:<34} {:.1} / {:.1} ms", "event e2e p50/p95", pct(&mut e2e, 0.5), pct(&mut e2e, 0.95));
    row("RSS (steady)", format!("{rss:.1}MB"), "<50MB", rss < 50.0);
    println!("{:<34} {hwm:.1}MB (peak incl. test-data generation)", "VmHWM");
    row("idle CPU (5s)", format!("{cpu:.2}%"), "~0%", cpu < 1.0);
    let _ = std::fs::remove_dir_all(&root);
    std::process::exit(0);
}
