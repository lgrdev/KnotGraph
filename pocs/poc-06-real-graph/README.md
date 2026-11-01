# poc-06-real-graph

PoC 06: the blast-radius engine of PoC 03 running on a **graph extracted from real code**, instead of the hand-seeded one. Combines the incremental indexer of PoC 02 with the engine, formatters and MCP tool of PoC 03 (copied: PoC folders stay isolated).

## What is new vs PoC 02 / 03
- **Unified schema** (`src/graph/schema.ts`): PoC 02's `refs`/scoped invalidation + PoC 03's `confidence`/`score`, `rule` and `ticket` nodes, `CONSTRAINS` and `TRACKS` edges. The DB carries a schema version and is rebuilt when it changes (it is a derived cache).
- **Extractors for the layers PoC 03 had to seed**:
  - ADR frontmatter: `status`, `rules: [- RULE-ID: text]` -> `rule` nodes + `CONSTRAINS` (adr -> rule); `tickets: [ENG-102]` -> `ticket` nodes + `TRACKS` (ticket -> adr).
  - Code: `// @ticket ENG-102` above/inside a symbol -> `TRACKS` (ticket -> symbol); `// @ref ADR-004` -> `IMPLEMENTS` (as before).
  - Test files: suite name = first `describe/test/it` string, used as `suite` in the payload.
- **Real confidence instead of seeded**: a reference is `strict` when it resolves to one node, `inferred` (score 1/n) when it stays ambiguous. Candidates are ranked: (0) defined in the same file, (1) defined in the module it was imported from (relative imports, aliases resolved to the original name), (2) any node with that name. Only the best rank present is kept.
- **Live**: `serve` = cold index + chokidar watcher + MCP stdio, so answers follow edits (tested over stdio).

## Usage
```bash
bun install
bun test                                   # 22 tests
bun run src/index.ts index   --root <repo> # build <repo>/.knotgraph/graph.db, print counts
bun run src/index.ts analyze calculateVAT --root fixtures/shop [--depth N] [--json] [--file path]
bun run src/index.ts serve   --root <repo>
claude mcp add knotgraph-real -- bun run $PWD/src/index.ts serve --root <repo>
```

## Results
### Fixture `fixtures/shop` (16 files, written like a real repo: code, tests, ADRs with rules/tickets)
Ground truth on the **extracted** graph for `calculateVAT`: callers `checkoutCart`(d1), `generateInvoice`/`submitOrder`(d2), `sendInvoice`/`handleWebhook`(d3); 4 test suites; ADR-004 and ADR-009 (draft); 3 rules; tickets ENG-102, ENG-110; risk 0.76 HIGH. ADR-007 is correctly *not* reported: its `@ref` sits on `formatMoney`, a callee. (PoC 03's seeded graph reported it, because the seed said so.)
Incremental: an edit makes a new caller appear in the radius in < 50 ms; incremental graph == full reindex (nodes, edges, confidence) after add/change/unlink; a new homonym flips an unresolvable edge to `inferred` and removing it flips back; same-file targets never flip; orphan tickets are garbage-collected.

### Dogfood: this repository (94 TS files across PoC 01-03/06, no ADRs)
| | name-only resolution | ranked resolution (same file > imported module > any) |
|---|---|---|
| Edges | 994 | **585** |
| Inferred edges | 669 (67 %) | **32 (5.5 %)** |
| `computeRisk` "Tests to run" | 8, including PoC 01's MCP tests (unrelated) | 7, PoC 01's gone; the rest are tests of its transitive callers in PoC 03/06 |

The PoCs copy each other's functions, so name-only resolution (PoC 01-03) produced ~400 false links. Index 94 files in ~260 ms; analysing all 123 symbols at depth 3: p50 0.4 ms, p95 1.0 ms, max 2.4 ms.
Real finding surfaced by the engine: `computeRisk` has 2 matches (PoC 03 and PoC 06 copies) and risk 0.48 MEDIUM because PoC 06's copy has no test.

## Limits (be careful what you conclude)
- The repo has **no ADR/rules/tickets**, so on real data only the code/test layers are exercised. The spec/rule/ticket layers are validated on the shop fixture, whose conventions (frontmatter keys, `@ticket`) I defined; no external tracker is read, so ticket `status` is `null` ("status unknown").
- Resolution is still name-based plus import hints: namespace imports (`ns.fn()`), re-exports through barrel files and non-relative aliases cannot be disambiguated (they stay `inferred`, which is the honest answer).
- A symbol name that exists in several files merges into one report (`ambiguousMatches`); use `--file` to scope.
- Risk weights are still my calibration, now checked on one fixture and one repo, not against real incidents.
