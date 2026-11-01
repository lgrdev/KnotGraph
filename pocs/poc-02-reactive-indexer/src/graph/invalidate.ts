import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deletePath, insertEdge, insertNode, insertRef, resolveEdges, resolveEdgesFor, type NodeRow, type RelationType } from "./db";
import { isCodeFile, isTestFile, parseCode } from "../parsers/code";
import { parseDoc } from "../parsers/docs";

export const IGNORED_SEGMENT = /(^|\/)(node_modules|\.git|\.knotgraph|dist)(\/|$)/;
const DOC_DIRS = /(^|\/)(docs|ADR|adr)\//;
export const isDocFile = (p: string) => p.endsWith(".md") && DOC_DIRS.test(p);
export const isIndexable = (p: string) => !IGNORED_SEGMENT.test(p) && (isCodeFile(p) || isDocFile(p));

export function walk(root: string, dir = root, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(root, full);
    if (IGNORED_SEGMENT.test(rel)) continue;
    if (e.isDirectory()) walk(root, full, acc);
    else if (isIndexable(rel)) acc.push(rel);
  }
  return acc;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

interface Plan {
  nodes: NodeRow[];
  edges: [string, string, RelationType][];
  refs: [string, string, RelationType][];
}

/** Parse a file into rows to insert (pure, async, no DB access). */
async function planFile(rel: string, source: string): Promise<Plan> {
  const plan: Plan = { nodes: [], edges: [], refs: [] };
  const insertNode = (_: unknown, n: NodeRow) => void plan.nodes.push(n);
  const insertEdge = (_: unknown, s: string, t: string, r: RelationType) => void plan.edges.push([s, t, r]);
  const insertRef = (_: unknown, s: string, t: string, r: RelationType, _path: string) => void plan.refs.push([s, t, r]);
  const db = null;
  const hash = sha(source);
  const now = Date.now();
  const lines = source.split("\n").length;

  if (isDocFile(rel)) {
    const d = parseDoc(rel, source);
    const id = `adr:${d.id}`;
    insertNode(db, { id, type: "adr", name: d.id, path: rel, content_hash: hash, start_line: 1, end_line: lines, title: d.title, indexed_at: now });
    for (const t of d.implements) insertRef(db, id, t, "IMPLEMENTS", rel);
    return plan;
  }

  const p = await parseCode(rel, source);
  if (p.isTest) {
    const id = `test:${rel}`;
    insertNode(db, { id, type: "test", name: rel.split("/").pop()!, path: rel, content_hash: hash, start_line: 1, end_line: lines, title: null, indexed_at: now });
    const imported = new Set(p.imports);
    for (const c of new Set(p.calls.map((c) => c.callee))) if (imported.has(c)) insertRef(db, id, c, "TESTS", rel);
    return plan;
  }

  const fileId = `file:${rel}`;
  insertNode(db, { id: fileId, type: "file", name: rel.split("/").pop()!, path: rel, content_hash: hash, start_line: 1, end_line: lines, title: null, indexed_at: now });
  const idOf = (name: string) => {
    const s = p.symbols.find((x) => x.name === name);
    return s ? `${s.kind === "class" ? "class" : "fn"}:${rel}#${s.name}` : null;
  };
  for (const s of p.symbols) {
    const id = idOf(s.name)!;
    insertNode(db, { id, type: s.kind, name: s.name, path: rel, content_hash: hash, start_line: s.startLine, end_line: s.endLine, title: null, indexed_at: now });
    insertEdge(db, fileId, id, "CONTAINS");
  }
  for (const c of p.calls) {
    const src = c.caller ? idOf(c.caller) : null;
    if (src) insertRef(db, src, c.callee, "CALLS", rel);
  }
  for (const r of p.refs) insertRef(db, (r.symbol && idOf(r.symbol)) || fileId, r.adr, "IMPLEMENTS", rel);
  return plan;
}

function applyPlan(db: Database, rel: string, plan: Plan): void {
  for (const n of plan.nodes) insertNode(db, n);
  for (const [s, t, r] of plan.edges) insertEdge(db, s, t, r);
  for (const [s, t, r] of plan.refs) insertRef(db, s, t, r, rel);
}

export type ChangeKind = "add" | "change" | "unlink";
export interface ApplyResult { path: string; applied: boolean; ms: number }

/**
 * Hot path: invalidate + replace one file in ONE transaction, resolving only edges that touch it.
 * Parsing happens before BEGIN so the write lock is held for the SQL work only.
 */
export async function applyChange(db: Database, root: string, rel: string, kind: ChangeKind): Promise<ApplyResult> {
  const t0 = performance.now();
  let source: string | null = null;
  if (kind !== "unlink") {
    try {
      if (statSync(join(root, rel)).isFile()) source = readFileSync(join(root, rel), "utf8");
    } catch { /* vanished between event and read: treat as unlink */ }
  }
  const prev = db.query<{ h: string }, [string]>("SELECT content_hash h FROM nodes WHERE path = ? LIMIT 1").get(rel);
  if (source !== null && prev?.h === sha(source)) return { path: rel, applied: false, ms: performance.now() - t0 };
  if (source === null && !prev) return { path: rel, applied: false, ms: performance.now() - t0 };

  // Parse first (async, no lock): keeps the transaction purely synchronous and short.
  const plan = source === null ? null : await planFile(rel, source);

  db.run("BEGIN IMMEDIATE");
  try {
    deletePath(db, rel);
    if (plan) applyPlan(db, rel, plan);
    resolveEdgesFor(db, rel);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  return { path: rel, applied: true, ms: performance.now() - t0 };
}

export interface IndexStats { files: number; changed: number; removed: number; ms: number }

/** Cold start: index all files, then one global resolve. */
export async function indexAll(db: Database, root: string): Promise<IndexStats> {
  const t0 = performance.now();
  const files = walk(root);
  let changed = 0;
  for (const f of files) {
    const source = readFileSync(join(root, f), "utf8");
    const prev = db.query<{ h: string }, [string]>("SELECT content_hash h FROM nodes WHERE path = ? LIMIT 1").get(f);
    if (prev?.h === sha(source)) continue;
    const plan = await planFile(f, source);
    db.run("BEGIN");
    deletePath(db, f);
    applyPlan(db, f, plan);
    db.run("COMMIT");
    changed++;
  }
  const present = new Set(files);
  let removed = 0;
  for (const { path } of db.query<{ path: string }, []>("SELECT DISTINCT path FROM nodes").all()) {
    if (!present.has(path)) { deletePath(db, path); removed++; }
  }
  if (changed || removed) resolveEdges(db);
  return { files: files.length, changed, removed, ms: performance.now() - t0 };
}
