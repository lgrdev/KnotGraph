import { describe, expect, test } from "vitest";
import { releaseStock, reserveStock } from "../src/inventory";

describe("Stock reservation", () => {
  test("reserve", () => expect(reserveStock("sku", 1)).toBe(true));
  test("release", () => expect(releaseStock("sku", 0)).toBe(true));
});
