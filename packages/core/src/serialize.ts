import type { Address, Hex } from "viem";
import type { PayIntent, Proposal } from "./types";

/** JSON-safe forms (bigint as decimal string) for HTTP and the state file. */
export interface SerializedIntent {
  payee: Address;
  token: Address;
  amount: string;
  invoiceHash: Hex;
  nonce: string;
  expiry: string;
}

export interface SerializedProposal {
  invoiceId: string;
  invoiceHash: Hex;
  payee: Address;
  amount: string;
  vendorName?: string;
  reason?: string;
  flags?: string[];
}

export function serializeIntent(i: PayIntent): SerializedIntent {
  return { ...i, amount: i.amount.toString(), nonce: i.nonce.toString(), expiry: i.expiry.toString() };
}

export function deserializeIntent(s: SerializedIntent): PayIntent {
  return { ...s, amount: BigInt(s.amount), nonce: BigInt(s.nonce), expiry: BigInt(s.expiry) };
}

export function serializeProposal(p: Proposal): SerializedProposal {
  return { ...p, amount: p.amount.toString() };
}

export function deserializeProposal(s: SerializedProposal): Proposal {
  if (!/^\d+$/.test(s.amount)) throw new Error(`amount must be a base-unit integer string, got "${s.amount}"`);
  return { ...s, amount: BigInt(s.amount) };
}

/** JSON.stringify that writes bigints as strings. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space);
}
