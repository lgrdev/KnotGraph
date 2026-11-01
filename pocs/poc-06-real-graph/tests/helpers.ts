import type { Database } from "bun:sqlite";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexAll } from "../src/graph/invalidate";
import { openDb } from "../src/graph/schema";

export const SHOP = join(import.meta.dir, "../fixtures/shop");

export async function shopCopy(): Promise<{ root: string; db: Database }> {
  const root = mkdtempSync(join(tmpdir(), "kg6-"));
  cpSync(SHOP, root, { recursive: true });
  const db = openDb(":memory:");
  await indexAll(db, root);
  return { root, db };
}

export const names = (xs: { node: { name: string } }[]) => xs.map((x) => x.node.name).sort();
export const depths = (xs: { node: { name: string }; depth: number }[]) => Object.fromEntries(xs.map((x) => [x.node.name, x.depth]));
export const edgeDump = (db: Database) => JSON.stringify(db.query("SELECT * FROM edges ORDER BY 1,2,3").all());
export const nodeDump = (db: Database) => JSON.stringify(db.query("SELECT id,type,name,path,title,status,content_hash FROM nodes ORDER BY id").all());
