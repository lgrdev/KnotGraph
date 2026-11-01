import { getRate } from "./rates";

// @ref ADR-001
export function calculateVAT(amount: number, country: string): number {
  return round(amount * getRate(country));
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
