import {
  approvedPayMessage,
  deserializeIntent,
  evaluateProposal,
  keyFingerprint,
  newNonce,
  pauseMessage,
  payMessage,
  serializeIntent,
  ZERO_ADDRESS,
  type Mandate,
  type MessageContext,
  type PayIntent,
  type Proposal,
  type SpendState,
  type VendorEntry,
} from "@custos/core";
import { hexToBytes, toHex, type Hex } from "viem";
import { newId, type ActivityItem, type ApprovalRecord, type KeeperState, type Store } from "./store";
import type { AgentSigner, ChainAdapter, OwnerOp, TxOutcome, VaultCall } from "./types";

export interface KeeperOptions {
  adapter: ChainAdapter;
  signer: AgentSigner;
  store: Store;
  cosmosChainId: string;
  chainId: bigint;
  /** Dry-run: sign and verify everything, broadcast nothing. */
  dryRun: boolean;
  /** The mandate used when no vault is deployed (offline demo). */
  fallbackMandate?: Mandate;
  vendors?: VendorEntry[];
  /** Shown in /status so the console can describe Lock 1 (treasury rules). */
  topUpInfo?: { treasury?: string; linkedKey?: string };
  /** Minimum top-up when the vault cannot cover a payout. */
  topUpAmount?: bigint;
  intentTtlSeconds?: number;
  approvalTtlSeconds?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export type ProposalResult =
  | { status: "paid"; invoiceId: string; txHash: string }
  | {
      status: "dry_run";
      invoiceId: string;
      pqVerifiedOnChain: boolean | null;
      simulation?: { ok: boolean; error?: string };
    }
  | { status: "needs_approval"; invoiceId: string; approvalId: string; reasons: string[] }
  | { status: "rejected"; invoiceId: string; reasons: string[] }
  | { status: "failed"; invoiceId: string; error: string };

export function errMsg(e: unknown): string {
  if (e instanceof Error) return (e as Error & { shortMessage?: string }).shortMessage ?? e.message;
  return String(e);
}

function addPaid(s: KeeperState, invoiceHash: string): void {
  const h = invoiceHash.toLowerCase();
  if (!s.paidInvoices.includes(h)) s.paidInvoices.push(h);
}

/**
 * The Keeper is the only process that holds the agent's ML-DSA-87 key. It applies the owner's mandate in code
 * (the same rules the vault enforces on-chain), signs payout intents, and moves each signed intent through a
 * just-in-time EVM window that admits one transaction, to the vault only. Work is serialised: one window at a time.
 */
export class Keeper {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: KeeperOptions) {}

  get adapter(): ChainAdapter {
    return this.o.adapter;
  }

