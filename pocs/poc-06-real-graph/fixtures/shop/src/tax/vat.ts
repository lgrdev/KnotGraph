import { getRate } from "./rates";

// @ref ADR-004
// @ticket ENG-102
export function calculateVAT(amount: number, country: string): number {
  return applyRounding(amount * getRate(country));
}

export function applyRounding(n: number): number {
  return Math.round(n * 100) / 100;
}
