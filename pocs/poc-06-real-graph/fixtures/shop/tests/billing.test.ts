import { describe, expect, test } from "vitest";
import { generateInvoice } from "../src/billing";

describe("Invoice generation", () => {
  test("format", () => expect(generateInvoice(100, "FR", "sku")).toContain("EUR"));
});
