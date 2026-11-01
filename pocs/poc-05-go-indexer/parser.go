package main

import (
	"context"
	"strings"
	"unicode"

	sitter "github.com/smacker/go-tree-sitter"
	"github.com/smacker/go-tree-sitter/typescript/typescript"
)

type Symbol struct {
	Name       string
	IsClass    bool
	Start, End int
}

type Call struct{ Caller, Callee string } // Caller "" = top level

type Ref struct {
	ADR    string
	Line   int
	Symbol string // "" = none
}

type CodeParse struct {
	Symbols []Symbol
	Imports []string
	Calls   []Call
	Refs    []Ref
	IsTest  bool
}

func isTestFile(p string) bool {
	f := p[strings.LastIndex(p, "/")+1:]
	return strings.Contains(f, ".test.") || strings.Contains(f, ".spec.")
}

func isCodeFile(p string) bool {
	if strings.HasSuffix(p, ".d.ts") {
		return false
	}
	for _, e := range []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"} {
		if strings.HasSuffix(p, e) {
			return true
		}
	}
	return false
}

func newParser() *sitter.Parser {
	p := sitter.NewParser()
	// The TypeScript grammar also parses plain JS; good enough for the PoC.
	p.SetLanguage(typescript.GetLanguage())
	return p
}

func isIdentRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }

func refIDs(comment string) []string {
	var out []string
	rest := comment
	for {
		i := strings.Index(rest, "@ref")
		if i < 0 {
			return out
		}
		after := strings.TrimLeftFunc(rest[i+4:], unicode.IsSpace)
		end := 0
		for end < len(after) && (isIdentRune(rune(after[end])) || after[end] == '-') {
			end++
		}
		if end > 0 && unicode.IsLetter(rune(after[0])) {
			out = append(out, after[:end])
		}
		rest = rest[i+4:]
	}
}

func parseCode(p *sitter.Parser, path, source string) *CodeParse {
	out := &CodeParse{IsTest: isTestFile(path)}
	tree, err := p.ParseCtx(context.Background(), nil, []byte(source))
	if err != nil || tree == nil {
		return out
	}
	defer tree.Close()
	walk(tree.RootNode(), []byte(source), "", out)
	for i := range out.Refs {
		r := &out.Refs[i]
		best, bestStart := "", -1
		for _, s := range out.Symbols { // innermost enclosing symbol
			if s.Start <= r.Line && r.Line <= s.End && s.Start > bestStart {
				best, bestStart = s.Name, s.Start
			}
		}
		if best == "" { // else the symbol starting within 3 lines after the comment
			next := 1 << 30
			for _, s := range out.Symbols {
				if s.Start > r.Line && s.Start-r.Line <= 3 && s.Start < next {
					best, next = s.Name, s.Start
				}
			}
		}
		r.Symbol = best
	}
	return out
}

func walk(n *sitter.Node, src []byte, caller string, out *CodeParse) {
	next := caller
	row := int(n.StartPoint().Row) + 1
	end := int(n.EndPoint().Row) + 1
	switch n.Type() {
	case "function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration":
		if name := n.ChildByFieldName("name"); name != nil {
			isClass := strings.Contains(n.Type(), "class")
			out.Symbols = append(out.Symbols, Symbol{name.Content(src), isClass, row, end})
			if !isClass {
				next = name.Content(src)
			}
		}
	case "method_definition":
		if name := n.ChildByFieldName("name"); name != nil && name.Content(src) != "constructor" {
			out.Symbols = append(out.Symbols, Symbol{name.Content(src), false, row, end})
			next = name.Content(src)
		}
	case "variable_declarator":
		v, name := n.ChildByFieldName("value"), n.ChildByFieldName("name")
		if v != nil && name != nil && name.Type() == "identifier" {
			switch v.Type() {
			case "arrow_function", "function_expression", "function":
				out.Symbols = append(out.Symbols, Symbol{name.Content(src), false, row, end})
				next = name.Content(src)
			}
		}
	case "import_specifier", "namespace_import":
		id := n.ChildByFieldName("alias")
		if id == nil {
			id = n.ChildByFieldName("name")
		}
		if id == nil {
			for i := 0; i < int(n.NamedChildCount()); i++ {
				if c := n.NamedChild(i); c.Type() == "identifier" {
					id = c
					break
				}
			}
		}
		if id != nil {
			out.Imports = append(out.Imports, id.Content(src))
		}
	case "import_clause":
		for i := 0; i < int(n.NamedChildCount()); i++ {
			if c := n.NamedChild(i); c.Type() == "identifier" {
				out.Imports = append(out.Imports, c.Content(src))
				break
			}
		}
	case "call_expression":
		if f := n.ChildByFieldName("function"); f != nil {
			callee := f.Content(src)
			if f.Type() == "member_expression" {
				callee = ""
				if pr := f.ChildByFieldName("property"); pr != nil {
					callee = pr.Content(src)
				}
			}
			ok := callee != ""
			for _, r := range callee {
				if !isIdentRune(r) && r != '$' {
					ok = false
				}
			}
			if ok {
				out.Calls = append(out.Calls, Call{caller, callee})
			}
		}
	case "comment":
		for _, id := range refIDs(n.Content(src)) {
			out.Refs = append(out.Refs, Ref{ADR: id, Line: row})
		}
	}
	for i := 0; i < int(n.ChildCount()); i++ {
		walk(n.Child(i), src, next, out)
	}
}

// ---------- Markdown ADR (frontmatter only; no YAML dependency) ----------

type DocParse struct {
	ID, Title  string
	Implements []string
}

func trimQuotes(s string) string { return strings.Trim(strings.TrimSpace(s), `"'`) }

func parseDoc(path, source string) DocParse {
	var id, title string
	var impl []string
	body := source
	rest := strings.TrimPrefix(strings.TrimPrefix(source, "---\r\n"), "---\n")
	if rest != source {
		if end := strings.Index(rest, "\n---"); end >= 0 {
			fm := rest[:end]
			body = strings.TrimLeft(rest[end+4:], "\r\n")
			inImpl := false
			for _, line := range strings.Split(fm, "\n") {
				t := strings.TrimSpace(line)
				if inImpl && strings.HasPrefix(t, "- ") {
					impl = append(impl, trimQuotes(t[2:]))
					continue
				}
				inImpl = false
				k, v, ok := strings.Cut(t, ":")
				if !ok {
					continue
				}
				v = trimQuotes(v)
				switch strings.TrimSpace(k) {
				case "id":
					if v != "" {
						id = v
					}
				case "title":
					if v != "" {
						title = v
					}
				case "implements":
					if v == "" {
						inImpl = true
					} else {
						for _, s := range strings.Split(strings.Trim(v, "[]"), ",") {
							if s = trimQuotes(s); s != "" {
								impl = append(impl, s)
							}
						}
					}
				}
			}
		}
	}
	base := strings.TrimSuffix(path[strings.LastIndex(path, "/")+1:], ".md")
	if id == "" {
		id = base
		if up := strings.ToUpper(base); strings.HasPrefix(up, "ADR-") {
			digits := ""
			for _, r := range up[4:] {
				if r < '0' || r > '9' {
					break
				}
				digits += string(r)
			}
			id = "ADR-" + digits
		}
	}
	if title == "" {
		for _, l := range strings.Split(body, "\n") {
			if strings.HasPrefix(l, "# ") || strings.HasPrefix(l, "## ") {
				title = strings.TrimSpace(strings.TrimLeft(l, "#"))
				break
			}
		}
	}
	if title == "" {
		title = base
	}
	return DocParse{id, title, impl}
}
