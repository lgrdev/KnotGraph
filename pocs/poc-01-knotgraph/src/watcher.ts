import type { Database } from "bun:sqlite";
import { watch, type FSWatcher } from "node:fs";
import { IGNORED_SEGMENT, isIndexable, reindexFile } from "./indexer";

/** Watch root recursively; reindex each changed file (debounced per path). */
export function startWatcher(db: Database, root: string, onUpdate?: (path: string, ms: number) => void): FSWatcher {
  const timers = new Map<string, Timer>();
  return watch(root, { recursive: true }, (_evt, filename) => {
    if (!filename || IGNORED_SEGMENT.test(filename) || !isIndexable(filename)) return;
    clearTimeout(timers.get(filename));
    timers.set(
      filename,
      setTimeout(async () => {
        timers.delete(filename);
        const s = await reindexFile(db, root, filename);
        if (s.changed || s.removed) onUpdate?.(filename, s.ms);
      }, 30),
    );
  });
}
