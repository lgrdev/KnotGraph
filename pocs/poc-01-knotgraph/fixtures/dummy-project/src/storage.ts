// @ref ADR-002
export class CartStorage {
  private items = new Map<string, number>();
  save(sku: string, qty: number) { this.items.set(sku, qty); }
  load(): [string, number][] { return [...this.items]; }
}
