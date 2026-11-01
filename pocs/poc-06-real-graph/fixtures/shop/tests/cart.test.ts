import { describe, expect, test } from "vitest";
import { applyDiscount, checkoutCart } from "../src/cart";

describe("Cart checkout", () => {
  test("VIP discount", () => expect(applyDiscount(100, "VIP")).toBe(90));
  test("total", () => expect(checkoutCart(100, "FR", "sku")).toBe(120));
});
