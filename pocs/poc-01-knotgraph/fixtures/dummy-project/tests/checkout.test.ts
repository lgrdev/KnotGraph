import { checkout } from "../src/checkout";
import { calculateVAT } from "../src/vat";
import { expect, test } from "vitest";

test("checkout vat", () => expect(checkout({}, "FR").vat).toBe(calculateVAT(0, "FR")));
