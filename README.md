<div align="center">

# KnotGraph 🪢

**The Unified Software Lifecycle Knowledge Graph for AI Agents & Engineering Teams**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

[Features](#key-features) • [Status](#status) • [Quick Start](#quick-start) • [Architecture](#architecture) • [MCP Integration](#mcp-integration) • [Roadmap](#roadmap)

</div>

> **Status: proof of concept.** Six PoCs validate the core (incremental indexing, enriched blast radius, MCP). The `knotgraph` package (`bun add -g knotgraph` / `bunx knotgraph`), `knotgraph.config.json`, Python/Go parsing, tracker sync and the web console described below are **not built yet**. See [Status](#status) and [`pocs/resultats.md`](pocs/resultats.md) for measured results.
---

## 🛑 The Problem

Modern AI coding agents (Claude Code, Cursor, Codex) excel at local edits, but they operate in isolated silos:
- **Structural Code Indexers (AST)** tell agents *how* code is built and *what breaks*, but lack product intent.
- **Vector RAG Stores** tell agents *why* code exists (specs, tickets), but rely on probabilistic search without deterministic proof.

This disconnect causes context drift, architectural violations, and hallucinations during large-scale refactoring and review.

## 💡 The Solution

**KnotGraph** bridges the gap. It builds a **deterministic, local-first knowledge graph** that unifies your entire software lifecycle into a single source of truth:

$$\text{Product Intent (ADRs, Specs)} \longleftrightarrow \text{Implementation (AST, Code)} \longleftrightarrow \text{Delivery (Git, PRs)} \longleftrightarrow \text{Verification (Tests)}$$

With KnotGraph, every answer given by an AI agent is backed by **strict provenance**: exact files, line numbers, decision records, and ticket references.

---

## ✨ Key Features

- 🧬 **Unified Code & Context Graph:** Connects AST nodes directly to markdown specs, ADRs, Jira/Linear tickets, and PR diffs.
- 🔗 **Deterministic Provenance:** Enforces source verification on AI agent outputs (`Code Node → ADR → Ticket → Test`).
- 🎯 **Enriched Blast Radius Analysis:** Evaluates structural callers *plus* impacted business rules, test suites, and open issues before merging.
- ⚡ **Local-First & Fast:** Built with Tree-sitter and SQLite; measured on this repo, a blast-radius query takes ~1 ms (p95) and re-indexing a changed file takes a few ms, with no cloud dependency.
- 🔌 **Native MCP Server:** Out-of-the-box support for Model Context Protocol (MCP) clients including Claude Code, Cursor, and Zed.

---

## 🛠️ Architecture

KnotGraph uses a high-performance hybrid architecture designed to run locally on developer machines while seamlessly syncing with team context.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Developer Machine / CI                       │
│                                                                 │
│  ┌───────────────────────┐       ┌───────────────────────────┐  │
│  │     Core Indexer      │       │    Local Graph Database   │  │
│  │ (Bun + Tree-sitter)   ├──────►│   (SQLite + sqlite-vec)   │  │
│  └───────────────────────┘       └─────────────┬─────────────┘  │
│                                                │                │
│                                                ▼                │
│                                  ┌───────────────────────────┐  │
│                                  │     Native MCP Server     │  │
│                                  └─────────────┬─────────────┘  │
└────────────────────────────────────────────────┼────────────────┘
                                                 │ SSE / WebSockets
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Team Synchronization Hub                     │
│  ┌────────────────────────┐       ┌──────────────────────────┐  │
│  │   Graph Sync Engine    │       │     Web Console UI       │  │
│  │ (Webhooks & Connectors)│       │   (Vue 3 / Cytoscape)    │  │
│  └────────────────────────┘       └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

*Target architecture. Built and measured so far: the local indexer, the SQLite graph and the stdio MCP server (Bun/TypeScript). Not built: `sqlite-vec` embeddings, the team sync hub and the web console.*

---

## 📊 Status

Six proofs of concept, all merged (details, numbers and limits in [`pocs/resultats.md`](pocs/resultats.md)):

| PoC | What it proves | Result |
| --- | --- | --- |
| [01](pocs/poc-01-knotgraph) | TS/JS + ADR graph in SQLite behind an MCP server (`get_node_provenance`, `get_enriched_blast_radius`) | Cold start 280 ms, query p95 2 ms |
| [02](pocs/poc-02-reactive-indexer) | Hot per-file reindex + automatic `CLAUDE.md` block regeneration | Reindex p95 2 ms, manual sections preserved 100 %, ~81 MB RSS |
| [03](pocs/poc-03-blast-radius) | Multi-layer impact (callers, tests, ADRs, rules, tickets) with a 0..1 risk score | 3-hop p95 5 ms on 39k edges (on a **synthetic** graph) |
| [04](pocs/poc-04-rust-indexer) / [05](pocs/poc-05-go-indexer) | Native indexer alternatives (Rust / Go) | ~7 MB / ~15 MB RSS vs ~81 MB with Bun; documented plan B |
| [06](pocs/poc-06-real-graph) | The PoC 03 engine on a graph **extracted from real code** | Inferred links 67 % -> 5.5 % with import-aware resolution |

**Not yet proven:** that agents use provenance and blast radius on their own (one run, with an explicit instruction), the spec/rules/tickets layers on a real project with ADRs, and the calibration of the risk score.

---

## 🚀 Quick Start

### Prerequisites

- Bun >= 1.0.0 (the indexer relies on `bun:sqlite`)
- Git

### Run from source (the only way for now)

```bash
git clone https://github.com/lgrdev/KnotGraph && cd KnotGraph/pocs/poc-06-real-graph
bun install
bun run src/index.ts index   --root /path/to/your/project   # builds <project>/.knotgraph/graph.db
bun run src/index.ts analyze myFunction --root /path/to/your/project
bun test
```

Conventions the extractors read today: `// @ref ADR-004` and `// @ticket ENG-102` above or inside a symbol; ADR frontmatter (`id`, `status`, `implements`, `rules`, `tickets`) in `docs/` or `ADR/`; test files named `*.test.*` / `*.spec.*`. A published `knotgraph` package (to be installed with `bun add -g knotgraph` or run with `bunx knotgraph`) and a `knotgraph init` command are planned, not available.

---

## 🔌 MCP Integration

Add KnotGraph as a stdio MCP server. It indexes the project at startup and then watches `src/`, `docs/` and `ADR/`, so answers follow your edits.

### Claude Code

```bash
claude mcp add knotgraph -- bun run /path/to/KnotGraph/pocs/poc-06-real-graph/src/index.ts serve --root /path/to/your/project
```

or in the MCP configuration:

```json
{
  "mcpServers": {
    "knotgraph": {
      "command": "bun",
      "args": ["run", "/path/to/KnotGraph/pocs/poc-06-real-graph/src/index.ts", "serve", "--root", "/path/to/your/project"]
    }
  }
}
```

Other MCP clients (Cursor, Zed) take the same command/args; they have not been tested.

### MCP Tools

| Tool Name | Status | Description |
| --- | --- | --- |
| `get_enriched_blast_radius(symbol_name \| file_path, max_depth)` | Available ([PoC 06](pocs/poc-06-real-graph)) | Callers up to N hops, tests to re-run, impacted ADRs, governing rules, linked tickets, a 0..1 risk score, and a `strict` / `inferred` confidence on every link. |
| `get_node_provenance(symbol_name)` | Available in [PoC 01](pocs/poc-01-knotgraph) only | Justification chain: symbol -> file:line -> ADR -> tests. Not yet ported to the PoC 06 server. |
| `check_pr_compliance(diff_id)` | Planned | Detects architectural drift, stale docs, or missing tests in pull requests. |
| `query_graph(cypher_or_sql)` | Planned | Executes custom queries against the unified knowledge graph. |

---

## ⚙️ Configuration (`knotgraph.config.json`) — target design, not implemented

The PoCs take a `--root` argument and use the conventions above; there is no config file yet. This is the intended shape:

```json
{
  "version": "1.0",
  "languages": ["typescript", "python", "go"],
  "documents": {
    "paths": ["docs/**/*.md", "ADR/*.md"],
    "format": "markdown"
  },
  "integrations": {
    "issueTracker": "linear",
    "gitHooks": true
  },
  "mcp": {
    "strictProvenance": true,
    "confidenceThreshold": 0.85
  }
}
```

---

## 🗺️ Roadmap

- [x] Core AST Parser (Tree-sitter, TS/JS; Python and Go not started)
- [x] Local SQLite Graph Storage & incremental Indexer (per-file reindex in a few ms)
- [x] Basic MCP Server over stdio (blast radius with risk score, provenance in PoC 01)
- [x] `CLAUDE.md` dynamic block regeneration that preserves manual content (PoC 02; not yet merged into PoC 06)
- [~] ADR & Markdown Entity Resolution: explicit links (`@ref`, frontmatter, `@ticket`) and import-aware symbol resolution done; semantic linking not started
- [ ] Measure real agent value: repeated runs with and without the MCP tool, no instruction to use it
- [ ] Validate the spec/rules/tickets layers on a real project with ADRs
- [ ] Linear / Jira / GitHub Issues Sync Engine
- [ ] Interactive Web Visualization Dashboard (Vue 3 + Cytoscape.js)
- [ ] Enterprise Sync & On-Premises Deployment Options

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.