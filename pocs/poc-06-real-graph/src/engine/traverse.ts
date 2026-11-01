import type { Database } from "bun:sqlite";
import type { Confidence, NodeRow } from "../graph/schema";

export interface Linked<T = NodeRow> {
  node: T;
  /** hops from the target (0 = the target itself). */
  depth: number;
  /** strict iff at least one fully-strict path supports the item within the depth cap. */
  confidence: Confidence;
  /** weakest link score along the best strict/inferred path (1 for strict). */
  score: number;
}

const combine = (a: Confidence, b: Confidence): Confidence => (a === "strict" && b === "strict" ? "strict" : "inferred");

export function findSymbols(db: Database, name: string): NodeRow[] {
  return db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE name = ? AND type IN ('function','class') ORDER BY path").all(name);
}

export function symbolsOfFile(db: Database, path: string): NodeRow[] {
  return db
    .query<NodeRow, [string]>(
      `SELECT n.* FROM edges e JOIN nodes n ON n.id = e.target_id
       WHERE e.relation_type='CONTAINS' AND e.source_id = ? AND n.type IN ('function','class') ORDER BY n.name`,
    )
    .all(`file:${path}`);
}

/**
 * Reverse CALLS closure, depth-capped. The cap (not UNION dedupe alone) guarantees termination on cycles.
 * Per caller: MIN(depth) over all paths; strict if any path is entirely strict.
 */
export function callersOf(db: Database, targetId: string, maxDepth: number): Linked[] {
  const rows = db
    .query<NodeRow & { depth: number; inferred: number; score: number }, [string, number]>(
      `WITH RECURSIVE c(id, depth, inferred, score) AS (
         SELECT e.source_id, 1, e.confidence = 'inferred', e.score FROM edges e
          WHERE e.target_id = ?1 AND e.relation_type = 'CALLS'
         UNION
         SELECT e.source_id, c.depth + 1, c.inferred OR e.confidence = 'inferred', MIN(c.score, e.score)
           FROM c JOIN edges e ON e.target_id = c.id AND e.relation_type = 'CALLS'
          WHERE c.depth < ?2
       )
       SELECT n.*, MIN(c.depth) depth, MIN(c.inferred) inferred, MAX(CASE WHEN c.inferred = 0 THEN 1.0 ELSE c.score END) score
         FROM c JOIN nodes n ON n.id = c.id
        WHERE c.id <> ?1
        GROUP BY n.id ORDER BY depth, n.path, n.name`,
    )
    .all(targetId, maxDepth);
  return rows.map(({ depth, inferred, score, ...node }) => ({ node, depth, confidence: inferred ? "inferred" : "strict", score }));
}

const chunk = <T>(a: T[], n = 500): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

interface EdgeHit { other: NodeRow; via: string; confidence: Confidence; score: number }

/** Nodes at the other end of `relation`, for a set of anchor ids. `dir`: anchors are edge targets ("in") or sources ("out"). */
function neighbours(db: Database, anchors: string[], relation: string, dir: "in" | "out"): EdgeHit[] {
  const out: EdgeHit[] = [];
  const [own, other] = dir === "in" ? ["target_id", "source_id"] : ["source_id", "target_id"];
  for (const ids of chunk(anchors)) {
    const q = ids.map(() => "?").join(",");
    const rows = db
      .query<NodeRow & { via: string; confidence: Confidence; escore: number }, string[]>(
        `SELECT n.*, e.${own} via, e.confidence, e.score escore FROM edges e JOIN nodes n ON n.id = e.${other}
          WHERE e.relation_type = '${relation}' AND e.${own} IN (${q})`,
      )
      .all(...ids);
    for (const { via, confidence, escore, ...other } of rows) out.push({ other, via, confidence, score: escore });
  }
  return out;
}

/** Merge hits on the same node: min depth, strict if any strict support, best score. */
function merge(items: Linked[]): Linked[] {
  const m = new Map<string, Linked>();
  for (const it of items) {
    const p = m.get(it.node.id);
    if (!p) { m.set(it.node.id, { ...it }); continue; }
    p.depth = Math.min(p.depth, it.depth);
    if (it.confidence === "strict") { p.confidence = "strict"; p.score = 1; }
    else if (p.confidence === "inferred") p.score = Math.max(p.score, it.score);
  }
  return [...m.values()].sort((a, b) => a.depth - b.depth || a.node.path.localeCompare(b.node.path) || a.node.name.localeCompare(b.node.name));
}

export interface Reach { symbol: NodeRow; depth: number; confidence: Confidence; score: number }

/** Everything linked to a set of "reach" symbols (targets at depth 0 + their callers). */
export function linkedThrough(db: Database, reach: Reach[], relation: "TESTS" | "IMPLEMENTS" | "TRACKS", dir: "in" | "out"): Linked[] {
  const by = new Map(reach.map((r) => [r.symbol.id, r]));
  const hits = neighbours(db, [...by.keys()], relation, dir);
  return merge(
    hits.map((h) => {
      const r = by.get(h.via)!;
      return { node: h.other, depth: r.depth, confidence: combine(r.confidence, h.confidence), score: Math.min(r.score, h.score) };
    }),
  );
}

/** Second layer: items reachable from already-found spec nodes (ADR -> rules, tickets -> ADR). */
export function linkedFromSpecs(db: Database, specs: Linked[], relation: "CONSTRAINS" | "TRACKS", dir: "in" | "out"): Linked[] {
  const by = new Map(specs.map((s) => [s.node.id, s]));
  const hits = neighbours(db, [...by.keys()], relation, dir);
  return merge(
    hits.map((h) => {
      const s = by.get(h.via)!;
      return { node: h.other, depth: s.depth, confidence: combine(s.confidence, h.confidence), score: Math.min(s.score, h.score) };
    }),
  );
}

export { merge };
