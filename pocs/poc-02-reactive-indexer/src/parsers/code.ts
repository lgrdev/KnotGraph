import { createRequire } from "node:module";
import { Parser, Language, type Node } from "web-tree-sitter";

export interface Symbol {
  name: string;
  kind: "function" | "class";
  startLine: number;
  endLine: number;
}
export interface CodeParse {
  symbols: Symbol[];
  imports: string[]; // imported local names
  calls: { caller: string | null; callee: string }[];
  refs: { adr: string; line: number; symbol: string | null }[];
  isTest: boolean;
}

const require = createRequire(import.meta.url);
const REF_RE = /@ref\s+([A-Za-z][\w-]*)/g;
const langs = new Map<string, Language>();
let ready: Promise<void> | null = null;

async function loadLang(file: "typescript" | "tsx" | "javascript"): Promise<Language> {
  ready ??= Parser.init();
  await ready;
  let l = langs.get(file);
  if (!l) {
    l = await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${file}.wasm`));
    langs.set(file, l);
  }
  return l;
}

export const isTestFile = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
export const isCodeFile = (p: string) => /\.[cm]?[jt]sx?$/.test(p) && !p.endsWith(".d.ts");

export async function parseCode(path: string, source: string): Promise<CodeParse> {
  const kind = path.endsWith("x") && !path.endsWith(".jsx") ? "tsx" : /\.[cm]?js/.test(path) ? "javascript" : "typescript";
  const lang = await loadLang(kind === "tsx" || path.endsWith(".jsx") ? "tsx" : kind);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source)!;
  const out: CodeParse = { symbols: [], imports: [], calls: [], refs: [], isTest: isTestFile(path) };
  const scopes: { sym: Symbol; node: Node }[] = [];

  const addSym = (name: string, kind: Symbol["kind"], n: Node) => {
    const sym = { name, kind, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
    out.symbols.push(sym);
    scopes.push({ sym, node: n });
  };

  const walk = (n: Node, caller: string | null) => {
    let next = caller;
    switch (n.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = n.childForFieldName("name")?.text;
        if (name) {
          addSym(name, n.type.includes("class") ? "class" : "function", n);
          if (n.type.includes("function")) next = name;
        }
        break;
      }
      case "method_definition": {
        const name = n.childForFieldName("name")?.text;
        if (name && name !== "constructor") {
          addSym(name, "function", n);
          next = name;
        }
        break;
      }
      case "variable_declarator": {
        const v = n.childForFieldName("value");
        const name = n.childForFieldName("name");
        if (v && name?.type === "identifier" && (v.type === "arrow_function" || v.type === "function_expression" || v.type === "function")) {
          addSym(name.text, "function", n);
          next = name.text;
        }
        break;
      }
      case "import_specifier":
      case "namespace_import": {
        const id = n.childForFieldName("alias") ?? n.childForFieldName("name") ?? n.namedChildren.find((c) => c?.type === "identifier");
        if (id) out.imports.push(id.text);
        break;
      }
      case "import_clause": {
        const d = n.namedChildren.find((c) => c?.type === "identifier");
        if (d) out.imports.push(d.text);
        break;
      }
      case "call_expression": {
        const f = n.childForFieldName("function");
        const callee = f?.type === "member_expression" ? f.childForFieldName("property")?.text : f?.text;
        if (callee && /^[\w$]+$/.test(callee)) out.calls.push({ caller, callee });
        break;
      }
      case "comment": {
        for (const m of n.text.matchAll(REF_RE)) out.refs.push({ adr: m[1]!, line: n.startPosition.row + 1, symbol: null });
        break;
      }
    }
    for (const c of n.children) if (c) walk(c, next);
  };
  walk(tree.rootNode, null);
  tree.delete();
  parser.delete();

  // Attach @ref to enclosing symbol, else the symbol starting right after the comment (tolerating decorators/blank lines).
  for (const r of out.refs) {
    const enclosing = out.symbols.filter((s) => s.startLine <= r.line && r.line <= s.endLine).sort((a, b) => b.startLine - a.startLine)[0];
    const following = out.symbols.filter((s) => s.startLine > r.line && s.startLine - r.line <= 3).sort((a, b) => a.startLine - b.startLine)[0];
    r.symbol = (enclosing ?? following)?.name ?? null;
  }
  return out;
}
