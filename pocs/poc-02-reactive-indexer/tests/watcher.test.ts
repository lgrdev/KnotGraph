import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/graph/db";
import { indexAll } from "../src/graph/invalidate";
import { startWatcher, type WatchEvent } from "../src/watcher/watcher";

const FIX = join(import.meta.dir, "../fixtures/sample-repo");
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await Bun.sleep(10); } };

test("add/change/unlink flow through to SQLite; CLAUDE.md ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "kg2w-"));
  cpSync(FIX, root, { recursive: true });
  const db = openDb(":memory:");
  await indexAll(db, root);
  const events: WatchEvent[] = [];
  const w = startWatcher(db, root, (e) => events.push(e));
  await w.ready;

  writeFileSync(join(root, "src/new.ts"), "export function fresh() { return 1; }\n");
  await until(() => events.some((e) => e.path === "src/new.ts"));
  expect(db.query("SELECT 1 FROM nodes WHERE name='fresh'").all()).toHaveLength(1);

  appendFileSync(join(root, "src/new.ts"), "export function fresh2() { return 2; }\n");
  await until(() => !!db.query("SELECT 1 FROM nodes WHERE name='fresh2'").get());

  unlinkSync(join(root, "src/new.ts"));
  await until(() => !db.query("SELECT 1 FROM nodes WHERE name='fresh'").get());

  const n = events.length;
  appendFileSync(join(root, "CLAUDE.md"), "\nedit\n");
  await Bun.sleep(300);
  expect(events.length).toBe(n);
  await w.idle();
  await w.close();
  rmSync(root, { recursive: true, force: true });
});
