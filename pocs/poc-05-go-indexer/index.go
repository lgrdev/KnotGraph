package main

import (
	"database/sql"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	sitter "github.com/smacker/go-tree-sitter"
)

type Indexer struct {
	DB     *sql.DB
	parser *sitter.Parser
	Root   string
}

type Applied struct {
	Applied bool
	Ms      float64
}

type Stats struct {
	Files, Changed, Removed int
	Ms                      float64
}

func newIndexer(db *sql.DB, root string) *Indexer {
	return &Indexer{DB: db, parser: newParser(), Root: root}
}

func isIgnored(rel string) bool {
	for _, s := range strings.Split(rel, "/") {
		switch s {
		case "node_modules", ".git", ".knotgraph", "dist", "target":
			return true
		}
	}
	return false
}

func isDocFile(rel string) bool {
	if !strings.HasSuffix(rel, ".md") || !strings.Contains(rel, "/") {
		return false
	}
	for _, s := range strings.Split(rel, "/") {
		if s == "docs" || s == "ADR" || s == "adr" {
			return true
		}
	}
	return false
}

func isIndexable(rel string) bool { return !isIgnored(rel) && (isCodeFile(rel) || isDocFile(rel)) }

func hashOf(s string) string {
	h := fnv.New64a() // same FNV-1a as the Rust version
	h.Write([]byte(s))
	return fmt.Sprintf("%016x", h.Sum64())
}

func walkRepo(root, dir string, acc *[]string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if isIgnored(rel) {
			continue
		}
		if e.IsDir() {
			walkRepo(root, p, acc)
		} else if isIndexable(rel) {
			*acc = append(*acc, rel)
		}
	}
}

func (ix *Indexer) plan(rel, source string) *Plan {
	hash := hashOf(source)
	lines := strings.Count(source, "\n") + 1
	plan := &Plan{}
	base := rel[strings.LastIndex(rel, "/")+1:]

	if isDocFile(rel) {
		d := parseDoc(rel, source)
		id := "adr:" + d.ID
		title := d.Title
		plan.Nodes = append(plan.Nodes, Node{ID: id, Kind: "adr", Name: d.ID, Path: rel, Hash: hash, Start: 1, End: lines, Title: &title})
		for _, t := range d.Implements {
			plan.Refs = append(plan.Refs, Edge{id, t, "IMPLEMENTS"})
		}
		return plan
	}

	p := parseCode(ix.parser, rel, source)
	if p.IsTest {
		id := "test:" + rel
		plan.Nodes = append(plan.Nodes, Node{ID: id, Kind: "test", Name: base, Path: rel, Hash: hash, Start: 1, End: lines})
		imported := map[string]bool{}
		for _, i := range p.Imports {
			imported[i] = true
		}
		seen := map[string]bool{}
		for _, c := range p.Calls {
			if imported[c.Callee] && !seen[c.Callee] {
				seen[c.Callee] = true
				plan.Refs = append(plan.Refs, Edge{id, c.Callee, "TESTS"})
			}
		}
		return plan
	}

	fileID := "file:" + rel
	plan.Nodes = append(plan.Nodes, Node{ID: fileID, Kind: "file", Name: base, Path: rel, Hash: hash, Start: 1, End: lines})
	idOf := func(name string) string {
		for _, s := range p.Symbols {
			if s.Name == name {
				prefix := "fn"
				if s.IsClass {
					prefix = "class"
				}
				return fmt.Sprintf("%s:%s#%s", prefix, rel, s.Name)
			}
		}
		return ""
	}
	for _, s := range p.Symbols {
		id, kind := idOf(s.Name), "function"
		if s.IsClass {
			kind = "class"
		}
		plan.Nodes = append(plan.Nodes, Node{ID: id, Kind: kind, Name: s.Name, Path: rel, Hash: hash, Start: s.Start, End: s.End})
		plan.Edges = append(plan.Edges, Edge{fileID, id, "CONTAINS"})
	}
	for _, c := range p.Calls {
		if c.Caller != "" {
			if src := idOf(c.Caller); src != "" {
				plan.Refs = append(plan.Refs, Edge{src, c.Callee, "CALLS"})
			}
		}
	}
	for _, r := range p.Refs {
		src := fileID
		if r.Symbol != "" {
			src = idOf(r.Symbol)
		}
		plan.Refs = append(plan.Refs, Edge{src, r.ADR, "IMPLEMENTS"})
	}
	return plan
}

