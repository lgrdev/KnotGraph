# poc-02-reactive-indexer

PoC 02: hot incremental reindex (chokidar -> tree-sitter/gray-matter -> SQLite) and automatic regeneration of the dynamic blocks of `CLAUDE.md`.
Spec: `specifications/cahier_des_charges_poc_02_knotgraph.md`.

## Stack
Bun, `chokidar`, `web-tree-sitter` (pinned 0.25.10, see PoC 01), `gray-matter`, `bun:sqlite` (instead of better-sqlite3), `remark` + `remark-gfm` + `unist-util-visit`. Parsers and schema are copied from PoC 01 (PoC folders are isolated).

## Usage
```bash
bun install
bun test
bun run bench                                 # synthetic 200 files + 100 edits through the real watcher
bun run src/index.ts build <root>             # cold index + regenerate <root>/CLAUDE.md once
bun run src/index.ts watch <root>             # cold index, then watch src/, docs/, ADR/
```
Add to your `CLAUDE.md` (markers are never inserted automatically):
```md
<!-- KNOTGRAPH:ARCHITECTURE:START -->
<!-- KNOTGRAPH:ARCHITECTURE:END -->
<!-- KNOTGRAPH:MAP:START -->
<!-- KNOTGRAPH:MAP:END -->
```

## How it works
- **Invalidation** (`src/graph/invalidate.ts`): per changed file, in one `BEGIN IMMEDIATE` transaction: purge its nodes/refs and every edge touching them, insert the newly parsed rows, re-create only the edges that involve that file (`resolveEdgesFor`). Parsing happens before the transaction. Unchanged content (same sha1) is skipped. On error: rollback.
- **Watcher**: one serial queue, per-path coalescing, `CLAUDE.md` is not watched (no loops).
- **CLAUDE.md**: remark only *locates* the marker comments (so markers in code fences are ignored); the replacement is spliced into the original string by offsets. Text outside markers is never re-serialized, so it stays byte-identical (CRLF kept). Missing/unbalanced/duplicated markers: block skipped with a warning. Write is atomic (temp + rename) and skipped when nothing changed.

## Results (this machine; `bun run bench`, 210 files ~ 10k LOC)
| KPI | Result | Target |
|---|---|---|
| Reindex transaction p50 / p95 | 1.4 / 2.0 ms | < 50 ms PASS |
| Event -> committed (incl. chokidar) p50 / p95 | 1.9 / 3.8 ms | < 50 ms PASS |
| CLAUDE.md regeneration p50 / p95 | 22 / 30 ms | (debounced 100 ms) |
| Manual sections preserved | 100% (tests + bench) | 100% PASS |
| Idle CPU (5 s) | ~0.4% in `watch` (2 ticks / 5 s), 0.8% in bench process | ~0% (PASS, < 1%) |
| RSS, steady state, `watch` | ~67 MB (4-file repo), **~81 MB** (210 files, after 100 edits) | < 100 MB PASS (spec relaxed from 50 MB) |
| RSS peak during initial index (210 files) | ~165 MB | not constrained by the KPI |

RSS breakdown measured: bare Bun 12 MB; Bun + `Parser.init()` (WASM) 33 MB; full `watch` 67 MB on a tiny repo, ~81 MB on 210 files. The original 50 MB target was not reachable with this stack; the decision (Nov 2026) is to keep Bun and set the target to < 100 MB steady-state RSS. The transient peak while indexing a cold repo (~165 MB) is the weak point; if it matters: lazy-load remark/grammars, index in smaller batches, or switch the indexer to the native Rust version (see `poc-04-rust-indexer`, ~7 MB).

## Limits
- Regeneration of the whole `MAP` block takes ~20 ms (full queries); fine at this size, would need incremental rendering for large graphs.
- Edges to a symbol that is removed from file A are not re-pointed to a same-named symbol in file B until B changes (name-based resolution, inherited from PoC 01).
- Only `src/`, `docs/`, `ADR/` are watched; the root `CLAUDE.md` of the repo has no markers yet (PoC only touches the target passed on the CLI).
