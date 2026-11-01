package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func copyDir(t *testing.T, from, to string) {
	t.Helper()
	filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, _ := os.ReadFile(p)
		return os.WriteFile(dst, b, 0o644)
	})
}

func setup(t *testing.T) (string, *Indexer) {
	t.Helper()
	root := t.TempDir()
	copyDir(t, "fixtures/sample-repo", root)
	db, err := openDB(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	ix := newIndexer(db, root)
	if _, err := ix.indexAll(); err != nil {
		t.Fatal(err)
	}
	return root, ix
}

func dump(t *testing.T, db *sql.DB, q string) []string {
	t.Helper()
	rows, err := db.Query(q)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var a, b, c string
		rows.Scan(&a, &b, &c)
		out = append(out, a+"|"+b+"|"+c)
	}
	return out
}

func hasEdge(t *testing.T, db *sql.DB, s, tg, r string) bool {
	t.Helper()
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM edges e JOIN nodes a ON a.id=e.source_id JOIN nodes b ON b.id=e.target_id
		WHERE a.name=?1 AND b.name=?2 AND e.relation_type=?3`, s, tg, r).Scan(&n)
	return n == 1
}

func count(db *sql.DB, q string) (n int) { db.QueryRow(q).Scan(&n); return }

func TestParserExtractsSymbolsImportsCallsRefs(t *testing.T) {
	b, _ := os.ReadFile("fixtures/sample-repo/src/vat.ts")
	c := parseCode(newParser(), "src/vat.ts", string(b))
	if len(c.Symbols) != 1 || c.Symbols[0].Name != "calculateVAT" {
		t.Fatalf("symbols: %+v", c.Symbols)
	}
	if !reflect.DeepEqual(c.Imports, []string{"getRate"}) {
		t.Fatalf("imports: %v", c.Imports)
	}
	if !reflect.DeepEqual(c.Calls, []Call{{"calculateVAT", "getRate"}}) {
		t.Fatalf("calls: %+v", c.Calls)
	}
	if !reflect.DeepEqual(c.Refs, []Ref{{"ADR-001", 3, "calculateVAT"}}) {
		t.Fatalf("refs: %+v", c.Refs)
	}
}

func TestParserArrowClassMethod(t *testing.T) {
	c := parseCode(newParser(), "a.ts", "export const f = (x: number) => g(x);\nclass K { m() { return f(1); } }\n")
	var got []string
	for _, s := range c.Symbols {
		got = append(got, fmt.Sprintf("%s/%v", s.Name, s.IsClass))
	}
	if strings.Join(got, ",") != "f/false,K/true,m/false" {
		t.Fatalf("symbols: %v", got)
	}
	if !reflect.DeepEqual(c.Calls[len(c.Calls)-1], Call{"m", "f"}) {
		t.Fatalf("calls: %+v", c.Calls)
	}
}

func TestDocFrontmatter(t *testing.T) {
	d := parseDoc("docs/ADR-004-x.md", "---\nid: ADR-004\ntitle: \"VAT\"\nimplements: [ADR-001, ADR-002]\n---\n# Heading\n")
	if d.ID != "ADR-004" || d.Title != "VAT" || len(d.Implements) != 2 {
		t.Fatalf("%+v", d)
	}
	d = parseDoc("docs/ADR-009-y.md", "# Order flow\n")
	if d.ID != "ADR-009" || d.Title != "Order flow" {
		t.Fatalf("%+v", d)
	}
	d = parseDoc("docs/z.md", "---\nimplements:\n  - A\n  - B\n---\n")
	if !reflect.DeepEqual(d.Implements, []string{"A", "B"}) {
		t.Fatalf("%+v", d)
	}
}

func TestColdIndexBuildsGraph(t *testing.T) {
	_, ix := setup(t)
	if !hasEdge(t, ix.DB, "calculateVAT", "ADR-001", "IMPLEMENTS") || !hasEdge(t, ix.DB, "cartTotal", "calculateVAT", "CALLS") {
		t.Fatal("missing edges")
	}
}

func TestChangeTouchesOnlyThatFileAndRestoresInboundEdges(t *testing.T) {
	root, ix := setup(t)
	q := "SELECT id, type, content_hash FROM nodes WHERE path='src/rates.ts' ORDER BY 1"
	before := dump(t, ix.DB, q)
	b, _ := os.ReadFile(filepath.Join(root, "src/vat.ts"))
	os.WriteFile(filepath.Join(root, "src/vat.ts"), append(b, []byte("\nexport function extra() { return calculateVAT(1, 'FR'); }\n")...), 0o644)
	a, err := ix.applyChange("src/vat.ts", false)
	if err != nil || !a.Applied || a.Ms >= 50 {
		t.Fatalf("%+v %v", a, err)
	}
	if !reflect.DeepEqual(before, dump(t, ix.DB, q)) {
		t.Fatal("other file changed")
	}
	for _, e := range [][3]string{{"extra", "calculateVAT", "CALLS"}, {"cartTotal", "calculateVAT", "CALLS"}, {"calculateVAT", "ADR-001", "IMPLEMENTS"}} {
		if !hasEdge(t, ix.DB, e[0], e[1], e[2]) {
			t.Fatalf("missing %v", e)
		}
	}
}

func TestUnchangedContentSkipped(t *testing.T) {
	_, ix := setup(t)
	if a, _ := ix.applyChange("src/vat.ts", false); a.Applied {
		t.Fatal("should skip")
	}
}

func TestUnlinkRemovesNodesAndAllTouchingEdges(t *testing.T) {
	root, ix := setup(t)
	os.Remove(filepath.Join(root, "src/vat.ts"))
	if a, _ := ix.applyChange("src/vat.ts", true); !a.Applied {
		t.Fatal("should apply")
	}
	if n := count(ix.DB, "SELECT COUNT(*) FROM nodes WHERE path='src/vat.ts'"); n != 0 {
		t.Fatalf("nodes left: %d", n)
	}
	if n := count(ix.DB, "SELECT COUNT(*) FROM edges WHERE source_id LIKE '%vat.ts%' OR target_id LIKE '%vat.ts%'"); n != 0 {
		t.Fatalf("edges left: %d", n)
	}
}

func TestIncrementalEqualsFullReindex(t *testing.T) {
	root, ix := setup(t)
	os.WriteFile(filepath.Join(root, "src/new.ts"), []byte("import { getRate } from './rates';\nexport function useRate() { return getRate('FR'); }\n"), 0o644)
	if _, err := ix.applyChange("src/new.ts", false); err != nil {
		t.Fatal(err)
	}
	db2, _ := openDB(":memory:")
	full := newIndexer(db2, root)
	full.indexAll()
	q := "SELECT source_id, target_id, relation_type FROM edges ORDER BY 1,2,3"
	if !reflect.DeepEqual(dump(t, ix.DB, q), dump(t, full.DB, q)) {
		t.Fatal("incremental != full")
	}
}

func TestWatcherAppliesEditsAndDoesNotLoopOnOwnReads(t *testing.T) {
	root, ix := setup(t)
	events := make(chan Event, 64)
	ready, stop := make(chan struct{}, 1), make(chan struct{})
	go runWatcher(ix, func(e Event) { events <- e }, ready, stop)
	defer close(stop)
	<-ready
	os.WriteFile(filepath.Join(root, "src/fresh.ts"), []byte("export function fresh() { return 1; }\n"), 0o644)
	select {
	case e := <-events:
		if e.Path != "src/fresh.ts" || !e.Applied {
			t.Fatalf("%+v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
	}
	time.Sleep(400 * time.Millisecond)
	extra := 0
	for len(events) > 0 {
		if e := <-events; !e.Applied {
			extra++
		}
	}
	if extra != 0 {
		t.Fatalf("self-triggered events: %d", extra)
	}
	os.Remove(filepath.Join(root, "src/fresh.ts"))
	select {
	case e := <-events:
		if e.Path != "src/fresh.ts" || !e.Applied {
			t.Fatalf("%+v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no unlink event")
	}
}
