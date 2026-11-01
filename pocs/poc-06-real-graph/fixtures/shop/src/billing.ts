import { checkoutCart } from "./cart";

// @ref ADR-007
export function formatMoney(n: number, currency = "EUR"): string {
  return `${n.toFixed(2)} ${currency}`;
}

export function generateInvoice(net: number, country: string, sku: string): string {
  return formatMoney(checkoutCart(net, country, sku));
}

export function sendInvoice(to: string, net: number, country: string, sku: string): string {
  return `${to}: ${generateInvoice(net, country, sku)}`;
}
