import matter from "gray-matter";

export interface DocParse {
  id: string; // e.g. ADR-001
  title: string;
  status: string | null;
  headings: string[];
  implements: string[];
  /** `rules:` entries; `- RULE-ID: text` (YAML map) or "RULE-ID: text" (string). */
  rules: { id: string; text: string }[];
  tickets: string[];
}

const toArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v ? [String(v)] : [];

function parseRules(v: unknown): { id: string; text: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { id: string; text: string }[] = [];
  for (const it of v) {
    if (it && typeof it === "object") for (const [k, t] of Object.entries(it)) out.push({ id: k, text: String(t ?? "") });
    else if (typeof it === "string") {
      const i = it.indexOf(":");
      out.push(i > 0 ? { id: it.slice(0, i).trim(), text: it.slice(i + 1).trim() } : { id: it.trim(), text: "" });
    }
  }
  return out;
}

export function parseDoc(path: string, source: string): DocParse {
  const { data, content } = matter(source);
  const headings = [...content.matchAll(/^#{1,2}\s+(.+?)\s*$/gm)].map((m) => m[1]!);
  const base = path.split("/").pop()!.replace(/\.md$/i, "");
  const id = data.id ? String(data.id) : (/^(ADR-\d+)/i.exec(base)?.[1]?.toUpperCase() ?? base);
  const title = data.title ? String(data.title) : (headings[0] ?? base);
  return {
    id, title, headings,
    status: data.status ? String(data.status) : null,
    implements: toArray(data.implements),
    rules: parseRules(data.rules),
    tickets: toArray(data.tickets),
  };
}