func (ix *Indexer) storedHash(rel string) (string, bool) {
	var h string
	err := ix.DB.QueryRow("SELECT content_hash FROM nodes WHERE path = ?1 LIMIT 1", rel).Scan(&h)
	return h, err == nil
}

// applyChange is the hot path: parse outside the transaction, then purge + insert + scoped resolve in ONE immediate transaction.
func (ix *Indexer) applyChange(rel string, unlink bool) (Applied, error) {
	t0 := time.Now()
	done := func(ok bool) Applied { return Applied{ok, float64(time.Since(t0).Microseconds()) / 1000} }
	var source *string
	if !unlink {
		if b, err := os.ReadFile(filepath.Join(ix.Root, rel)); err == nil {
			s := string(b)
			source = &s
		}
	}
	prev, hasPrev := ix.storedHash(rel)
	if source != nil && hasPrev && hashOf(*source) == prev {
		return done(false), nil
	}
	if source == nil && !hasPrev {
		return done(false), nil
	}
	var plan *Plan
	if source != nil {
		plan = ix.plan(rel, *source)
	}
	tx, err := ix.DB.Begin()
	if err != nil {
		return Applied{}, err
	}
	defer tx.Rollback()
	if err := deletePath(tx, rel); err != nil {
		return Applied{}, err
	}
	if plan != nil {
		if err := applyPlan(tx, rel, plan, time.Now().UnixMilli()); err != nil {
			return Applied{}, err
		}
	}
	if err := resolveFor(tx, rel); err != nil {
		return Applied{}, err
	}
	if err := tx.Commit(); err != nil {
		return Applied{}, err
	}
	return done(true), nil
}

// indexAll is the cold start: index every file, then one global resolve.
func (ix *Indexer) indexAll() (Stats, error) {
	t0 := time.Now()
	var files []string
	walkRepo(ix.Root, ix.Root, &files)
	sort.Strings(files)
	tx, err := ix.DB.Begin()
	if err != nil {
		return Stats{}, err
	}
	defer tx.Rollback()
	changed, removed := 0, 0
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(ix.Root, f))
		if err != nil {
			continue
		}
		src := string(b)
		var h string
		if tx.QueryRow("SELECT content_hash FROM nodes WHERE path = ?1 LIMIT 1", f).Scan(&h) == nil && h == hashOf(src) {
			continue
		}
		if err := deletePath(tx, f); err != nil {
			return Stats{}, err
		}
		if err := applyPlan(tx, f, ix.plan(f, src), time.Now().UnixMilli()); err != nil {
			return Stats{}, err
		}
		changed++
	}
	present := map[string]bool{}
	for _, f := range files {
		present[f] = true
	}
	rows, err := tx.Query("SELECT DISTINCT path FROM nodes")
	if err != nil {
		return Stats{}, err
	}
	var gone []string
	for rows.Next() {
		var p string
		rows.Scan(&p)
		if !present[p] {
			gone = append(gone, p)
		}
	}
	rows.Close()
	for _, p := range gone {
		if err := deletePath(tx, p); err != nil {
			return Stats{}, err
		}
		removed++
	}
	if changed > 0 || removed > 0 {
		if err := resolveAll(tx); err != nil {
			return Stats{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Stats{}, err
	}
	return Stats{len(files), changed, removed, float64(time.Since(t0).Microseconds()) / 1000}, nil
}
