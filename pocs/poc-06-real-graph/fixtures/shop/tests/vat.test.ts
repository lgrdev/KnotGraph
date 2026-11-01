import { describe, expect, test } from "vitest";
import { applyRounding, calculateVAT } from "../src/tax/vat";

describe("VAT Calculation Cases", () => {
  test("FR 20%", () => expect(calculateVAT(100, "FR")).toBe(20));
  test("rounding", () => expect(applyRounding(1.005)).toBe(1));
});
