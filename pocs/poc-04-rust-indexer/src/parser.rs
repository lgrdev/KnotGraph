use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, PartialEq)]
pub struct Symbol {
    pub name: String,
    pub is_class: bool,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Default)]
pub struct CodeParse {
    pub symbols: Vec<Symbol>,
    pub imports: Vec<String>,
    /// (enclosing function name, callee)
    pub calls: Vec<(Option<String>, String)>,
    /// (adr id, line, resolved symbol)
    pub refs: Vec<(String, u32, Option<String>)>,
    pub is_test: bool,
}

pub fn is_test_file(p: &str) -> bool {
    let f = p.rsplit('/').next().unwrap_or(p);
    f.contains(".test.") || f.contains(".spec.")
}

pub fn is_code_file(p: &str) -> bool {
    const EXT: [&str; 8] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
    EXT.iter().any(|e| p.ends_with(e)) && !p.ends_with(".d.ts")
}

pub fn new_parser() -> Parser {
    let mut p = Parser::new();
    // The TypeScript grammar also parses plain JS; good enough for the PoC (no JSX-specific nodes needed).
    p.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).expect("load grammar");
    p
}

fn text<'a>(n: Node, src: &'a [u8]) -> &'a str {
    n.utf8_text(src).unwrap_or("")
}

fn ref_ids(comment: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = comment;
    while let Some(i) = rest.find("@ref") {
        let after = rest[i + 4..].trim_start();
        let id: String = after.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
        if id.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            out.push(id);
        }
        rest = &rest[i + 4..];
    }
    out
}

pub fn parse_code(parser: &mut Parser, path: &str, source: &str) -> CodeParse {
    let mut out = CodeParse { is_test: is_test_file(path), ..Default::default() };
    let Some(tree) = parser.parse(source, None) else { return out };
    let src = source.as_bytes();
    walk(tree.root_node(), src, None, &mut out);
    // Attach @ref to the enclosing symbol, else the symbol starting within 3 lines after the comment.
    let syms = out.symbols.clone();
    for r in out.refs.iter_mut() {
        let line = r.1;
        let enclosing = syms.iter().filter(|s| s.start <= line && line <= s.end).max_by_key(|s| s.start);
        let following = syms.iter().filter(|s| s.start > line && s.start - line <= 3).min_by_key(|s| s.start);
        r.2 = enclosing.or(following).map(|s| s.name.clone());
    }
    out
}

fn walk(n: Node, src: &[u8], caller: Option<&str>, out: &mut CodeParse) {
    let mut next: Option<String> = caller.map(String::from);
    let row = |n: Node| n.start_position().row as u32 + 1;
    match n.kind() {
        "function_declaration" | "generator_function_declaration" | "class_declaration" | "abstract_class_declaration" => {
            if let Some(name) = n.child_by_field_name("name") {
                let is_class = n.kind().contains("class");
                out.symbols.push(Symbol { name: text(name, src).into(), is_class, start: row(n), end: n.end_position().row as u32 + 1 });
                if !is_class {
                    next = Some(text(name, src).into());
                }
            }
        }
        "method_definition" => {
            if let Some(name) = n.child_by_field_name("name") {
                let nm = text(name, src);
                if nm != "constructor" {
                    out.symbols.push(Symbol { name: nm.into(), is_class: false, start: row(n), end: n.end_position().row as u32 + 1 });
                    next = Some(nm.into());
                }
            }
        }
        "variable_declarator" => {
            let (v, name) = (n.child_by_field_name("value"), n.child_by_field_name("name"));
            if let (Some(v), Some(name)) = (v, name) {
                if name.kind() == "identifier" && matches!(v.kind(), "arrow_function" | "function_expression" | "function") {
                    out.symbols.push(Symbol { name: text(name, src).into(), is_class: false, start: row(n), end: n.end_position().row as u32 + 1 });
                    next = Some(text(name, src).into());
                }
            }
        }
        "import_specifier" | "namespace_import" => {
            let id = n
                .child_by_field_name("alias")
                .or_else(|| n.child_by_field_name("name"))
                .or_else(|| (0..n.named_child_count() as u32).filter_map(|i| n.named_child(i)).find(|c| c.kind() == "identifier"));
            if let Some(id) = id {
                out.imports.push(text(id, src).into());
            }
        }
        "import_clause" => {
            if let Some(d) = (0..n.named_child_count() as u32).filter_map(|i| n.named_child(i)).find(|c| c.kind() == "identifier") {
                out.imports.push(text(d, src).into());
            }
        }
        "call_expression" => {
            if let Some(f) = n.child_by_field_name("function") {
                let callee = if f.kind() == "member_expression" {
                    f.child_by_field_name("property").map(|p| text(p, src)).unwrap_or("")
                } else {
                    text(f, src)
                };
                if !callee.is_empty() && callee.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$') {
                    out.calls.push((caller.map(String::from), callee.into()));
                }
            }
        }
        "comment" => {
            for id in ref_ids(text(n, src)) {
                out.refs.push((id, row(n), None));
            }
        }
        _ => {}
    }
    for i in 0..n.child_count() {
        if let Some(c) = n.child(i as u32) {
            walk(c, src, next.as_deref(), out);
        }
    }
}

// ---------- Markdown ADR (frontmatter only; no YAML crate) ----------

#[derive(Debug, Default)]
pub struct DocParse {
    pub id: String,
    pub title: String,
    pub implements: Vec<String>,
}

pub fn parse_doc(path: &str, source: &str) -> DocParse {
    let (mut id, mut title, mut implements) = (None::<String>, None::<String>, vec![]);
    let mut body = source;
    if let Some(rest) = source.strip_prefix("---\n").or_else(|| source.strip_prefix("---\r\n")) {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            body = rest[end + 4..].trim_start_matches(['\r', '\n']);
            let mut in_impl = false;
            for line in fm.lines() {
                let t = line.trim();
                if in_impl && t.starts_with("- ") {
                    implements.push(t[2..].trim().trim_matches(['"', '\'']).to_string());
                    continue;
                }
                in_impl = false;
                if let Some((k, v)) = t.split_once(':') {
                    let v = v.trim().trim_matches(['"', '\'']);
                    match k.trim() {
                        "id" if !v.is_empty() => id = Some(v.into()),
                        "title" if !v.is_empty() => title = Some(v.into()),
                        "implements" if v.is_empty() => in_impl = true,
                        "implements" => implements.extend(
                            v.trim_matches(['[', ']']).split(',').map(|s| s.trim().trim_matches(['"', '\'']).to_string()).filter(|s| !s.is_empty()),
                        ),
                        _ => {}
                    }
                }
            }
        }
    }
    let base = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md");
    let id = id.unwrap_or_else(|| {
        let up = base.to_uppercase();
        match up.strip_prefix("ADR-") {
            Some(r) => format!("ADR-{}", r.chars().take_while(|c| c.is_ascii_digit()).collect::<String>()),
            None => base.to_string(),
        }
    });
    let heading = body.lines().find(|l| l.starts_with("# ") || l.starts_with("## ")).map(|l| l.trim_start_matches('#').trim().to_string());
    DocParse { id, title: title.or(heading).unwrap_or_else(|| base.to_string()), implements }
}
