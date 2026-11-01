import { formatMoney } from "./legacy/format";

export function renderPrice(n: number): string {
  return formatMoney(n);
}
