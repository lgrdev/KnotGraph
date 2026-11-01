import type { Database } from "bun:sqlite";
import chokidar, { type FSWatcher } from "chokidar";
import { join, relative } from "node:path";
import { applyChange, isIndexable, type ChangeKind } from "../graph/invalidate";

export interface WatchEvent { path: string; kind: ChangeKind; applied: boolean; ms: number }

export interface Watcher {
  ready: Promise<void>;
  /** Resolves when the serial queue is empty (tests/bench). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Watch src/ and docs/ (+ ADR/). Events go through ONE serial queue so SQLite transactions never overlap.
 * Same-path bursts are coalesced to the latest event kind.
 */
export function startWatcher(db: Database, root: string, onEvent: (e: WatchEvent) => void, onError: (e: unknown) => void = console.error): Watcher {
  const pending = new Map<string, ChangeKind>();
  let running: Promise<void> = Promise.resolve();
  let scheduled = false;

  const drain = async () => {
    scheduled = false;
    for (const [path, kind] of [...pending]) {
      pending.delete(path);
      try {
        const r = await applyChange(db, root, path, kind);
        onEvent({ path, kind, applied: r.applied, ms: r.ms });
      } catch (e) {
        onError(e);
      }
    }
  };
  const enqueue = (abs: string, kind: ChangeKind) => {
    const rel = relative(root, abs);
    if (!isIndexable(rel)) return;
    // add+change keep "add"; anything then unlink => unlink; unlink then add => change
    const prev = pending.get(rel);
    pending.set(rel, prev === "unlink" && kind === "add" ? "change" : kind);
    if (!scheduled) {
      scheduled = true;
      running = running.then(drain);
    }
  };

  const w: FSWatcher = chokidar.watch(["src", "docs", "ADR"].map((d) => join(root, d)), {
    ignoreInitial: true,
    ignored: (p) => /(^|\/)(node_modules|\.git|\.knotgraph)(\/|$)/.test(p),
  });
  w.on("add", (p) => enqueue(p, "add")).on("change", (p) => enqueue(p, "change")).on("unlink", (p) => enqueue(p, "unlink")).on("error", onError);

  return {
    ready: new Promise((res) => w.once("ready", () => res())),
    idle: async () => { do { await running; } while (pending.size); },
    close: () => w.close(),
  };
}
