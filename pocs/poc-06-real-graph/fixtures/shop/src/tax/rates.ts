const TABLE: Record<string, number> = { FR: 0.2, DE: 0.19, ES: 0.21 };

export function loadRateTable(): Record<string, number> {
  return TABLE;
}

export function getRate(country: string): number {
  return loadRateTable()[country] ?? 0.2;
}
