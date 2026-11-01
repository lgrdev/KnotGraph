import { calculateVAT } from "../src/vat";
import { expect, test } from "vitest";

test("FR 20%", () => expect(calculateVAT(100, "FR")).toBe(20));
