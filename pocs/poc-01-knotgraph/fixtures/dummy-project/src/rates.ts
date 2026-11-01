export const VAT_RATES: Record<string, number> = { FR: 0.2, DE: 0.19, ES: 0.21 };

export function getRate(country: string): number {
  return VAT_RATES[country] ?? 0.2;
}
