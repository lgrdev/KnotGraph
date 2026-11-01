import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deletePath, insertEdge, insertNode, insertRef, resolveEdges } from "./db";
import { isCodeFile, isTestFile, parseCode } from "./parser/code";
import { parseDoc } from "./parser/docs";

const IGNORED = new Set(["node_modules", ".git", ".knotgraph", "dist"]);
export const IGNORED_SEGMENT = /(^|\/)(node_modules|\.git|\.knotgraph|dist)(\/|$)/;
const DOC_DIRS = /(^|\/)(docs|ADR|adr)\//;

export const isDocFile = (p: string) => p.endsWith(".md") && DOC_DIRS.test(p);
export const isIndexable = (p: string) => isCodeFile(p) || isDocFile(p);

export function walk(root: string, dir = root, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(root, full, acc);
    else {
      const rel = relative(root, full);
      if (isIndexable(rel)) acc.push(rel);
    }
  }
  return acc;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

/** Index one file (no edge resolution). Returns false if unchanged. */
async function indexFile(db: Database, root: string, rel: string): Promise<boolean> {
  const source = readFileSync(join(root, rel), "utf8");
  const hash = sha(source);
  const prev = db.query<{ h: string }, [string]>("SELECT content_hash h FROM nodes WHERE path = ? LIMIT 1").get(rel);
  if (prev?.h === hash) return false;
  const now = Date.now();
  deletePath(db, rel);

  if (isDocFile(rel)) {
    const d = parseDoc(rel, source);
    const id = `adr:${d.id}`;
    insertNode(db, { id, type: "adr", name: d.id, path: rel, content_hash: hash, start_line: 1, end_line: source.split("\n").length, title: d.title, indexed_at: now });
    for (const t of d.implements) insertRef(db, id, t, "IMPLEMENTS", rel);
    return true;
  }

  const p = await parseCode(rel, source);
  const lines = source.split("\n").length;
  if (p.isTest) {
    const id = `test:${rel}`;
    insertNode(db, { id, type: "test", name: rel.split("/").pop()!, path: rel, content_hash: hash, start_line: 1, end_line: lines, title: null, indexed_at: now });
    const imported = new Set(p.imports);
    for (const c of new Set(p.calls.map((c) => c.callee))) if (imported.has(c)) insertRef(db, id, c, "TESTS", rel);
    return true;
  }

  const fileId = `file:${rel}`;
  insertNode(db, { id: fileId, type: "file", name: rel.split("/").pop()!, path: rel, content_hash: hash, start_line: 1, end_line: lines, title: null, indexed_at: now });
  for (const s of p.symbols) {
    const id = `${s.kind === "class" ? "class" : "fn"}:${rel}#${s.name}`;
    insertNode(db, { id, type: s.kind, name: s.name, path: rel, content_hash: hash, start_line: s.startLine, end_line: s.endLine, title: null, indexed_at: now });
    insertEdge(db, fileId, id, "CONTAINS");
  }
  const idOf = (name: string) => {
    const s = p.symbols.find((x) => x.name === name);
    return s ? `${s.kind === "class" ? "class" : "fn"}:${rel}#${s.name}` : null;
  };
  for (const c of p.calls) {
    const src = c.caller ? idOf(c.caller) : null;
    if (src) insertRef(db, src, c.callee, "CALLS", rel);
  }
  for (const r of p.refs) insertRef(db, (r.symbol && idOf(r.symbol)) || fileId, r.adr, "IMPLEMENTS", rel);
  return true;
}

export interface IndexStats { files: number; changed: number; removed: number; ms: number }

/** Full (cold or warm) index: only changed files are re-parsed; vanished files are removed. */
export async function indexAll(db: Database, root: string): Promise<IndexStats> {
  const t0 = performance.now();
  const files = walk(root);
  let changed = 0;
  db.run("BEGIN");
  try {
    for (const f of files) if (await indexFile(db, root, f)) changed++;
    const known = db.query<{ path: string }, []>("SELECT DISTINCT path FROM nodes").all().map((r) => r.path);
    const present = new Set(files);
    let removed = 0;
    for (const p of known) if (!present.has(p)) { deletePath(db, p); removed++; }
    if (changed || removed) resolveEdges(db);
    db.run("COMMIT");
    return { files: files.length, changed, removed, ms: performance.now() - t0 };
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/** Incremental update for a single path (changed, created or deleted). */
export async function reindexFile(db: Database, root: string, rel: string): Promise<IndexStats> {
  const t0 = performance.now();
  let changed = 0, removed = 0;
  db.run("BEGIN");
  try {
    let exists = true;
    try { exists = statSync(join(root, rel)).isFile(); } catch { exists = false; }
    if (!exists) { deletePath(db, rel); removed = 1; }
    else if (isIndexable(rel) && (await indexFile(db, root, rel))) changed = 1;
    if (changed || removed) resolveEdges(db);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  return { files: 1, changed, removed, ms: performance.now() - t0 };
}
