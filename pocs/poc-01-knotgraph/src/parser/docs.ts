import matter from "gray-matter";

export interface DocParse {
  id: string; // e.g. ADR-001
  title: string;
  headings: string[];
  implements: string[];
}

const toArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

export function parseDoc(path: string, source: string): DocParse {
  const { data, content } = matter(source);
  const headings = [...content.matchAll(/^#{1,2}\s+(.+?)\s*$/gm)].map((m) => m[1]!);
  const base = path.split("/").pop()!.replace(/\.md$/i, "");
  const id = data.id ? String(data.id) : (/^(ADR-\d+)/i.exec(base)?.[1]?.toUpperCase() ?? base);
  const title = data.title ? String(data.title) : (headings[0] ?? base);
  return { id, title, headings, implements: toArray(data.implements) };
}
