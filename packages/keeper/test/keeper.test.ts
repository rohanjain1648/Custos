import { beforeEach, describe, expect, it } from "vitest";
import { toHex, type Address } from "viem";
import { invoiceHash, pqKeyFromTestSeed, signPq, approvedPayMessage, deserializeIntent, type Mandate } from "@custos/core";
import { Keeper } from "../src/keeper";
import { KeyPairSigner } from "../src/signer";
import { MemoryStore } from "../src/store";
import { FakeChain } from "./fake-chain";

const VAULT: Address = "0x00000000000000000000000000000000000fa017";
const VENDOR: Address = "0x0Ba4629a70fa8BA79fA80f705ba9cA4A1AA4AB23";
const STRANGER: Address = "0xd5563B421C664beC71ed07D65433eE761074242A";
const agentKey = pqKeyFromTestSeed(new Uint8Array(32).fill(7));
const ownerKey = pqKeyFromTestSeed(new Uint8Array(32).fill(9));
const ctx = { cosmosChainId: "qorechain-diana", chainId: 9800n, vault: VAULT };

function proposal(id: string, payee: Address = VENDOR, amount = 120_000_000n) {
  return { invoiceId: id, invoiceHash: invoiceHash(id, payee, amount), payee, amount, vendorName: "Nimbus Hosting" };
}

function setup(opts: { dryRun?: boolean; vault?: Address | null; store?: MemoryStore } = {}) {
  const vault = opts.vault === undefined ? VAULT : opts.vault;
  const chain = new FakeChain(vault, agentKey.publicKey, ctx);
  chain.payees.set(VENDOR.toLowerCase(), { allowed: true, cap: 400_000_000n });
  const store = opts.store ?? new MemoryStore();
  const fallbackMandate: Mandate = {
    perTxCap: 500_000_000n,
    dailyCap: 1_000_000_000n,
    paused: false,
    payees: { [VENDOR.toLowerCase()]: { allowed: true, cap: 400_000_000n } },
  };
  const keeper = new Keeper({
    adapter: chain,
    signer: new KeyPairSigner(agentKey),
    store,
    cosmosChainId: "qorechain-diana",
    chainId: 9800n,
    dryRun: opts.dryRun ?? false,
    fallbackMandate,
  });
  return { chain, store, keeper };
}