  get dryRun(): boolean {
    return this.o.dryRun;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get ctx(): MessageContext {
    return { cosmosChainId: this.o.cosmosChainId, chainId: this.o.chainId, vault: this.o.adapter.vault ?? ZERO_ADDRESS };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private activity(item: Omit<ActivityItem, "id" | "at">): void {
    const full: ActivityItem = { id: newId("act"), at: new Date(this.now()).toISOString(), ...item };
    this.o.store.update((s) => {
      s.activity.push(full);
    });
    this.o.log?.(`[keeper] ${full.kind}${full.invoiceId ? ` ${full.invoiceId}` : ""}${full.txHash ? ` tx=${full.txHash}` : ""}${full.detail ? ` - ${full.detail}` : ""}`);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Recover from a crash: settle or abandon a half-done payout and close any window left open. */
  start(): Promise<void> {
    return this.serial(async () => {
      const pending = this.o.store.read().pending;
      if (!pending) return;
      let detail = `resumed after a restart at stage "${pending.stage}"`;
      if (this.o.adapter.vault && (await this.o.adapter.isInvoicePaid(pending.invoiceHash as Hex))) {
        this.o.store.update((s) => addPaid(s, pending.invoiceHash));
        detail += "; the invoice is paid on chain";
      }
      if (!this.o.dryRun) {
        const w = await this.o.adapter.getWindow();
        if (w.live) {
          const c = await this.o.adapter.closeWindow();
          detail += c.ok ? `; closed a leftover window (${c.hash})` : `; could not close a leftover window: ${c.error}`;
          await this.recordNonce();
        }
      }
      this.o.store.update((s) => {
        s.pending = null;
      });
      this.activity({ kind: "recovered", invoiceId: pending.invoiceId, detail });
    });
  }

  // ------------------------------------------------------------------ proposals

  handleProposal(p: Proposal): Promise<ProposalResult> {
    return this.serial(() => this.process(p));
  }

  private async process(p: Proposal): Promise<ProposalResult> {
    try {
      const { mandate, spend } = await this.snapshot(p);
      const decision = evaluateProposal(p, mandate, spend);
      const base = { invoiceId: p.invoiceId, vendorName: p.vendorName, payee: p.payee, amount: p.amount.toString() };
      if (decision.kind === "reject") {
        this.activity({ kind: "rejected", ...base, reasons: decision.reasons });
        return { status: "rejected", invoiceId: p.invoiceId, reasons: decision.reasons };
      }
      if (decision.kind === "needs_approval") {
        const intent = this.buildIntent(p, this.o.approvalTtlSeconds ?? 24 * 3600);
        return this.requestApproval(p, intent, decision.reasons);
      }
      const intent = this.buildIntent(p, this.o.intentTtlSeconds ?? 15 * 60);
      return await this.execute(p, intent, null);
    } catch (e) {
      const error = errMsg(e);
      this.activity({ kind: "error", invoiceId: p.invoiceId, detail: error });
      return { status: "failed", invoiceId: p.invoiceId, error };
    }
  }

  /** The mandate and today's spend, read from the vault when one is deployed. */
  private async snapshot(p: Proposal): Promise<{ mandate: Mandate; spend: SpendState }> {
    const state = this.o.store.read();
    const paid = new Set(state.paidInvoices);
    if (state.pending) paid.add(state.pending.invoiceHash.toLowerCase());

    if (!this.o.adapter.vault) {
      if (!this.o.fallbackMandate) throw new Error("no vault is configured and no fallback mandate was given");
      return { mandate: this.o.fallbackMandate, spend: { spentToday: this.localSpentToday(state), paidInvoices: paid } };
    }
    const [status, payee, invoicePaid] = await Promise.all([
      this.o.adapter.readVaultStatus(),
      this.o.adapter.readPayee(p.payee),
      this.o.adapter.isInvoicePaid(p.invoiceHash),
    ]);
    if (invoicePaid) paid.add(p.invoiceHash.toLowerCase());
    const mandate: Mandate = {
      perTxCap: status.perTxCap,
      dailyCap: status.dailyCap,
      paused: status.paused,
      payees: { [p.payee.toLowerCase()]: { allowed: payee.allowed, cap: payee.cap } },
    };
    const spentToday = status.dailyCap > status.remainingToday ? status.dailyCap - status.remainingToday : 0n;
    return { mandate, spend: { spentToday, paidInvoices: paid } };
  }

  private localSpentToday(state: KeeperState): bigint {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return state.activity
      .filter((a) => (a.kind === "paid" || a.kind === "dry_run" || a.kind === "approval_executed") && a.at.startsWith(today))
      .reduce((sum, a) => sum + BigInt(a.amount ?? "0"), 0n);
  }

  private buildIntent(p: Proposal, ttlSeconds: number): PayIntent {
    return {
      payee: p.payee,
      token: this.o.adapter.token,
      amount: p.amount,
      invoiceHash: p.invoiceHash,
      nonce: newNonce(this.now()),
      expiry: BigInt(Math.floor(this.now() / 1000) + ttlSeconds),
    };
  }

  private requestApproval(p: Proposal, intent: PayIntent, reasons: string[]): ProposalResult {
    const agentSig = toHex(this.o.signer.sign(payMessage(this.ctx, intent)));
    const record: ApprovalRecord = {
      id: newId("apr"),
      createdAt: new Date(this.now()).toISOString(),
      status: "pending",
      invoiceId: p.invoiceId,
      vendorName: p.vendorName,
      payee: p.payee,
      amount: p.amount.toString(),
      invoiceHash: p.invoiceHash,
      reasons,
      intent: serializeIntent(intent),
      agentSig,
      ownerMessage: toHex(approvedPayMessage(this.ctx, intent)),
    };
    this.o.store.update((s) => {
      s.approvals.push(record);
    });
    this.activity({
      kind: "approval_requested",
      invoiceId: p.invoiceId,
      vendorName: p.vendorName,
      payee: p.payee,
      amount: p.amount.toString(),
      reasons,
      detail: `approval ${record.id} waits for the owner's ML-DSA-87 signature`,
    });
    return { status: "needs_approval", invoiceId: p.invoiceId, approvalId: record.id, reasons };
  }

  // ------------------------------------------------------------------ execution

  private async execute(p: Proposal, intent: PayIntent, ownerSig: Hex | null): Promise<ProposalResult> {
    const msg = payMessage(this.ctx, intent);
    const agentSig = toHex(this.o.signer.sign(msg));
    const call: VaultCall = ownerSig
      ? { fn: "payApproved", intent, agentSig, ownerSig }
      : { fn: "pay", intent, agentSig };
    const base = { invoiceId: p.invoiceId, vendorName: p.vendorName, payee: p.payee, amount: p.amount.toString() };

    if (this.o.dryRun) {
      const pqVerifiedOnChain = await this.o.adapter.verifyPqLive(this.o.signer.publicKey, msg, hexToBytes(agentSig));
      const simulation = this.o.adapter.vault ? await this.o.adapter.simulateVaultCall(call) : undefined;
      this.o.store.update((s) => addPaid(s, intent.invoiceHash));
      const pqText =
        pqVerifiedOnChain === true
          ? "ML-DSA-87 signature verified by the testnet pqcVerify precompile"
          : pqVerifiedOnChain === false
            ? "ML-DSA-87 signature REJECTED by pqcVerify"
            : "pqcVerify not reached (offline)";
      const simText = simulation ? `; vault simulation: ${simulation.ok ? "would succeed" : simulation.error}` : "";
      this.activity({ kind: "dry_run", ...base, detail: `${pqText}${simText}; nothing was broadcast` });
      return { status: "dry_run", invoiceId: p.invoiceId, pqVerifiedOnChain, simulation };
    }

    this.o.store.update((s) => {
      s.pending = { invoiceId: p.invoiceId, invoiceHash: intent.invoiceHash.toLowerCase(), startedAt: new Date(this.now()).toISOString(), stage: "signed" };
    });
    try {
      await this.ensureFunds(intent.amount, p.invoiceId);
      await this.ensureWindow(p.invoiceId);
      this.o.store.update((s) => {
        if (s.pending) s.pending.stage = "window_open";
      });
      const out = await this.o.adapter.sendVaultCall(call);
      this.o.store.update((s) => {
        if (s.pending) {
          s.pending.stage = "sent";
          s.pending.txHash = out.hash;
        }
      });
      await this.closeIfStillLive(p.invoiceId);
      await this.recordNonce();
      if (!out.ok) {
        this.o.store.update((s) => {
          s.pending = null;
        });
        this.activity({ kind: "error", ...base, txHash: out.hash || undefined, detail: `vault call failed: ${out.error}` });
        return { status: "failed", invoiceId: p.invoiceId, error: out.error ?? "reverted" };
      }
      this.o.store.update((s) => {
        addPaid(s, intent.invoiceHash);
        s.pending = null;
      });
      this.activity({ kind: ownerSig ? "approval_executed" : "paid", ...base, txHash: out.hash });
      return { status: "paid", invoiceId: p.invoiceId, txHash: out.hash };
    } catch (e) {
      this.o.store.update((s) => {
        s.pending = null;
      });
      await this.closeIfStillLive(p.invoiceId).catch(() => undefined);
      throw e;
    }
  }

  private async ensureFunds(amount: bigint, invoiceId: string): Promise<void> {
    const status = await this.o.adapter.readVaultStatus();
    if (status.balance >= amount) return;
    const need = amount - status.balance;
    const topUp = this.o.topUpAmount && this.o.topUpAmount > need ? this.o.topUpAmount : need;
    const out = await this.o.adapter.topUp(topUp);
    await this.recordNonce();
    if (!out.ok) throw new Error(`the vault holds ${status.balance} and the top-up failed: ${out.error}`);
    this.activity({ kind: "topped_up", invoiceId, amount: topUp.toString(), txHash: out.hash, detail: "linked key moved funds from the treasury into the vault (MsgExecuteEVM)" });
  }

  private async ensureWindow(invoiceId: string): Promise<void> {
    const vault = this.o.adapter.vault!.toLowerCase();
    const w = await this.o.adapter.getWindow();
    const ours = w.allowedTargets.length === 1 && w.allowedTargets[0].toLowerCase() === vault && !w.nativeOnly;
    if (w.live && w.remainingTxs > 0n && ours) return;
    if (w.live) {
      const closed = await this.o.adapter.closeWindow();
      this.activity({ kind: "window_closed", invoiceId, txHash: closed.hash, detail: "closed a window the Keeper did not open" });
    }
    const opened = await this.o.adapter.openPayWindow();
    if (!opened.ok) throw new Error(`could not open the EVM window: ${opened.error}`);
    this.activity({ kind: "window_opened", invoiceId, txHash: opened.hash, detail: "1 tx, fee-only value, target: the vault" });
    await this.recordNonce();
    await this.o.adapter.waitForLiveWindow(45_000);
  }

  private async closeIfStillLive(invoiceId: string): Promise<void> {
    const w = await this.o.adapter.getWindow();
    if (!w.live) return;
    const c = await this.o.adapter.closeWindow();
    this.activity({ kind: "window_closed", invoiceId, txHash: c.hash, detail: c.ok ? "closed after use" : `close failed: ${c.error}` });
  }

  private async recordNonce(): Promise<void> {
    const nonce = await this.o.adapter.getEvmNonce();
    this.o.store.update((s) => {
      s.expectedNonce = nonce;
    });
  }

  // ------------------------------------------------------------------ approvals

  decideApproval(id: string, approved: boolean, ownerSig?: string): Promise<ApprovalRecord> {
    return this.serial(async () => {
      const rec = this.o.store.read().approvals.find((a) => a.id === id);
      if (!rec) throw new Error(`no approval with id ${id}`);
      if (rec.status !== "pending") throw new Error(`approval ${id} is already ${rec.status}`);
      const setStatus = (patch: Partial<ApprovalRecord>) =>
        this.o.store.update((s) => {
          const r = s.approvals.find((a) => a.id === id);
          if (r) Object.assign(r, patch);
        });

      if (!approved) {
        setStatus({ status: "rejected" });
        this.activity({ kind: "approval_rejected", invoiceId: rec.invoiceId, vendorName: rec.vendorName, payee: rec.payee, amount: rec.amount });
        return { ...rec, status: "rejected" };
      }
      if (!ownerSig || !/^0x[0-9a-fA-F]+$/.test(ownerSig)) {
        throw new Error("approving needs the owner's ML-DSA-87 signature over ownerMessage, as hex");
      }
      const intent = deserializeIntent(rec.intent);
      if (intent.expiry * 1000n < BigInt(this.now())) {
        setStatus({ status: "failed", error: "the signed intent expired; ask the agent again" });
        return { ...rec, status: "failed", error: "the signed intent expired; ask the agent again" };
      }
      const proposal: Proposal = {
        invoiceId: rec.invoiceId,
        invoiceHash: rec.invoiceHash as Hex,
        payee: intent.payee,
        amount: intent.amount,
        vendorName: rec.vendorName,
      };
      const result = await this.execute(proposal, intent, ownerSig as Hex).catch(
        (e): ProposalResult => ({ status: "failed", invoiceId: rec.invoiceId, error: errMsg(e) }),
      );
      const patch: Partial<ApprovalRecord> =
        result.status === "paid"
          ? { status: "executed", txHash: result.txHash }
          : result.status === "dry_run"
            ? { status: "executed", error: "dry-run: nothing was broadcast" }
            : { status: "failed", error: result.status === "failed" ? result.error : result.status };
      setStatus(patch);
      return { ...rec, ...patch };
    });
  }

  // ---------------------------------------------------------------- kill switch

  /** Pause the vault with the agent's key. Only the owner can unpause. */
  pause(reason: string): Promise<TxOutcome> {
    return this.serial(async () => {
      const nonce = newNonce(this.now());
      const expiry = BigInt(Math.floor(this.now() / 1000) + 3600);
      const sig = toHex(this.o.signer.sign(pauseMessage(this.ctx, nonce, expiry)));
      const call: VaultCall = { fn: "pause", nonce, expiry, sig, byOwner: false };
      if (this.o.dryRun || !this.o.adapter.vault) {
        this.activity({ kind: "paused", detail: `dry-run pause (${reason}); nothing was broadcast` });
        return { hash: "", ok: true };
      }
      await this.ensureWindow("pause");
      const out = await this.o.adapter.sendVaultCall(call);
      await this.closeIfStillLive("pause");
      await this.recordNonce();
      this.activity({ kind: out.ok ? "paused" : "error", txHash: out.hash, detail: out.ok ? `vault paused: ${reason}` : `pause failed: ${out.error}` });
      return out;
    });
  }

  /**
   * Relay an operation the owner signed (add a payee, change caps, unpause, withdraw). The Keeper adds no
   * authority: the vault verifies the owner's ML-DSA-87 signature, so a relay can only deliver what the owner signed.
   */
  relayOwnerOp(op: OwnerOp): Promise<TxOutcome & { simulated?: boolean }> {
    return this.serial(async () => {
      if (this.o.dryRun || !this.o.adapter.vault) {
        const sim = this.o.adapter.vault ? await this.o.adapter.simulateVaultCall(op) : { ok: true };
        this.activity({ kind: "relayed", detail: `dry-run ${op.fn}: ${sim.ok ? "the vault would accept it" : sim.error}; nothing was broadcast` });
        return { hash: "", ok: sim.ok, error: "error" in sim ? sim.error : undefined, simulated: true };
      }
      await this.ensureWindow(op.fn);
      const out = await this.o.adapter.sendVaultCall(op);
      await this.closeIfStillLive(op.fn);
      await this.recordNonce();
      this.activity({ kind: out.ok ? "relayed" : "error", txHash: out.hash || undefined, detail: out.ok ? `owner-signed ${op.fn} relayed` : `${op.fn} failed: ${out.error}` });
      return out;
    });
  }

  /** Record an alert raised by the Sentinel. */
  alert(detail: string): void {
    this.activity({ kind: "alert", detail });
  }

  // --------------------------------------------------------------------- views

  async status() {
    const s = this.o.store.read();
    const a = this.o.adapter;
    const [vaultStatus, window, evmNonce] = await Promise.all([
      a.vault ? a.readVaultStatus().catch((e) => ({ error: errMsg(e) })) : Promise.resolve(null),
      a.getWindow().catch((e) => ({ error: errMsg(e) })),
      a.getEvmNonce().catch(() => null),
    ]);
    return {
      mode: this.o.dryRun ? "dry-run" : "live",
      agent: { evm: a.agentEvm, cosmos: a.agentCosmos, pqKeyFingerprint: keyFingerprint(this.o.signer.publicKey) },
      vault: a.vault,
      token: a.token,
      vaultStatus,
      window,
      evmNonce,
      expectedNonce: s.expectedNonce,
      pending: s.pending,
      pendingApprovals: s.approvals.filter((x) => x.status === "pending").length,
      paidInvoices: s.paidInvoices.length,
      topUp: this.o.topUpInfo ?? null,
    };
  }

  activityLog(limit = 100): ActivityItem[] {
    return this.o.store.read().activity.slice(-limit).reverse();
  }

  approvals(): ApprovalRecord[] {
    return this.o.store.read().approvals.slice().reverse();
  }

  vendors(): VendorEntry[] {
    return this.o.vendors ?? [];
  }

  expectedNonce(): number | null {
    return this.o.store.read().expectedNonce;
  }
}
