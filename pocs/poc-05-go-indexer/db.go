package main

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "github.com/mattn/go-sqlite3"
)

const schema = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
  content_hash TEXT NOT NULL, start_line INTEGER NOT NULL DEFAULT 1, end_line INTEGER NOT NULL DEFAULT 1,
  title TEXT, indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, relation_type);
CREATE TABLE IF NOT EXISTS refs (source_id TEXT NOT NULL, target_name TEXT NOT NULL, relation_type TEXT NOT NULL, path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_refs_path ON refs(path);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_name);
`

type Node struct {
	ID, Kind, Name, Path, Hash string
	Start, End                 int
	Title                      *string
}

type Edge struct{ Source, Target, Rel string }

type Plan struct {
	Nodes []Node
	Edges []Edge
	Refs  []Edge
}

func openDB(path string) (*sql.DB, error) {
	dsn := ":memory:"
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		dsn = "file:" + path + "?_txlock=immediate&_journal_mode=WAL&_synchronous=OFF"
	}
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; also keeps :memory: on one connection
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	return db, nil
}

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func deletePath(x execer, path string) error {
	for _, q := range []string{
		"DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE path = ?1) OR target_id IN (SELECT id FROM nodes WHERE path = ?1)",
		"DELETE FROM refs WHERE path = ?1",
		"DELETE FROM nodes WHERE path = ?1",
	} {
		if _, err := x.Exec(q, path); err != nil {
			return err
		}
	}
	return nil
}

func applyPlan(x execer, path string, p *Plan, nowMs int64) error {
	for _, n := range p.Nodes {
		if _, err := x.Exec("INSERT OR REPLACE INTO nodes (id,type,name,path,content_hash,start_line,end_line,title,indexed_at) VALUES (?,?,?,?,?,?,?,?,?)",
			n.ID, n.Kind, n.Name, n.Path, n.Hash, n.Start, n.End, n.Title, nowMs); err != nil {
			return err
		}
	}
	for _, e := range p.Edges {
		if _, err := x.Exec("INSERT OR IGNORE INTO edges VALUES (?,?,?)", e.Source, e.Target, e.Rel); err != nil {
			return err
		}
	}
	for _, r := range p.Refs {
		if _, err := x.Exec("INSERT INTO refs VALUES (?,?,?,?)", r.Source, r.Target, r.Rel, path); err != nil {
			return err
		}
	}
	return nil
}

// resolveFor re-creates only the edges involving path (as ref owner or as target node): O(file), not O(graph).
func resolveFor(x execer, path string) error {
	for _, side := range []string{"r.path = ?1", "n.path = ?1"} {
		if _, err := x.Exec(`INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, r.relation_type FROM refs r JOIN nodes n ON n.name = r.target_name
			WHERE r.relation_type IN ('CALLS','TESTS') AND n.type IN ('function','class') AND n.id <> r.source_id AND `+side, path); err != nil {
			return err
		}
		if _, err := x.Exec(`INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, 'IMPLEMENTS' FROM refs r JOIN nodes n ON n.name = r.target_name
			WHERE r.relation_type = 'IMPLEMENTS' AND n.type = 'adr' AND n.id <> r.source_id AND `+side, path); err != nil {
			return err
		}
	}
	return nil
}

func resolveAll(x execer) error {
	for _, q := range []string{
		"DELETE FROM edges WHERE relation_type IN ('CALLS','TESTS','IMPLEMENTS')",
		`INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, r.relation_type FROM refs r JOIN nodes n ON n.name = r.target_name
		 WHERE r.relation_type IN ('CALLS','TESTS') AND n.type IN ('function','class') AND n.id <> r.source_id`,
		`INSERT OR IGNORE INTO edges SELECT r.source_id, n.id, 'IMPLEMENTS' FROM refs r JOIN nodes n ON n.name = r.target_name
		 WHERE r.relation_type = 'IMPLEMENTS' AND n.type = 'adr' AND n.id <> r.source_id`,
	} {
		if _, err := x.Exec(q); err != nil {
			return err
		}
	}
	return nil
}
