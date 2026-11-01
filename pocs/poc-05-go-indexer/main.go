package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
)

func main() {
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	root := "."
	if len(args) > 1 {
		root = args[1]
	}
	root, _ = filepath.Abs(root)
	dbPath := filepath.Join(root, ".knotgraph", "graph.db")
	switch cmd {
	case "index":
		db, err := openDB(dbPath)
		check(err)
		s, err := newIndexer(db, root).indexAll()
		check(err)
		fmt.Printf("{\"files\":%d,\"changed\":%d,\"removed\":%d,\"ms\":%.1f}\n", s.Files, s.Changed, s.Removed, s.Ms)
	case "watch":
		db, err := openDB(dbPath)
		check(err)
		ix := newIndexer(db, root)
		s, err := ix.indexAll()
		check(err)
		fmt.Fprintf(os.Stderr, "[knotgraph] cold index %d files in %.1fms\n", s.Files, s.Ms)
		fmt.Fprintf(os.Stderr, "[knotgraph] watching %s\n", root)
		stop := make(chan struct{})
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt)
		go func() { <-sig; close(stop) }()
		check(runWatcher(ix, func(e Event) {
			if e.Applied {
				fmt.Fprintf(os.Stderr, "[knotgraph] %s reindexed in %.2fms\n", e.Path, e.Ms)
			} else {
				fmt.Fprintf(os.Stderr, "[knotgraph] %s unchanged\n", e.Path)
			}
		}, nil, stop))
	case "bench":
		runBench()
	default:
		fmt.Fprintln(os.Stderr, "usage: go-indexer index|watch <root> | bench")
		os.Exit(1)
	}
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
