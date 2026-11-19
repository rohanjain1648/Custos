import { describe, expect, it } from "vitest";
import { formatUnits, toBaseUnits } from "../src/amounts";
import { invoiceHash } from "../src/invoice-hash";

describe("toBaseUnits", () => {
  it("converts exact decimals with thousands separators", () => {
    expect(toBaseUnits("1,250.50", 6)).toBe(1_250_500_000n);
    expect(toBaseUnits("1250", 6)).toBe(1_250_000_000n);
    expect(toBaseUnits(" 0.000001 ", 6)).toBe(1n);
    expect(toBaseUnits("12,345,678.9", 6)).toBe(12_345_678_900_000n);
  });

  it("refuses more decimals than the token has instead of rounding", () => {
    expect(() => toBaseUnits("1.2345678", 6)).toThrow(/more than 6 decimal places/);
  });

  it("refuses ambiguous or non-decimal formats", () => {
    for (const bad of ["1.250,50", "12,50", "1e3", "-5", "", "1,25.00", "abc", "1.2.3"]) {
      expect(() => toBaseUnits(bad, 6), bad).toThrow();
    }
  });
});

describe("formatUnits", () => {
  it("formats with separators and trims zeros", () => {
    expect(formatUnits(1_250_500_000n, 6)).toBe("1,250.5");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(0n, 6)).toBe("0");
  });
});

describe("invoiceHash", () => {
  it("is stable across case and whitespace of the invoice number", () => {
    const payee = "0x8ba1f109551bD432803012645Ac136ddd64DBA72" as const;
    expect(invoiceHash(" inv-7 ", payee, 5n)).toBe(invoiceHash("INV-7", payee, 5n));
    expect(invoiceHash("INV-7", payee, 5n)).not.toBe(invoiceHash("INV-7", payee, 6n));
  });
});
