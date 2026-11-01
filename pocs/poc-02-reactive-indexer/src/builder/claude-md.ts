import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

const MARKER = /^<!--\s*KNOTGRAPH:([A-Z_]+):(START|END)\s*-->$/;

interface Mark { name: string; kind: "START" | "END"; start: number; end: number }

export interface SpliceResult { text: string; changed: boolean; warnings: string[] }

/** Locate marker comments with the Markdown AST (so ones inside code fences are ignored). */
function findMarks(src: string): Mark[] {
  const tree = remark().use(remarkGfm).parse(src);
  const marks: Mark[] = [];
  visit(tree, "html", (n) => {
    const m = MARKER.exec(n.value.trim());
    if (m && n.position?.start.offset !== undefined && n.position.end.offset !== undefined) {
      marks.push({ name: m[1]!, kind: m[2] as Mark["kind"], start: n.position.start.offset, end: n.position.end.offset });
    }
  });
  return marks;
}

/**
 * Replace the content between each KNOTGRAPH:<NAME>:START/END pair using source offsets.
 * Nothing outside the marker ranges is re-serialized, so manual content stays byte-identical.
 */
export function splice(src: string, blocks: Record<string, string>): SpliceResult {
  const warnings: string[] = [];
  const marks = findMarks(src);
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const edits: { from: number; to: number; text: string }[] = [];

  for (const [name, body] of Object.entries(blocks)) {
    const starts = marks.filter((m) => m.name === name && m.kind === "START");
    const ends = marks.filter((m) => m.name === name && m.kind === "END");
    if (!starts.length && !ends.length) { warnings.push(`${name}: markers not found, skipped`); continue; }
    if (starts.length !== 1 || ends.length !== 1 || ends[0]!.start < starts[0]!.end) {
      warnings.push(`${name}: unbalanced or duplicated markers, skipped`);
      continue;
    }
    const text = eol + body.trim().replace(/\r?\n/g, eol) + eol;
    edits.push({ from: starts[0]!.end, to: ends[0]!.start, text });
  }

  let out = src;
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return { text: out, changed: out !== src, warnings };
}

/** Atomic write (temp + rename); no-op if content identical so file watchers don't loop. */
export function regenerateFile(path: string, blocks: Record<string, string>): SpliceResult {
  if (!existsSync(path)) return { text: "", changed: false, warnings: [`${path} not found`] };
  const res = splice(readFileSync(path, "utf8"), blocks);
  if (res.changed) {
    const tmp = `${path}.knotgraph.tmp`;
    writeFileSync(tmp, res.text);
    renameSync(tmp, path);
  }
  return res;
}
