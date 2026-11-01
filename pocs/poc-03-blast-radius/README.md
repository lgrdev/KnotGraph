# poc-03-blast-radius

PoC 03: multi-layer blast radius (code callers -> tests -> ADR/specs -> rules -> tickets) with a deterministic 0..1 risk score and an explicit strict/inferred confidence on every link.
Spec: `specifications/cahier_des_charges_poc_03_knotgraph.md`.

## Stack
Bun, TypeScript, `bun:sqlite` (recursive CTE), `@modelcontextprotocol/sdk` + `zod`. No chalk/boxen: ANSI codes by hand (`NO_COLOR` and non-TTY respected). Data is a **seeded synthetic graph** (spec: "seed DB"); nothing is parsed from real code here (see PoC 01/02 for that).

## Usage
```bash
bun install
bun test                                    # 19 tests (ground truth, risk, formatters, MCP in-memory + stdio, perf KPI)
bun run seed                                # .knotgraph/blast.db with the sample graph
bun run analyze calculateVAT                # terminal report   (--depth N, --json for the MCP payload)
bun run analyze -- --file src/tax/vat.ts    # union of a file's symbols
bun run bench                               # 10k nodes / 39k edges
claude mcp add knotgraph-blast -- bun run $PWD/src/index.ts serve --db $PWD/.knotgraph/blast.db
```
MCP tool `get_enriched_blast_radius({ symbol_name? , file_path?, max_depth=3 })` returns the spec §2.3 payload plus `rules`, `tickets`, `untestedSymbols`, `riskBreakdown`, per-item `confidence` (+ `linkScore` when inferred) and `provenance`.

## Model
- Edges: `CALLS | IMPLEMENTS | TESTS | CONTAINS | CONSTRAINS (adr->rule) | TRACKS (ticket->adr/symbol)`, each `confidence strict|inferred` + `score`.
- Callers = reverse `CALLS` closure (`WITH RECURSIVE`, depth cap = termination guarantee on cycles). Tests = reverse `TESTS` of the target and its callers. Specs = `IMPLEMENTS` of target and callers. Rules = `CONSTRAINS` of those specs. Tickets = `TRACKS` of those symbols/specs.
- Per item: depth = minimum over all paths; confidence = `strict` if **any** fully-strict path exists within the cap, else `inferred`. (So an item can be reported at the depth of an inferred path while also being strictly reachable deeper.)
- The spec's labels "descendant/ascendant" for callers are inverted vs the graph direction; implemented as reverse traversal.

## Risk score (my calibration; the spec gives the shape, not the weights)
`min(1, 0.08·Σ 1/depth(callers) + 0.20·Σ 1/max(1,depth)(rules) + 0.30·untested_ratio + 0.05·draft_specs)`, inferred items x0.5. Levels: <0.34 LOW, <0.67 MEDIUM, else HIGH. Weights are one exported object (`DEFAULT_WEIGHTS`). Validated only on synthetic data: `calculateVAT` gives 0.86 HIGH (spec example 0.82).

## Results (this machine)
| KPI | Result | Target |
|---|---|---|
| 3-hop analysis, 10.9k nodes / 38.9k edges, p50 / p95 | 1.6 / 5.0 ms | < 15 ms PASS |
| Worst single call (hub `f0`, 6025 callers) | ~86 ms | not within target |
| Exhaustivity on the seed graph (hand-written ground truth, 3 targets incl. cycle/diamond) | 100% of callers, tests, ADRs, rules, tickets | 100% PASS |
| Strict vs inferred | explicit per item, tested | PASS |

The 15 ms KPI holds for typical symbols (avg 36 callers at depth 3). A hub with thousands of transitive callers exceeds it; mitigation if it matters: cap returned callers, or aggregate counts beyond N.

## Limits
- Synthetic graph: proves the algorithm, not extraction quality of rules/tickets/inferred links.
- Name-based symbol lookup; same-name symbols are merged into one report (`ambiguousMatches` lists them).
- Weights are uncalibrated against real incidents.
