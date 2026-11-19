import { getAddress, isAddress, type Address } from "viem";
import type { VendorEntry } from "@custos/core";

export interface ExtractedFields {
  vendorName: string | null;
  invoiceNumber: string | null;
  amountText: string | null;
  currency: string | null;
  payTo: Address | null;
  dueDate: string | null;
}

const clean = (s: string | undefined) => s?.replace(/\*+/g, "").trim() || null;

/** Deterministic field extraction for Markdown and plain-text invoices (the offline path and a cross-check). */
export function extractFields(text: string): ExtractedFields {
  const visible = text.replace(/<!--[\s\S]*?-->/g, "");
  const vendor = visible.match(/^\s*\**From:?\**:?\s*(.+)$/im)?.[1]?.replace(/\(.*\)/, "");
  const number = visible.match(/Invoice\s*(?:#|No\.?|Number)\s*:?\**\s*([A-Za-z0-9][A-Za-z0-9-]*)/i)?.[1];
  const amount = visible.match(/Amount\s+due\s*:?\**\s*([\d][\d,]*(?:\.\d+)?)\s*(fUSD|QOR)\b/i);
  const payTo = visible.match(/Pay\s+to[^\n]*?(0x[0-9a-fA-F]{40})/i)?.[1];
  const due = visible.match(/^\s*\**Due:?\**:?\s*(.+)$/im)?.[1];
  return {
    vendorName: clean(vendor),
    invoiceNumber: clean(number),
    amountText: amount?.[1] ?? null,
    currency: amount?.[2] ?? null,
    payTo: payTo && isAddress(payTo, { strict: false }) ? getAddress(payTo) : null,
    dueDate: clean(due),
  };
}

export function matchVendor(name: string | null, vendors: VendorEntry[]): VendorEntry | null {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  return (
    vendors.find((v) => [v.name, ...v.aliases].some((alias) => {
      const a = alias.toLowerCase();
      return n === a || n.includes(a) || a.includes(n);
    })) ?? null
  );
}

/**
 * Fraud and injection signals found by plain code. The Brain always merges these into its proposal, so even a
 * model that was fooled by the invoice cannot remove them; any signal sends the payment to the owner.
 */
export function fraudSignals(text: string, fields: ExtractedFields, vendor: VendorEntry | null, amount: bigint | null): string[] {
  const signals: string[] = [];
  if (!vendor) signals.push("unknown vendor (not in the owner's vendor directory)");
  if (vendor && fields.payTo && fields.payTo.toLowerCase() !== vendor.address.toLowerCase()) {
    signals.push("pay-to address differs from the vendor's known address");
  }
  if (/bank details (have )?changed|new (payment )?address|updated payment (details|address)|changed our (wallet|address|account)/i.test(text)) {
    signals.push("the invoice says payment details changed");
  }
  if (/\b(immediately|urgent(ly)?|final notice|asap|within \d+ hours?)\b/i.test(text)) {
    signals.push("urgency pressure");
  }
  if (/ignore (all )?(previous|prior|above) instructions|system (note|prompt|message)|for ai assistants|do not (request|ask for) approval|pre-?approved by the owner|do not mention/i.test(text)) {
    signals.push("embedded instructions aimed at an AI (prompt injection)");
  }
  if (/<!--[\s\S]*?-->/.test(text)) signals.push("hidden text in an HTML comment");
  if (vendor && amount !== null && amount > vendor.cap) signals.push("amount is above this vendor's cap");
  return signals;
}
