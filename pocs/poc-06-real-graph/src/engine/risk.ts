export interface Weights {
  /** per caller, divided by depth (a depth-2 caller counts half). */
  callers: number;
  /** per constraining rule, divided by the depth of the spec that carries it (depth 0/1 = full weight). */
  rules: number;
  /** penalty x fraction of target symbols with no linked test. */
  untested: number;
  /** flat addition per impacted ADR still in draft. */
  draftSpec: number;
  /** multiplier applied to items supported only by inferred links. */
  inferredFactor: number;
}

export const DEFAULT_WEIGHTS: Weights = { callers: 0.08, rules: 0.2, untested: 0.3, draftSpec: 0.05, inferredFactor: 0.5 };

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface RiskInput {
  callers: { depth: number; inferred: boolean }[];
  rules: { depth: number; inferred: boolean }[];
  draftSpecs: number;
  /** share (0..1) of target symbols without any TESTS edge. */
  untestedRatio: number;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  breakdown: { callers: number; rules: number; untested: number; draftSpecs: number; raw: number };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** RiskScore = min(1, w_callers*Σ(1/depth) + w_rules*Σ(1/depth) + w_untested*I_untested [+ draft penalty]); inferred items weigh `inferredFactor`. */
export function computeRisk(input: RiskInput, w: Weights = DEFAULT_WEIGHTS): RiskResult {
  const f = (inferred: boolean) => (inferred ? w.inferredFactor : 1);
  const callers = w.callers * input.callers.reduce((s, c) => s + f(c.inferred) / Math.max(1, c.depth), 0);
  const rules = w.rules * input.rules.reduce((s, r) => s + f(r.inferred) / Math.max(1, r.depth), 0);
  const untested = w.untested * input.untestedRatio;
  const draftSpecs = w.draftSpec * input.draftSpecs;
  const raw = callers + rules + untested + draftSpecs;
  const score = r2(Math.min(1, raw));
  const level: RiskLevel = score < 0.34 ? "LOW" : score < 0.67 ? "MEDIUM" : "HIGH";
  return { score, level, breakdown: { callers: r2(callers), rules: r2(rules), untested: r2(untested), draftSpecs: r2(draftSpecs), raw: r2(raw) } };
}
