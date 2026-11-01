import type { Database } from "bun:sqlite";
import { addEdge, addNode, type Confidence } from "./schema";

const fn = (path: string, name: string) => `fn:${path}#${name}`;

interface Sym { file: string; name: string; calls?: string[] }

/** Hand-made 3-tier graph (code / tests / intent). Mirrors spec §2.3 for calculateVAT. */
export function seedSample(db: Database): void {
  db.run("BEGIN");
  const syms: Sym[] = [
    { file: "src/tax/vat.ts", name: "calculateVAT", calls: ["getRate", "applyRounding"] },
    { file: "src/tax/vat.ts", name: "applyRounding" },
    { file: "src/tax/rates.ts", name: "getRate", calls: ["loadRateTable"] },
    { file: "src/tax/rates.ts", name: "loadRateTable" },
    { file: "src/services/cart.ts", name: "checkoutCart", calls: ["calculateVAT", "applyDiscount", "reserveStock"] },
    { file: "src/services/cart.ts", name: "applyDiscount" },
    { file: "src/services/billing.ts", name: "generateInvoice", calls: ["checkoutCart", "formatMoney"] },
    { file: "src/services/billing.ts", name: "sendInvoice", calls: ["generateInvoice"] },
    { file: "src/services/inventory.ts", name: "reserveStock", calls: ["releaseStock"] }, // cycle
    { file: "src/services/inventory.ts", name: "releaseStock", calls: ["reserveStock"] },
    { file: "src/api/orders.ts", name: "submitOrder", calls: ["checkoutCart", "generateInvoice"] }, // diamond
    { file: "src/api/orders.ts", name: "handleWebhook", calls: ["submitOrder"] },
    { file: "src/api/orders.ts", name: "retryOrder", calls: ["handleWebhook"] },
    { file: "src/utils/format.ts", name: "formatMoney" },
  ];
  const files = [...new Set(syms.map((s) => s.file))];
  for (const f of files) addNode(db, { id: `file:${f}`, type: "file", name: f.split("/").pop()!, path: f, title: null, status: null });
  for (const s of syms) {
    addNode(db, { id: fn(s.file, s.name), type: "function", name: s.name, path: s.file, title: null, status: null });
    addEdge(db, `file:${s.file}`, fn(s.file, s.name), "CONTAINS");
  }
  const idOf = (name: string) => fn(syms.find((s) => s.name === name)!.file, name);
  for (const s of syms) for (const c of s.calls ?? []) addEdge(db, idOf(s.name), idOf(c), "CALLS");
  // dynamic dispatch the AST cannot prove: probabilistic link
  addEdge(db, idOf("handleWebhook"), idOf("generateInvoice"), "CALLS", "inferred", 0.5);

  const tests: [string, string, string[]][] = [
    ["tests/vat.test.ts", "VAT Calculation Cases", ["calculateVAT", "applyRounding"]],
    ["tests/cart.test.ts", "Cart checkout", ["checkoutCart", "applyDiscount"]],
    ["tests/billing.test.ts", "Invoice generation", ["generateInvoice"]],
    ["tests/orders.test.ts", "Order submission", ["submitOrder"]],
    ["tests/inventory.test.ts", "Stock reservation", ["reserveStock", "releaseStock"]],
    ["tests/rates.test.ts", "Rate table", ["loadRateTable"]],
  ];
  for (const [path, suite, covered] of tests) {
    addNode(db, { id: `test:${path}`, type: "test", name: path.split("/").pop()!, path, title: suite, status: null });
    for (const c of covered) addEdge(db, `test:${path}`, idOf(c), "TESTS");
  }

  const adrs: [string, string, string, string, [string, Confidence?, number?][]][] = [
    ["ADR-004", "EU 2026 VAT Compliance", "docs/adr/004-vat.md", "accepted", [["calculateVAT"], ["getRate"], ["applyDiscount", "inferred", 0.55]]],
    ["ADR-007", "Invoicing rules", "docs/adr/007-invoicing.md", "accepted", [["generateInvoice"], ["formatMoney", "inferred", 0.6]]],
    ["ADR-009", "Order flow", "docs/adr/009-order-flow.md", "draft", [["submitOrder"]]],
    ["ADR-002", "Stock reservation", "docs/adr/002-stock.md", "accepted", [["reserveStock"]]],
  ];
  for (const [id, title, path, status, impl] of adrs) {
    addNode(db, { id: `adr:${id}`, type: "adr", name: id, path, title, status });
    for (const [sym, conf, score] of impl) addEdge(db, idOf(sym), `adr:${id}`, "IMPLEMENTS", conf ?? "strict", score ?? 1);
  }

  const rules: [string, string, string][] = [
    ["RULE-VAT-01", "ADR-004", "VAT is computed from destination country"],
    ["RULE-VAT-02", "ADR-004", "Rates apply from 2026-01-01"],
    ["RULE-INV-01", "ADR-007", "Invoice totals rounded to 2 decimals"],
    ["RULE-ORD-01", "ADR-009", "An order is idempotent per client key"],
    ["RULE-STK-01", "ADR-002", "Stock never goes negative"],
  ];
  for (const [id, adr, title] of rules) {
    addNode(db, { id: `rule:${id}`, type: "rule", name: id, path: adrs.find((a) => a[0] === adr)![2], title, status: null });
    addEdge(db, `adr:${adr}`, `rule:${id}`, "CONSTRAINS");
  }

  const tickets: [string, string, string, string][] = [
    ["TKT-101", "Implement EU 2026 VAT rule", "open", "calculateVAT"],
    ["TKT-102", "Invoice rounding bug", "done", "generateInvoice"],
    ["TKT-103", "Webhook retries", "open", "handleWebhook"],
  ];
  for (const [id, title, status, sym] of tickets) {
    addNode(db, { id: `ticket:${id}`, type: "ticket", name: id, path: `tickets/${id}`, title, status });
    addEdge(db, `ticket:${id}`, idOf(sym), "TRACKS");
  }
  addNode(db, { id: "ticket:TKT-104", type: "ticket", name: "TKT-104", path: "tickets/TKT-104", title: "Define order idempotency", status: "open" });
  addEdge(db, "ticket:TKT-104", "adr:ADR-009", "TRACKS");
  db.run("COMMIT");
}

