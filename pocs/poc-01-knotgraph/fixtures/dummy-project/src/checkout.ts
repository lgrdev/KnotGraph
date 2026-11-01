import { cartTotal } from "./cart";
import { calculateVAT } from "./vat";

export function checkout(prices: Record<string, number>, country: string) {
  const total = cartTotal(prices, country);
  return { total, vat: calculateVAT(total, country) };
}
