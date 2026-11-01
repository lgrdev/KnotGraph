import { getRate } from "./rates";

// @ref ADR-001
export function calculateVAT(amount: number, country: string): number {
  return amount * getRate(country);
}
