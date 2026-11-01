import type { Database } from "bun:sqlite";

/** Deterministic (sorted, no timestamps) so repeated runs are byte-identical. */
export function renderBlocks(db: Database): Record<string, string> {
  return { ARCHITECTURE: renderArchitecture(db), MAP: renderMap(db) };
}

function renderArchitecture(db: Database): string {
  const counts = Object.fromEntries(
    db.query<{ type: string; c: number }, []>("SELECT type, COUNT(*) c FROM nodes GROUP BY type").all().map((r) => [r.type, r.c]),
  );
  const lines = [
    `- **Indexed:** ${counts.file ?? 0} files, ${counts.function ?? 0} functions, ${counts.class ?? 0} classes, ${counts.test ?? 0} test files, ${counts.adr ?? 0} ADRs`,
    "- **Active ADRs:**",
  ];
  const adrs = db.query<{ id: string; name: string; title: string | null; path: string }, []>("SELECT id, name, title, path FROM nodes WHERE type='adr' ORDER BY name").all();
  if (!adrs.length) lines.push("  - _none_");
  for (const a of adrs) {
    const impl = db
      .query<{ name: string }, [string]>("SELECT DISTINCT s.name FROM edges e JOIN nodes s ON s.id = e.source_id WHERE e.relation_type='IMPLEMENTS' AND e.target_id = ? AND s.type IN ('function','class') ORDER BY s.name")
      .all(a.id)
      .map((r) => `\`${r.name}\``);
    lines.push(`  - ${a.name}: ${a.title ?? a.name} (\`${a.path}\`)${impl.length ? ` — implemented by ${impl.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

function renderMap(db: Database): string {
  const rows = db
    .query<{ path: string; symbols: number; adrs: string | null }, []>(
      `SELECT f.path, COUNT(DISTINCT c.target_id) symbols,
              (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT DISTINCT a.name FROM edges e JOIN nodes a ON a.id = e.target_id
                 WHERE e.relation_type='IMPLEMENTS' AND a.type='adr' AND (e.source_id = f.id OR e.source_id IN (SELECT target_id FROM edges WHERE source_id = f.id AND relation_type='CONTAINS')) ORDER BY a.name)) adrs
       FROM nodes f LEFT JOIN edges c ON c.source_id = f.id AND c.relation_type='CONTAINS'
       WHERE f.type='file' GROUP BY f.id ORDER BY f.path`,
    )
    .all();
  const lines = ["| Module | Symbols | ADRs |", "|---|---|---|"];
  for (const r of rows) lines.push(`| \`${r.path}\` | ${r.symbols} | ${r.adrs ?? "—"} |`);
  const hot = db
    .query<{ name: string; path: string; n: number }, []>(
      `SELECT s.name, s.path, COUNT(DISTINCT e.source_id) n FROM edges e JOIN nodes s ON s.id = e.target_id
       WHERE e.relation_type='CALLS' GROUP BY s.id ORDER BY n DESC, s.name LIMIT 5`,
    )
    .all();
  if (hot.length) {
    lines.push("", "**Blast radius hotspots (most called):**");
    for (const h of hot) lines.push(`- \`${h.name}\` (\`${h.path}\`): ${h.n} caller${h.n > 1 ? "s" : ""}`);
  }
  return lines.join("\n");
}
