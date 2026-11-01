import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splice } from "../src/builder/claude-md";

const src = readFileSync(join(import.meta.dir, "../fixtures/sample-repo/CLAUDE.md"), "utf8").replace(/<!-- KNOTGRAPH:ARCHITECTURE:START -->[^]*?<!-- KNOTGRAPH:ARCHITECTURE:END -->/, "<!-- KNOTGRAPH:ARCHITECTURE:START -->\n<!-- KNOTGRAPH:ARCHITECTURE:END -->");
const B = { ARCHITECTURE: "arch **body**", MAP: "| a |\n|---|\n| b |" };

test("only marker interiors change; everything else byte-identical", () => {
  const r = splice(src, B);
  expect(r.changed).toBe(true);
  const strip = (s: string) => s.replace(/(<!-- KNOTGRAPH:(\w+):START -->)[^]*?(<!-- KNOTGRAPH:\2:END -->)/g, "$1$3");
  // fence marker has no END so the lazy regex pairs the *real* ARCHITECTURE pair only; compare outside ranges
  expect(strip(r.text).replace(/<!-- KNOTGRAPH:MAP:START -->[^]*$/, "")).toBe(strip(src).replace(/<!-- KNOTGRAPH:MAP:START -->[^]*$/, ""));
  expect(r.text.startsWith("# Sample project\n\nManual intro, **must never change**.   \n  Trailing spaces and odd   spacing kept.")).toBe(true);
  expect(r.text.endsWith("Footer without trailing newline")).toBe(true);
  expect(r.text).toContain("<!-- KNOTGRAPH:ARCHITECTURE:START -->\narch **body**\n<!-- KNOTGRAPH:ARCHITECTURE:END -->");
  expect(r.text).toContain("this marker lives in a code fence and must be ignored");
});

test("idempotent", () => {
  const once = splice(src, B).text;
  const twice = splice(once, B);
  expect(twice.changed).toBe(false);
  expect(twice.text).toBe(once);
});

test("missing markers: no-op + warning", () => {
  const r = splice("# hi\n", B);
  expect(r.changed).toBe(false);
  expect(r.warnings).toHaveLength(2);
});

test("unbalanced / reversed / duplicated markers: block skipped, text untouched", () => {
  for (const bad of [
    "<!-- KNOTGRAPH:MAP:START -->\nold\n",
    "<!-- KNOTGRAPH:MAP:END -->\n<!-- KNOTGRAPH:MAP:START -->\n",
    "<!-- KNOTGRAPH:MAP:START -->\n<!-- KNOTGRAPH:MAP:END -->\n<!-- KNOTGRAPH:MAP:START -->\n<!-- KNOTGRAPH:MAP:END -->\n",
  ]) {
    const r = splice(bad, { MAP: "x" });
    expect(r.text).toBe(bad);
    expect(r.warnings[0]).toContain("MAP");
  }
});

test("CRLF preserved", () => {
  const crlf = "# t\r\n<!-- KNOTGRAPH:MAP:START -->\r\nold\r\n<!-- KNOTGRAPH:MAP:END -->\r\ntail\r\n";
  const r = splice(crlf, { MAP: "a\nb" });
  expect(r.text).toBe("# t\r\n<!-- KNOTGRAPH:MAP:START -->\r\na\r\nb\r\n<!-- KNOTGRAPH:MAP:END -->\r\ntail\r\n");
  expect(r.text.replace(/\r\n/g, "").includes("\n")).toBe(false);
});
