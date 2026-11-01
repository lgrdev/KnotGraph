# poc-01-knotgraph

PoC: unified graph (TS/JS AST + Markdown ADR) in SQLite, exposed by a local stdio MCP server.
Spec: `specifications/cahier_des_charges_poc_knotgraph.md`.

## Stack
Bun, TypeScript, `web-tree-sitter` (pinned 0.25.10: newer versions can't load the `tree-sitter-wasms` grammars), `gray-matter`, `bun:sqlite` (instead of better-sqlite3), `@modelcontextprotocol/sdk`.

## Usage
```bash
bun install
bun test                                   # parser, indexer, MCP tools
bun run bench                              # KPI check (cold start / incremental / MCP latency)
bun run src/cli.ts index <root>            # build <root>/.knotgraph/graph.db
bun run src/cli.ts serve <root>            # index + watch + MCP over stdio
claude mcp add knotgraph -- bun run $PWD/src/cli.ts serve $PWD/fixtures/dummy-project
```

## Tools
- `get_node_provenance(symbol_name)`: symbol -> file:line -> ADR (`@ref` / `implements:`) -> tests.
- `get_enriched_blast_radius(symbol_name)`: direct callers, tests to re-run (symbol + transitive callers), impacted specs.

## Linking
Code: `// @ref ADR-001` above or inside a symbol. Doc: frontmatter `id: ADR-001`, optional `implements: [ADR-000]`. Docs are read from `docs/` and `ADR/` folders.
Test files (`*.test.ts`, `*.spec.ts`) link to symbols they import **and** call.

## Limits (PoC)
Call resolution is by name only (no scope/type resolution): homonyms across files give false positives. One language, no multi-dev sync.

## Bench (this machine, 210 files ~ 10k LOC + 10 md)
| KPI | Result | Target |
|---|---|---|
| Cold start | ~280 ms | < 3 s |
| Incremental reindex | ~4 ms | < 500 ms |
| MCP query p95 | ~2 ms | < 50 ms |

## §4 scenario (headless `claude -p`, copy of `fixtures/dummy-project`, read-only)
Prompt: VAT 2026 rule, "use KnotGraph before writing code". The agent called `get_node_provenance` and `get_enriched_blast_radius` on `calculateVAT`, found ADR-001, the 3 test suites and callers `cartTotal`/`checkout`, wrote a plan limited to `calculateVAT` (as the ADR requires), and asked for the exact 2026 rule rather than inventing one (the fixture ADR doesn't define it). One run, n=1; not a statistical result.
