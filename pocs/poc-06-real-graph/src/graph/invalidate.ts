import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { join, relative } from "node:path";
import { isCodeFile, parseCode } from "../parsers/code";
import { parseDoc } from "../parsers/docs";
import { applyPlan, deletePath, gcTickets, resolveAll, resolveScoped, type Plan } from "./schema";

export const IGNORED_SEGMENT = /(^|\/)(node_modules|\.git|\.knotgraph|dist|target)(\/|$)/;
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

/** Module specifier -> repo-relative path without extension (relative imports only). */
function moduleHint(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(c|m)?[jt]sx?$/, "");
}

/** Parse a file into rows to insert (pure, no DB access). */
export async function planFile(rel: string, source: string): Promise<Plan> {
  const hash = sha(source);
  const lines = source.split("\n").length;
  const plan: Plan = { nodes: [], edges: [], refs: [], tickets: [] };
  const base = rel.split("/").pop()!;

  if (isDocFile(rel)) {
    const d = parseDoc(rel, source);
    const id = `adr:${d.id}`;
    plan.nodes.push({ id, type: "adr", name: d.id, path: rel, title: d.title, status: d.status, hash, start: 1, end: lines });
    for (const t of d.implements) plan.refs.push({ source: id, targetName: t, rel: "IMPLEMENTS" });
    for (const r of d.rules) {
      const rid = `rule:${r.id}`;
      plan.nodes.push({ id: rid, type: "rule", name: r.id, path: rel, title: r.text || null, status: null, hash, start: 1, end: lines });
      plan.edges.push({ source: id, target: rid, rel: "CONSTRAINS" });
    }
    for (const t of d.tickets) {
      plan.tickets.push(t);
      plan.edges.push({ source: `ticket:${t}`, target: id, rel: "TRACKS" });
    }
    return plan;
  }

  const p = await parseCode(rel, source);
  if (p.isTest) {
    const id = `test:${rel}`;
    plan.nodes.push({ id, type: "test", name: base, path: rel, title: p.suites[0] ?? null, status: null, hash, start: 1, end: lines });
    const imported = new Set(p.imports);
    for (const c of new Set(p.calls.map((c) => c.callee))) {
      if (!imported.has(c)) continue;
      const im = p.importMap[c];
      plan.refs.push({ source: id, targetName: im?.name ?? c, rel: "TESTS", hint: im ? moduleHint(rel, im.module) : null });
    }
    return plan;
  }

  const fileId = `file:${rel}`;
  plan.nodes.push({ id: fileId, type: "file", name: base, path: rel, title: null, status: null, hash, start: 1, end: lines });
  const idOf = (name: string) => {
    const s = p.symbols.find((x) => x.name === name);
    return s ? `${s.kind === "class" ? "class" : "fn"}:${rel}#${s.name}` : null;
  };
  for (const s of p.symbols) {
    const id = idOf(s.name)!;
    plan.nodes.push({ id, type: s.kind, name: s.name, path: rel, title: null, status: null, hash, start: s.startLine, end: s.endLine });
    plan.edges.push({ source: fileId, target: id, rel: "CONTAINS" });
  }
  for (const c of p.calls) {
    const src = c.caller ? idOf(c.caller) : null;
    if (!src) continue;
    const im = p.importMap[c.callee];
    plan.refs.push({ source: src, targetName: im && im.name !== "default" ? im.name : c.callee, rel: "CALLS", hint: im ? moduleHint(rel, im.module) : null });
  }
  for (const r of p.refs) plan.refs.push({ source: (r.symbol && idOf(r.symbol)) || fileId, targetName: r.adr, rel: "IMPLEMENTS" });
  for (const t of p.tickets) {
    plan.tickets.push(t.id);
    plan.edges.push({ source: `ticket:${t.id}`, target: (t.symbol && idOf(t.symbol)) || fileId, rel: "TRACKS" });
  }
  return plan;
}

export type ChangeKind = "add" | "change" | "unlink";
export interface ApplyResult { path: string; applied: boolean; ms: number }

const definedNames = (db: Database, path: string) =>
  db.query<{ name: string }, [string]>("SELECT DISTINCT name FROM nodes WHERE path = ? AND type IN ('function','class','adr')").all(path).map((r) => r.name);

/** Hot path: purge + insert + scoped resolve in ONE transaction. Parsing happens before BEGIN. */
export async function applyChange(db: Database, root: string, rel: string, kind: ChangeKind): Promise<ApplyResult> {
  const t0 = performance.now();
  let source: string | null = null;
  if (kind !== "unlink") {
    try { if (statSync(join(root, rel)).isFile()) source = readFileSync(join(root, rel), "utf8"); } catch { /* vanished: treat as unlink */ }
  }
  const prev = db.query<{ h: string }, [string]>("SELECT content_hash h FROM nodes WHERE path = ? LIMIT 1").get(rel);
  if (source !== null && prev?.h === sha(source)) return { path: rel, applied: false, ms: performance.now() - t0 };
  if (source === null && !prev) return { path: rel, applied: false, ms: performance.now() - t0 };

  const plan = source === null ? null : await planFile(rel, source);
  db.run("BEGIN IMMEDIATE");
  try {
    const names = new Set(definedNames(db, rel)); // names defined BEFORE the change
    deletePath(db, rel);
    if (plan) {
      applyPlan(db, rel, plan, Date.now());
      for (const n of plan.nodes) if (n.type === "function" || n.type === "class" || n.type === "adr") names.add(n.name);
    }
    resolveScoped(db, rel, [...names]);
    gcTickets(db);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  return { path: rel, applied: true, ms: performance.now() - t0 };
}

export interface IndexStats { files: number; changed: number; removed: number; ms: number }

/** Cold (or warm) start: only changed files are re-parsed; one global resolve at the end. */
export async function indexAll(db: Database, root: string): Promise<IndexStats> {
  const t0 = performance.now();
  const files = walk(root);
  let changed = 0, removed = 0;
  for (const f of files) {
    const source = readFileSync(join(root, f), "utf8");
    const prev = db.query<{ h: string }, [string]>("SELECT content_hash h FROM nodes WHERE path = ? LIMIT 1").get(f);
    if (prev?.h === sha(source)) continue;
    const plan = await planFile(f, source);
    db.run("BEGIN");
    deletePath(db, f);
    applyPlan(db, f, plan, Date.now());
    db.run("COMMIT");
    changed++;
  }
  const present = new Set(files);
  for (const { path } of db.query<{ path: string }, []>("SELECT DISTINCT path FROM nodes WHERE type <> 'ticket'").all()) {
    if (!present.has(path)) { deletePath(db, path); removed++; }
  }
  if (changed || removed) { resolveAll(db); gcTickets(db); }
  return { files: files.length, changed, removed, ms: performance.now() - t0 };
}
