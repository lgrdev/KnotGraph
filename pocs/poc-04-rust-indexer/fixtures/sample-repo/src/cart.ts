import { calculateVAT } from "./vat";

export function cartTotal(net: number, country: string): number {
  return net + calculateVAT(net, country);
}
