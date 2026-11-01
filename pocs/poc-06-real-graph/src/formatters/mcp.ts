import type { BlastRadiusReport } from "../engine/analyze";

/** Spec §2.3 payload, plus additive fields (rules, tickets, confidence, provenance per ADR-002). */
export function toMcpPayload(r: BlastRadiusReport) {
  const conf = (x: { confidence: string; score: number }) => ({ confidence: x.confidence, ...(x.confidence === "inferred" ? { linkScore: x.score } : {}) });
  const nodes = [...r.callers, ...r.tests, ...r.specs, ...r.rules, ...r.tickets].map((x) => x.node);
  return {
    target: r.target.name,
    targetKind: r.target.kind,
    ...(r.target.matches.length > 1 ? { [r.target.kind === "file" ? "fileSymbols" : "ambiguousMatches"]: r.target.matches } : {}),
    riskScore: r.risk.score,
    riskLevel: r.risk.level,
    riskBreakdown: r.risk.breakdown,
    maxDepth: r.maxDepth,
    blastRadius: {
      codeCallers: r.callers.map((c) => ({ symbol: c.node.name, file: c.node.path, depth: c.depth, ...conf(c) })),
      testsToRun: r.tests.map((t) => ({ file: t.node.path, suite: t.node.title ?? t.node.name, ...conf(t) })),
      impactedSpecs: r.specs.map((s) => ({ id: s.node.name, title: s.node.title, path: s.node.path, status: s.node.status, ...conf(s) })),
      rules: r.rules.map((x) => ({ id: x.node.name, title: x.node.title, ...conf(x) })),
      tickets: r.tickets.map((x) => ({ id: x.node.name, title: x.node.title, status: x.node.status, ...conf(x) })),
      untestedSymbols: r.untested.map((u) => u.name),
    },
    recommendations: r.recommendations,
    provenance: { source: "knotgraph", nodes: nodes.map((n) => ({ id: n.id, path: n.path, content_hash: n.content_hash })) },
  };
}
