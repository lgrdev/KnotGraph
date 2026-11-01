# poc-05-go-indexer

PoC 05: Go version of the indexing hot path (watch -> parse -> single SQLite transaction), to measure what Go actually costs in memory. Follow-up to `poc-04-rust-indexer` and to the "plan B" discussion in the product framing document (section 5.4).
Same SQLite schema, node ids and bench scenario as PoC 02 and 04. Not a full port: see "Scope".

## Stack
Go 1.25, `github.com/smacker/go-tree-sitter` (cgo, TypeScript grammar bundled), `github.com/mattn/go-sqlite3` (cgo, bundled SQLite), `github.com/fsnotify/fsnotify`. Hashing is `hash/fnv`; frontmatter and `@ref` parsing are hand-written. Needs gcc at build time (cgo).

## Usage
```bash
go build -o go-indexer .             # ~9.5 MB binary
go test ./...                        # 9 tests
./go-indexer index <root>            # cold index -> <root>/.knotgraph/graph.db
./go-indexer watch <root>            # cold index, then watch src/ docs/ ADR/
./go-indexer bench                   # 200 files + 10 ADRs, 100 edits through the real watcher
```

## Results (this machine; each `watch` process measured directly, 210 files = ~10k LOC + 10 ADRs)
| | Bun/TS (PoC 02) | Go (PoC 05) | Rust (PoC 04) | Target |
|---|---|---|---|---|
| RSS steady, 4-file repo | ~67 MB | 6.7 MB | 6.1 MB | < 100 MB |
| RSS steady, 210 files, after 100 edits | ~81 MB | **~15 MB** | ~7 MB (bench) / 6.4 MB (watch) | < 100 MB |
| RSS peak during cold index, 210 files | ~165 MB | ~14 MB | ~6.4 MB | not constrained |
| Reindex transaction p50 / p95 | 1.4 / 2.0 ms | 1.6 / 2.9 ms | 1.7 / 1.9 ms | < 50 ms |
| Event -> committed p50 / p95 | 1.9 / 3.8 ms | 6.8 / 8.3 ms | 7.0 / 7.3 ms | < 50 ms |
| Cold index, 210 files | ~300 ms | ~290 ms | ~86 ms | n/a |
| Idle CPU | ~0.4 % | 0.00 % | 0.00 % | ~0 % |
| Binary | runtime + node_modules | 9.5 MB | 4.1 MB | n/a |

Go tuning had little effect: `GOGC=50` gave 14.0 MB, `GOMEMLIMIT=30MiB` 15.2 MB (default 15.3 MB). The runtime and cgo libraries dominate, not the Go heap (heap in use ~2 MB).

Event latency includes a 5 ms coalescing window (same as the Rust version), so ~5 of the ~7 ms is deliberate.

## Verdict
- Go lands at ~15 MB: better than the 20-30 MB estimate that was floated, ~2x Rust, ~5x below Bun, and far below the 100 MB target. The big win over Bun is the cold-index peak (14 MB vs 165 MB).
- Cold index is 3.4x slower than Rust (290 vs 86 ms). I did not tune it: every row is an unprepared `Exec` through `database/sql` and cgo, and a prepared-statement or batched insert path would likely close part of the gap. Same order of magnitude as Bun.
- Neither native option is needed for the current < 100 MB target (Bun passes at ~81 MB steady). If the memory budget tightens, both fit; Rust is leaner (memory, cold start, binary size), Go is simpler to write and review.

## Notes from the port
- No feedback loop: `fsnotify` does not subscribe to inotify read/access events, so the self-triggering bug found in PoC 04 (`notify` delivering `Access` events) does not occur. The same regression test is kept (`TestWatcherAppliesEditsAndDoesNotLoopOnOwnReads`).
- Unlike the Rust version, directories created after startup are picked up (`fsnotify` has no recursive mode, so sub-directories are added explicitly, including new ones).
- `database/sql` with a single connection (`SetMaxOpenConns(1)`) keeps `:memory:` test databases on one connection and matches SQLite's single-writer model; `_txlock=immediate` gives the same `BEGIN IMMEDIATE` as the other PoCs.

## Scope (what this PoC does NOT cover)
- No `CLAUDE.md` block builder, no MCP server, no blast-radius engine.
- JS files parsed with the TypeScript grammar; minimal frontmatter parser (`id`, `title`, `implements`).
- Name-based edge resolution, as in the other PoCs.
- Linux/inotify only was run. `modernc.org/sqlite` (pure Go, no cgo) was not measured.
