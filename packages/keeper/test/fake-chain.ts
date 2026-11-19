import { hexToBytes, type Address, type Hex } from "viem";
import { payMessage, verifyPq, type MessageContext } from "@custos/core";
import type { ChainAdapter, TxOutcome, VaultCall, VaultStatus, WindowState } from "../src/types";

/**
 * In-memory QoreChain for tests: a window that admits a set number of transactions to listed targets, a vault
 * that enforces its mandate, real ML-DSA-87 verification of the agent's signature, and a nonce that moves on
 * every transaction like the real account sequence does.
 */
export class FakeChain implements ChainAdapter {
  readonly agentEvm: Address = "0x00000000000000000000000000000000000a6e47";
  readonly agentCosmos = "qor1fakeagent";
  readonly token: Address = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
  calls: string[] = [];
  nonce = 0;
  window: WindowState = { found: false, live: false, remainingTxs: 0n, remainingValue: 0n, remainingBlocks: 0n, allowedTargets: [], nativeOnly: false };
  vaultState: VaultStatus = {
    paused: false,
    perTxCap: 500_000_000n,
    dailyCap: 1_000_000_000n,
    remainingToday: 1_000_000_000n,
    balance: 5_000_000_000n,
    totalPaid: 0n,
    paymentCount: 0n,
  };
  payees = new Map<string, { allowed: boolean; cap: bigint }>();
  paid = new Set<string>();
  pqResult: boolean | null = true;
  failNextVaultCall = false;

  constructor(
    readonly vault: Address | null,
    private readonly agentPublicKey?: Uint8Array,
    private readonly ctx?: MessageContext,
  ) {}

  private tx(name: string): string {
    this.calls.push(name);
    this.nonce += 1;
    return `0x${name.replace(/[^a-z]/gi, "").padEnd(8, "0").slice(0, 8)}${this.nonce.toString(16).padStart(56, "0")}`;
  }

  async readVaultStatus(): Promise<VaultStatus> {
    return { ...this.vaultState };
  }
  async readPayee(who: Address) {
    return this.payees.get(who.toLowerCase()) ?? { allowed: false, cap: 0n };
  }
  async isInvoicePaid(h: Hex) {
    return this.paid.has(h.toLowerCase());
  }
  async getWindow() {
    return { ...this.window };
  }
  async openPayWindow(): Promise<TxOutcome> {
    const hash = this.tx("openWindow");
    this.window = { found: true, live: true, remainingTxs: 1n, remainingValue: 100_000n, remainingBlocks: 50n, allowedTargets: [this.vault!], nativeOnly: false };
    return { hash, ok: true };
  }
  async closeWindow(): Promise<TxOutcome> {
    const hash = this.tx("closeWindow");
    this.window = { ...this.window, live: false, remainingTxs: 0n };
    return { hash, ok: true };
  }
  async waitForLiveWindow() {
    if (!this.window.live) throw new Error("window not live");
    return this.window;
  }
  async getEvmNonce() {
    return this.nonce;
  }

  async sendVaultCall(call: VaultCall): Promise<TxOutcome> {
    if (!this.window.live || this.window.remainingTxs < 1n) return { hash: "", ok: false, error: "no-window" };
    if (!this.window.allowedTargets.map((t) => t.toLowerCase()).includes(this.vault!.toLowerCase())) {
      return { hash: "", ok: false, error: "out of scope" };
    }
    const hash = this.tx(`vault.${call.fn}`);
    this.window = { ...this.window, remainingTxs: this.window.remainingTxs - 1n, live: this.window.remainingTxs - 1n > 0n };
    if (this.failNextVaultCall) {
      this.failNextVaultCall = false;
      return { hash, ok: false, error: "reverted on chain" };
    }
    if (call.fn === "pause") {
      this.vaultState.paused = true;
      return { hash, ok: true };
    }
    if (call.fn === "unpause") {
      this.vaultState.paused = false;
      return { hash, ok: true };
    }
    if (call.fn === "setPayee") {
      this.payees.set(call.who.toLowerCase(), { allowed: call.allowed, cap: call.cap });
      return { hash, ok: true };
    }
    if (call.fn === "setPolicy" || call.fn === "withdraw") return { hash, ok: true };
    const i = call.intent;
    if (this.agentPublicKey && this.ctx) {
      const ok = verifyPq(this.agentPublicKey, payMessage(this.ctx, i), hexToBytes(call.agentSig));
      if (!ok) return { hash, ok: false, error: "BadPQSig()" };
    }
    if (this.vaultState.paused) return { hash, ok: false, error: "VaultPaused()" };
    if (this.paid.has(i.invoiceHash.toLowerCase())) return { hash, ok: false, error: "InvoiceAlreadyPaid" };
    if (call.fn === "pay") {
      const p = this.payees.get(i.payee.toLowerCase());
      if (!p?.allowed) return { hash, ok: false, error: "PayeeNotAllowed" };
    }
    this.paid.add(i.invoiceHash.toLowerCase());
    this.vaultState.balance -= i.amount;
    this.vaultState.remainingToday -= i.amount;
    this.vaultState.totalPaid += i.amount;
    this.vaultState.paymentCount += 1n;
    return { hash, ok: true };
  }

  async simulateVaultCall(call: VaultCall) {
    this.calls.push(`simulate.${call.fn}`);
    return { ok: true };
  }

  async topUp(amount: bigint): Promise<TxOutcome> {
    const hash = this.tx("topUp");
    this.vaultState.balance += amount;
    return { hash, ok: true };
  }

  async verifyPqLive(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) {
    this.calls.push("pqcVerify");
    if (this.pqResult === null) return null;
    return verifyPq(publicKey, message, signature) && this.pqResult;
  }
}
