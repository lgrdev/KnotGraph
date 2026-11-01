# poc-04-rust-indexer

PoC 04: does a native Rust rewrite of the **hot path** of PoC 02 (watch -> parse -> single SQLite transaction) fit the < 50 MB RSS target that the Bun/TypeScript version misses (~67 MB)?
Same SQLite schema and node ids as PoC 02, same bench scenario. Not a full port: see "Scope".

## Stack
Rust 2024, `tree-sitter` + `tree-sitter-typescript` (native C, no WASM), `rusqlite` (bundled SQLite), `notify` (inotify). No other crate: hashing is FNV-1a, frontmatter and `@ref` parsing are hand-written.

## Usage
```bash
cargo build --release              # ~4 MB stripped binary
cargo test --release               # 9 tests
./target/release/rust-indexer index <root>   # cold index -> <root>/.knotgraph/graph.db
./target/release/rust-indexer watch <root>   # cold index, then watch src/ docs/ ADR/
./target/release/rust-indexer bench          # 200 files + 10 ADRs, 100 edits through the real watcher
```

> Update (Nov 2026): the team kept Bun/TypeScript and relaxed the memory target to < 100 MB (PoC 02 measures ~81 MB on 210 files). This PoC stays as the documented plan B, not the chosen path.

## Results (this machine)
| KPI | PoC 02 (Bun/TS) | PoC 04 (Rust) | Target |
|---|---|---|---|
| RSS, `watch` on a 4-file repo | ~67 MB | **~6.1 MB** | < 50 MB |
| RSS, 210 files (~10k LOC) after 100 edits | n/a (bench process 166 MB, includes data generation) | **~7.0 MB** | < 50 MB |
| Reindex transaction p50 / p95 | 1.4 / 2.0 ms | 1.7 / 1.9 ms | < 50 ms |
| Event -> committed, p50 / p95 | 1.9 / 3.8 ms | 7.0 / 7.3 ms | < 50 ms |
| Cold index, 210 files | ~300 ms | ~86 ms | n/a |
| Idle CPU | ~0.4 % | 0.00 % (0 ticks / 5 s) | ~0 % |

Event latency is higher than PoC 02 on purpose: the watcher waits 5 ms to coalesce bursts on the same path (so ~5 ms of the 7 ms is that window). The transaction itself is the same ~1-2 ms; SQLite dominates in both.

**Verdict:** the memory gap is the runtime, not the algorithm. Bun (12 MB) + WASM tree-sitter (33 MB total) + chokidar/remark leave no room under 50 MB; native Rust sits at ~7 MB, 10x under target, with equal latency. Go was not tried; the pasted estimate (20-30 MB) is plausible but unmeasured here.

## Bug found while building (kept as a regression test)
Reading a file emits an inotify `Access` event; if the watcher reacts to it, its own read re-triggers it forever (77 self-triggered events in 400 ms in the test, 50 % CPU at idle). Fix: ignore access/other events. `watcher_applies_edits_and_does_not_loop_on_own_reads` fails without the filter (verified). The chokidar version does not have the problem.

## Scope (what this PoC does NOT cover)
- No `CLAUDE.md` block builder and no MCP server: a Rust marker splicer is easy and would not move the RSS, but it is not measured. A production design would be this indexer writing the shared SQLite file, with the TS MCP server reading it.
- JS files are parsed with the TypeScript grammar (no JSX-specific handling).
- Frontmatter parser is minimal (`id`, `title`, `implements` as scalar, `[a, b]` or `- x` list); no general YAML.
- Watches `src/`, `docs/`, `ADR/` that exist at startup; directories created later are not picked up.
- Name-based edge resolution, as in PoC 01/02 (same limitation).
- Linux/inotify only was run; `notify` supports macOS/Windows but that is untested.

## Cost of choosing Rust
A second toolchain and language next to the TS MCP server/blast-radius engine, a ~4 MB native binary per platform, and C compilation (gcc) for SQLite and tree-sitter at build time. Worth it only if the < 50 MB resident budget is a real product constraint.
