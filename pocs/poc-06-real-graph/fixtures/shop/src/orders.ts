import { checkoutCart } from "./cart";
import { generateInvoice } from "./billing";

// @ref ADR-009
export function submitOrder(net: number, country: string, sku: string): string {
  checkoutCart(net, country, sku);
  return generateInvoice(net, country, sku);
}

export function handleWebhook(payload: { net: number; country: string; sku: string }): string {
  return submitOrder(payload.net, payload.country, payload.sku);
}

export function retryOrder(payload: { net: number; country: string; sku: string }): string {
  return handleWebhook(payload);
}
