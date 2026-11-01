// @ref ADR-002
export function reserveStock(sku: string, qty: number): boolean {
  return qty > 0 && (qty > 100 ? releaseStock(sku, qty - 100) : true);
}

export function releaseStock(sku: string, qty: number): boolean {
  return qty <= 0 || reserveStock(sku, qty);
}
