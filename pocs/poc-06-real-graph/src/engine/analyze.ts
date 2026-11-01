import type { Database } from "bun:sqlite";
import type { NodeRow } from "../graph/schema";
import { DEFAULT_WEIGHTS, computeRisk, type RiskResult, type Weights } from "./risk";
import { callersOf, findSymbols, linkedFromSpecs, linkedThrough, merge, symbolsOfFile, type Linked, type Reach } from "./traverse";

export interface AnalyzeOptions {
  symbol?: string;
  file?: string;
  maxDepth?: number;
  weights?: Weights;
}

export interface BlastRadiusReport {
  target: { kind: "symbol" | "file"; name: string; matches: { id: string; path: string }[] };
  maxDepth: number;
  callers: Linked[];
  tests: Linked[];
  specs: Linked[];
  rules: Linked[];
  tickets: Linked[];
  /** target symbols with no TESTS edge at all. */
  untested: NodeRow[];
  risk: RiskResult;
  recommendations: string[];
}

export function analyze(db: Database, opts: AnalyzeOptions): BlastRadiusReport | null {
  const maxDepth = opts.maxDepth ?? 3;
  const kind = opts.file ? "file" : "symbol";
  const name = (opts.file ?? opts.symbol)!;
  const targets = opts.file ? symbolsOfFile(db, opts.file) : findSymbols(db, name);
  if (!targets.length) return null;

  const reach = new Map<string, Reach>();
  const callerSets: Linked[] = [];
  for (const t of targets) {
    reach.set(t.id, { symbol: t, depth: 0, confidence: "strict", score: 1 });
    callerSets.push(...callersOf(db, t.id, maxDepth));
  }
  const callers = merge(callerSets).filter((c) => !reach.has(c.node.id));
  for (const c of callers) reach.set(c.node.id, { symbol: c.node, depth: c.depth, confidence: c.confidence, score: c.score });
  const all = [...reach.values()];

  const tests = linkedThrough(db, all, "TESTS", "in");
  const specs = linkedThrough(db, all, "IMPLEMENTS", "out");
  const rules = linkedFromSpecs(db, specs, "CONSTRAINS", "out");
  const tickets = merge([...linkedThrough(db, all, "TRACKS", "in"), ...linkedFromSpecs(db, specs, "TRACKS", "in")]);

  const covered = new Set(targetsWithTests(db, targets));
  const untested = targets.filter((t) => !covered.has(t.id));

  const risk = computeRisk(
    {
      callers: callers.map((c) => ({ depth: c.depth, inferred: c.confidence === "inferred" })),
      rules: rules.map((r) => ({ depth: r.depth, inferred: r.confidence === "inferred" })),
      draftSpecs: specs.filter((s) => s.node.status === "draft").length,
      untestedRatio: untested.length / targets.length,
    },
    opts.weights ?? DEFAULT_WEIGHTS,
  );

  const report: BlastRadiusReport = {
    target: { kind, name, matches: targets.map((t) => ({ id: t.id, path: t.path })) },
    maxDepth, callers, tests, specs, rules, tickets, untested, risk, recommendations: [],
  };
  report.recommendations = recommend(report);
  return report;
}

function targetsWithTests(db: Database, targets: NodeRow[]): string[] {
  const q = targets.map(() => "?").join(",");
  return db
    .query<{ target_id: string }, string[]>(`SELECT DISTINCT target_id FROM edges WHERE relation_type='TESTS' AND target_id IN (${q})`)
    .all(...targets.map((t) => t.id))
    .map((r) => r.target_id);
}

function recommend(r: BlastRadiusReport): string[] {
  const out: string[] = [];
  for (const f of [...new Set(r.tests.map((t) => t.node.path))]) out.push(`Run \`${f}\` before committing.`);
  for (const t of r.untested) out.push(`No test is linked to \`${t.name}\`: add one before changing it.`);
  for (const s of r.specs) {
    out.push(`Review \`${s.node.name}\` to ensure business rule alignment.`);
    if (s.node.status === "draft") out.push(`\`${s.node.name}\` is still a draft: confirm the rule is settled before coding.`);
  }
  for (const k of r.tickets.filter((t) => t.node.status !== "done")) out.push(`Ticket \`${k.node.name}\`${k.node.title ? ` (${k.node.title})` : ""} covers this area${k.node.status ? "" : " (status unknown: not synced from a tracker)"}.`);
  const weak = [...r.callers, ...r.tests, ...r.specs, ...r.rules].filter((x) => x.confidence === "inferred");
  for (const w of weak) out.push(`Link to \`${w.node.name}\` is inferred (score ${w.score}): verify manually.`);
  if (r.callers.some((c) => c.depth === r.maxDepth)) out.push(`Callers exist at depth ${r.maxDepth}: impact may extend further (raise max depth).`);
  return out;
}
