import { calculateVAT } from "./tax/vat";
import { reserveStock } from "./inventory";

export function applyDiscount(net: number, code?: string): number {
  return code === "VIP" ? net * 0.9 : net;
}

export function checkoutCart(net: number, country: string, sku: string, code?: string): number {
  reserveStock(sku, 1);
  const discounted = applyDiscount(net, code);
  return discounted + calculateVAT(discounted, country);
}
