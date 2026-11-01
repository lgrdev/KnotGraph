import { describe, expect, test } from "vitest";
import { submitOrder } from "../src/orders";

describe("Order submission", () => {
  test("returns an invoice", () => expect(submitOrder(100, "FR", "sku")).toContain("EUR"));
});
