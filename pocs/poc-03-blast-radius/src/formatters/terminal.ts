import type { BlastRadiusReport } from "../engine/analyze";
import type { Linked } from "../engine/traverse";

export function toTerminal(r: BlastRadiusReport, color = !process.env.NO_COLOR && !!process.stdout.isTTY): string {
  const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s: string) => c(1, s), dim = (s: string) => c(2, s);
  const levelColor = { LOW: 32, MEDIUM: 33, HIGH: 31 }[r.risk.level];
  const mark = (x: Linked) => (x.confidence === "inferred" ? c(33, ` ~inferred(${x.score})`) : "");
  const section = (title: string, rows: string[]) => [bold(title), ...(rows.length ? rows.map((x) => `  ${x}`) : [dim("  none")]), ""];

  const b = r.risk.breakdown;
  const lines = [
    `${bold("Blast radius")} ${r.target.kind} ${bold(r.target.name)}${r.target.matches.length > 1 ? dim(` (${r.target.matches.length} matches)`) : ""}`,
    `Risk ${c(levelColor, bold(`${r.risk.score.toFixed(2)} ${r.risk.level}`))} ${dim(`callers ${b.callers} + rules ${b.rules} + untested ${b.untested} + drafts ${b.draftSpecs} (depth<=${r.maxDepth})`)}`,
    "",
    ...section(`Callers (${r.callers.length})`, r.callers.map((x) => `d${x.depth} ${x.node.name} ${dim(x.node.path)}${mark(x)}`)),
    ...section(`Tests to run (${r.tests.length})`, r.tests.map((x) => `${x.node.path} ${dim(x.node.title ?? "")}${mark(x)}`)),
    ...section(`Specs (${r.specs.length})`, r.specs.map((x) => `${x.node.name} ${x.node.title}${x.node.status === "draft" ? c(33, " [draft]") : ""}${mark(x)}`)),
    ...section(`Rules (${r.rules.length})`, r.rules.map((x) => `${x.node.name} ${dim(x.node.title ?? "")}${mark(x)}`)),
    ...section(`Tickets (${r.tickets.length})`, r.tickets.map((x) => `${x.node.name} ${x.node.title} ${dim(`[${x.node.status}]`)}${mark(x)}`)),
    ...section("Recommendations", r.recommendations.map((x) => `- ${x}`)),
  ];
  return lines.join("\n");
}
