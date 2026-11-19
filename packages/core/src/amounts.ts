/**
 * Exact decimal <-> base-unit conversion. Money never goes through floating point.
 * Accepted: "1250.50", "1,250.50", "1250". Rejected (thrown): "1.250,50", "12,50", "1e3", more decimals
 * than the token has. An ambiguous amount must stop the payment, never be guessed.
 */
const PLAIN = /^\d+(\.\d+)?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

export function toBaseUnits(text: string, decimals: number): bigint {
  const raw = text.trim();
  if (!PLAIN.test(raw) && !GROUPED.test(raw)) {
    throw new Error(`"${text}" is not an unambiguous decimal amount`);
  }
  const cleaned = raw.replace(/,/g, "");
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > decimals) {
    throw new Error(`"${text}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(value: bigint, decimals: number, maxFraction = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeText}${frac ? "." + frac : ""}`;
}
