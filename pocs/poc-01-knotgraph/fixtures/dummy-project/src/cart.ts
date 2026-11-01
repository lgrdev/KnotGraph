import { calculateVAT } from "./vat";
import { CartStorage } from "./storage";

const storage = new CartStorage();

export function addItem(sku: string, qty: number): void {
  storage.save(sku, qty);
}

export function cartTotal(prices: Record<string, number>, country: string): number {
  const net = storage.load().reduce((s, [sku, q]) => s + (prices[sku] ?? 0) * q, 0);
  return net + calculateVAT(net, country);
}