/** Deterministic pseudo-random large graph for the perf KPI (~n symbols, ~3 calls each, 60% tested). */
export function seedLarge(db: Database, n = 10_000): void {
  let s = 12345;
  const rnd = (max: number) => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s % max);
  db.run("BEGIN");
  const id = (i: number) => `fn:src/m${Math.floor(i / 20)}.ts#f${i}`;
  for (let i = 0; i < n; i++) addNode(db, { id: id(i), type: "function", name: `f${i}`, path: `src/m${Math.floor(i / 20)}.ts`, title: null, status: null });
  for (let i = 1; i < n; i++) for (let k = 0; k < 3; k++) {
    const t = rnd(i); // calls lower index only -> DAG plus cycles added below
    addEdge(db, id(i), id(t), "CALLS", rnd(20) === 0 ? "inferred" : "strict", 0.5);
  }
  for (let i = 0; i < n; i += 50) addEdge(db, id(i), id(Math.min(n - 1, i + 7)), "CALLS"); // back edges => cycles
  const adrs = Math.max(10, n / 100), rules = n / 50, tickets = n / 100;
  for (let a = 0; a < adrs; a++) addNode(db, { id: `adr:A${a}`, type: "adr", name: `A${a}`, path: `docs/adr/${a}.md`, title: `ADR ${a}`, status: a % 10 === 0 ? "draft" : "accepted" });
  for (let r = 0; r < rules; r++) { addNode(db, { id: `rule:R${r}`, type: "rule", name: `R${r}`, path: "docs", title: `Rule ${r}`, status: null }); addEdge(db, `adr:A${rnd(adrs)}`, `rule:R${r}`, "CONSTRAINS"); }
  for (let t = 0; t < tickets; t++) { addNode(db, { id: `ticket:T${t}`, type: "ticket", name: `T${t}`, path: "tickets", title: `Ticket ${t}`, status: "open" }); addEdge(db, `ticket:T${t}`, id(rnd(n)), "TRACKS"); }
  for (let i = 0; i < n; i++) {
    if (i % 5 < 3) { // 60% tested
      if (i % 20 === 0) addNode(db, { id: `test:t${i}`, type: "test", name: `t${i}.test.ts`, path: `tests/t${i}.test.ts`, title: `Suite ${i}`, status: null });
      addEdge(db, `test:t${i - (i % 20)}`, id(i), "TESTS");
    }
    if (i % 4 === 0) addEdge(db, id(i), `adr:A${rnd(adrs)}`, "IMPLEMENTS", rnd(10) === 0 ? "inferred" : "strict", 0.6);
  }
  db.run("COMMIT");
}