describe("Keeper (live mode against a fake chain)", () => {
  it("pays an allowlisted invoice through a fresh 1-tx window scoped to the vault", async () => {
    const { chain, store, keeper } = setup();
    const res = await keeper.handleProposal(proposal("INV-1042"));
    expect(res.status).toBe("paid");
    expect(chain.calls).toEqual(["openWindow", "vault.pay"]);
    expect(chain.window.live).toBe(false);
    const s = store.read();
    expect(s.paidInvoices).toContain(invoiceHash("INV-1042", VENDOR, 120_000_000n).toLowerCase());
    expect(s.expectedNonce).toBe(chain.nonce);
    expect(s.pending).toBeNull();
    expect(s.activity.map((a) => a.kind)).toEqual(["window_opened", "paid"]);
  });

  it("signs the exact vault message with ML-DSA-87 (the fake vault verifies it)", async () => {
    const { chain, keeper } = setup();
    await keeper.handleProposal(proposal("INV-SIG"));
    expect(chain.vaultState.paymentCount).toBe(1n);
  });

  it("rejects a duplicate invoice", async () => {
    const { chain, keeper } = setup();
    await keeper.handleProposal(proposal("INV-DUP"));
    const again = await keeper.handleProposal(proposal("INV-DUP"));
    expect(again.status).toBe("rejected");
    expect(chain.calls.filter((c) => c === "vault.pay")).toHaveLength(1);
  });

  it("queues an approval for a new payee and executes it with the owner's signature", async () => {
    const { chain, keeper } = setup();
    const res = await keeper.handleProposal(proposal("INV-5077", STRANGER, 600_000_000n));
    expect(res.status).toBe("needs_approval");
    expect(chain.calls).toEqual([]);

    const [apr] = keeper.approvals();
    expect(apr.ownerMessage).toBe(toHex(approvedPayMessage(ctx, deserializeIntent(apr.intent))));
    const ownerSig = toHex(signPq(ownerKey.secretKey, approvedPayMessage(ctx, deserializeIntent(apr.intent))));
    const done = await keeper.decideApproval(apr.id, true, ownerSig);
    expect(done.status).toBe("executed");
    expect(chain.calls).toEqual(["openWindow", "vault.payApproved"]);
  });

  it("refuses to approve without a signature, and records a rejection", async () => {
    const { keeper } = setup();
    await keeper.handleProposal(proposal("INV-NOSIG", STRANGER, 10_000_000n));
    const [apr] = keeper.approvals();
    await expect(keeper.decideApproval(apr.id, true)).rejects.toThrow(/signature/);
    const rejected = await keeper.decideApproval(apr.id, false);
    expect(rejected.status).toBe("rejected");
  });

  it("tops up the vault through the linked key when the balance is short", async () => {
    const { chain, keeper } = setup();
    chain.vaultState.balance = 50_000_000n;
    const res = await keeper.handleProposal(proposal("INV-TOPUP"));
    expect(res.status).toBe("paid");
    expect(chain.calls).toEqual(["topUp", "openWindow", "vault.pay"]);
  });

  it("refuses payouts while the vault is paused", async () => {
    const { chain, keeper } = setup();
    chain.vaultState.paused = true;
    const res = await keeper.handleProposal(proposal("INV-PAUSED"));
    expect(res.status).toBe("rejected");
    expect(chain.calls).toEqual([]);
  });

  it("closes a window it did not open before opening its own", async () => {
    const { chain, keeper } = setup();
    chain.window = { found: true, live: true, remainingTxs: 5n, remainingValue: 1n, remainingBlocks: 9n, allowedTargets: ["0x000000000000000000000000000000000000dEaD"], nativeOnly: false };
    await keeper.handleProposal(proposal("INV-FOREIGN"));
    expect(chain.calls).toEqual(["closeWindow", "openWindow", "vault.pay"]);
  });

  it("recovers on start: closes a leftover window and clears the half-done payout", async () => {
    const store = new MemoryStore();
    store.update((s) => {
      s.pending = { invoiceId: "INV-CRASH", invoiceHash: "0xabc", startedAt: new Date().toISOString(), stage: "window_open" };
    });
    const { chain, keeper } = setup({ store });
    chain.window = { found: true, live: true, remainingTxs: 1n, remainingValue: 1n, remainingBlocks: 9n, allowedTargets: [VAULT], nativeOnly: false };
    await keeper.start();
    expect(chain.calls).toEqual(["closeWindow"]);
    expect(store.read().pending).toBeNull();
    expect(store.read().activity.at(-1)?.kind).toBe("recovered");
  });

  it("reports a failed vault call without marking the invoice paid", async () => {
    const { chain, store, keeper } = setup();
    chain.failNextVaultCall = true;
    const res = await keeper.handleProposal(proposal("INV-FAIL"));
    expect(res.status).toBe("failed");
    expect(store.read().paidInvoices).toHaveLength(0);
  });

  it("pauses the vault with the agent key through a window", async () => {
    const { chain, keeper } = setup();
    const out = await keeper.pause("test");
    expect(out.ok).toBe(true);
    expect(chain.calls).toEqual(["openWindow", "vault.pause"]);
    expect(chain.vaultState.paused).toBe(true);
  });
});

describe("Keeper (dry-run)", () => {
  it("never broadcasts and checks the signature with pqcVerify", async () => {
    const { chain, keeper } = setup({ dryRun: true });
    const res = await keeper.handleProposal(proposal("INV-DRY"));
    expect(res).toMatchObject({ status: "dry_run", pqVerifiedOnChain: true });
    expect(chain.calls).toEqual(["pqcVerify", "simulate.pay"]);
  });

  it("works with no vault deployed, using the fallback mandate", async () => {
    const { chain, keeper } = setup({ dryRun: true, vault: null });
    const ok = await keeper.handleProposal(proposal("INV-OFF"));
    expect(ok.status).toBe("dry_run");
    const approval = await keeper.handleProposal(proposal("INV-OFF2", STRANGER, 10_000_000n));
    expect(approval.status).toBe("needs_approval");
    expect(chain.calls).toEqual(["pqcVerify"]);
  });

  it("enforces the daily cap from its own log when no vault is deployed", async () => {
    const { keeper } = setup({ dryRun: true, vault: null });
    await keeper.handleProposal(proposal("A1", VENDOR, 400_000_000n));
    await keeper.handleProposal(proposal("A2", VENDOR, 400_000_000n));
    const third = await keeper.handleProposal(proposal("A3", VENDOR, 300_000_000n));
    expect(third.status).toBe("needs_approval");
  });
});
