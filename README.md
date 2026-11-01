<div align="center">

# KnotGraph 🪢

**The Unified Software Lifecycle Knowledge Graph for AI Agents & Engineering Teams**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

[Features](#key-features) • [Quick Start](#quick-start) • [Architecture](#architecture) • [MCP Integration](#mcp-integration) • [Roadmap](#roadmap)

</div>

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
- ⚡ **Local-First & Ultra-Fast:** Built with Tree-sitter and SQLite for sub-millisecond local queries without cloud lock-in.
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
│  │ (Rust + Tree-sitter)  ├──────►│   (SQLite + sqlite-vec)   │  │
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

---

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.x or Bun >= 1.0.0
- Git

### Installation

```bash
# Install KnotGraph globally via npm
npm install -g knotgraph

# Or run directly using npx
npx knotgraph --help
```

### Initializing in a Repository

Navigate to your codebase and initialize the indexer:

```bash
cd /path/to/your/project
knotgraph init
```

This generates a `.knotgraph/` directory containing your local SQLite graph index and configuration file (`knotgraph.config.json`).

---

## 🔌 MCP Integration

Add KnotGraph as an MCP server to your favorite AI development tools.

### Claude Code (`claude.json`)

```json
{
  "mcpServers": {
    "knotgraph": {
      "command": "knotgraph",
      "args": ["mcp", "serve"]
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "knotgraph": {
      "command": "npx",
      "args": ["-y", "knotgraph", "mcp", "serve"]
    }
  }
}
```

### Available MCP Tools

| Tool Name | Description |
| --- | --- |
| `get_node_provenance(node_id)` | Returns the complete justification chain from spec to code & test. |
| `get_enriched_blast_radius(symbol)` | Computes structural callers, related ADRs, affected tests, and open tickets. |
| `check_pr_compliance(diff_id)` | Detects architectural drift, stale docs, or missing tests in pull requests. |
| `query_graph(cypher_or_sql)` | Executes custom queries against the unified knowledge graph. |

---

## ⚙️ Configuration (`knotgraph.config.json`)

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

- [x] Core AST Parser (Tree-sitter integration for TS/JS, Python, Go)
- [x] Local SQLite Graph Storage & Indexer
- [x] Basic MCP Server Protocol implementation
- [ ] Automated ADR & Markdown Entity Resolution
- [ ] Linear / Jira / GitHub Issues Sync Engine
- [ ] Interactive Web Visualization Dashboard (Vue 3 + Cytoscape.js)
- [ ] Enterprise Sync & On-Premises Deployment Options

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.