export function getRate(country: string): number {
  return country === "DE" ? 0.19 : 0.2;
}
