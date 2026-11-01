// "@shop/billing" is a tsconfig path alias: no relative path, so the import cannot disambiguate.
import { formatMoney } from "@shop/billing";

export function monthlyReport(total: number): string {
  return `Total: ${formatMoney(total)}`;
}
