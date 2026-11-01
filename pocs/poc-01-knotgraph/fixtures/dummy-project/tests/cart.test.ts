import { addItem, cartTotal } from "../src/cart";
import { calculateVAT } from "../src/vat";
import { expect, test } from "vitest";

test("total includes VAT", () => {
  addItem("a", 1);
  expect(cartTotal({ a: 100 }, "FR")).toBe(100 + calculateVAT(100, "FR"));
});
