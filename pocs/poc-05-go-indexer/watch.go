package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/fsnotify/fsnotify"
)

type Event struct {
	Path    string
	Applied bool
	Ms      float64
}

// addTree watches dir and every sub-directory (fsnotify is not recursive).
func addTree(w *fsnotify.Watcher, dir string) {
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() && !isIgnored(filepath.Base(p)) {
			w.Add(p)
		}
		return nil
	})
}

// runWatcher watches src/, docs/, ADR/ (those that exist), coalescing bursts per path over 5 ms, applying serially.
// It returns when stop is closed. ready (optional) is signalled once watches are installed.
func runWatcher(ix *Indexer, onEvent func(Event), ready chan<- struct{}, stop <-chan struct{}) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()
	for _, d := range []string{"src", "docs", "ADR"} {
		p := filepath.Join(ix.Root, d)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			addTree(w, p)
		}
	}
	if ready != nil {
		ready <- struct{}{}
	}
	for {
		paths := map[string]bool{}
		collect := func(e fsnotify.Event) {
			// Chmod-only events carry no content change; plain reads emit nothing (IN_ACCESS is not subscribed).
			if e.Op == fsnotify.Chmod {
				return
			}
			if e.Op.Has(fsnotify.Create) {
				if st, err := os.Stat(e.Name); err == nil && st.IsDir() {
					addTree(w, e.Name) // directories created later are picked up
					return
				}
			}
			if rel, err := filepath.Rel(ix.Root, e.Name); err == nil {
				if rel = filepath.ToSlash(rel); isIndexable(rel) {
					paths[rel] = true
				}
			}
		}
		select {
		case <-stop:
			return nil
		case err := <-w.Errors:
			return err
		case e := <-w.Events:
			collect(e)
		}
		for t := time.After(5 * time.Millisecond); ; {
			select {
			case e := <-w.Events:
				collect(e)
				continue
			case <-t:
			}
			break
		}
		sorted := make([]string, 0, len(paths))
		for p := range paths {
			sorted = append(sorted, p)
		}
		sort.Strings(sorted)
		for _, rel := range sorted {
			st, err := os.Stat(filepath.Join(ix.Root, rel))
			a, err := ix.applyChange(rel, err != nil || st.IsDir())
			if err != nil {
				os.Stderr.WriteString("[knotgraph] error on " + rel + ": " + err.Error() + "\n")
				continue
			}
			onEvent(Event{rel, a.Applied, a.Ms})
		}
	}
}
