import type { Address, Hex } from "viem";

/** Mirrors `struct PayIntent` in contracts/src/CustosMessages.sol. */
export interface PayIntent {
  payee: Address;
  /** address(0) for native QOR. */
  token: Address;
  amount: bigint;
  invoiceHash: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface PayeeRule {
  allowed: boolean;
  cap: bigint;
  name?: string;
}

/** The owner's rules as the Keeper sees them (mirrors the vault's on-chain state). */
export interface Mandate {
  perTxCap: bigint;
  dailyCap: bigint;
  paused: boolean;
  /** Keyed by lowercase address. */
  payees: Record<string, PayeeRule>;
}

export interface SpendState {
  spentToday: bigint;
  /** Lowercase invoice hashes already paid or in flight. */
  paidInvoices: Set<string>;
}

/** What the Brain asks the Keeper to do. */
export interface Proposal {
  invoiceId: string;
  invoiceHash: Hex;
  payee: Address;
  amount: bigint;
  vendorName?: string;
  reason?: string;
  /** Fraud signals the Brain found (changed address, urgency, injected instructions...). */
  flags?: string[];
}

export type Decision =
  | { kind: "pay" }
  | { kind: "needs_approval"; reasons: string[] }
  | { kind: "reject"; reasons: string[] };
