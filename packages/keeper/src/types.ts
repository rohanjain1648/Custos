import type { Address, Hex } from "viem";
import type { PayIntent } from "@custos/core";

export interface WindowState {
  found: boolean;
  live: boolean;
  remainingTxs: bigint;
  remainingValue: bigint;
  remainingBlocks: bigint;
  allowedTargets: string[];
  nativeOnly: boolean;
}

export interface VaultStatus {
  paused: boolean;
  perTxCap: bigint;
  dailyCap: bigint;
  remainingToday: bigint;
  balance: bigint;
  totalPaid: bigint;
  paymentCount: bigint;
}

export interface TxOutcome {
  hash: string;
  ok: boolean;
  error?: string;
  gasUsed?: bigint;
}

export type VaultCall =
  | { fn: "pay"; intent: PayIntent; agentSig: Hex }
  | { fn: "payApproved"; intent: PayIntent; agentSig: Hex; ownerSig: Hex }
  | { fn: "pause"; nonce: bigint; expiry: bigint; sig: Hex; byOwner: boolean }
  | OwnerOp;

/** Operations only the owner's ML-DSA-87 key can authorise. Anyone may relay them; the vault checks the signature. */
export type OwnerOp =
  | { fn: "setPayee"; who: Address; allowed: boolean; cap: bigint; nonce: bigint; expiry: bigint; ownerSig: Hex }
  | { fn: "setPolicy"; perTxCap: bigint; dailyCap: bigint; nonce: bigint; expiry: bigint; ownerSig: Hex }
  | { fn: "unpause"; nonce: bigint; expiry: bigint; ownerSig: Hex }
  | { fn: "withdraw"; to: Address; amount: bigint; nonce: bigint; expiry: bigint; ownerSig: Hex };

export function vaultCallArgs(call: VaultCall): { functionName: string; args: readonly unknown[] } {
  switch (call.fn) {
    case "pay":
      return { functionName: "pay", args: [call.intent, call.agentSig] };
    case "payApproved":
      return { functionName: "payApproved", args: [call.intent, call.agentSig, call.ownerSig] };
    case "pause":
      return { functionName: "pause", args: [call.nonce, call.expiry, call.sig, call.byOwner] };
    case "setPayee":
      return { functionName: "setPayee", args: [call.who, call.allowed, call.cap, call.nonce, call.expiry, call.ownerSig] };
    case "setPolicy":
      return { functionName: "setPolicy", args: [call.perTxCap, call.dailyCap, call.nonce, call.expiry, call.ownerSig] };
    case "unpause":
      return { functionName: "unpause", args: [call.nonce, call.expiry, call.ownerSig] };
    case "withdraw":
      return { functionName: "withdraw", args: [call.to, call.amount, call.nonce, call.expiry, call.ownerSig] };
  }
}

/**
 * Everything the Keeper and the Sentinel need from QoreChain. The real implementation (chain-real.ts) uses the
 * QoreChain SDK and viem; tests use an in-memory fake.
 */
export interface ChainAdapter {
  readonly agentEvm: Address;
  readonly agentCosmos: string;
  readonly vault: Address | null;
  readonly token: Address;

  readVaultStatus(): Promise<VaultStatus>;
  readPayee(who: Address): Promise<{ allowed: boolean; cap: bigint }>;
  isInvoicePaid(invoiceHash: Hex): Promise<boolean>;

  getWindow(): Promise<WindowState>;
  /** Hybrid-signed MsgOpenEVMWindow: 1 tx, fee-only value, the vault as the only target. */
  openPayWindow(): Promise<TxOutcome>;
  closeWindow(): Promise<TxOutcome>;
  waitForLiveWindow(timeoutMs?: number): Promise<WindowState>;
  getEvmNonce(): Promise<number>;

  sendVaultCall(call: VaultCall): Promise<TxOutcome>;
  simulateVaultCall(call: VaultCall): Promise<{ ok: boolean; error?: string }>;
  /** Linked-key top-up of the vault from the treasury (MsgExecuteEVM, relayed by the agent account). */
  topUp(amount: bigint): Promise<TxOutcome>;
  /** eth_call to the pqcVerify precompile; null when the network cannot be reached. */
  verifyPqLive(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean | null>;
}

export interface AgentSigner {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}
