import { describe, expect, it } from "vitest";
import { evaluateProposal } from "../src/policy";
import type { Mandate, Proposal, SpendState } from "../src/types";

const VENDOR = "0x8ba1f109551bD432803012645Ac136ddd64DBA72" as const;
const STRANGER = "0x000000000000000000000000000000000000bEEF" as const;

const mandate: Mandate = {
  perTxCap: 500_000_000n,
  dailyCap: 1_000_000_000n,
  paused: false,
  payees: { [VENDOR.toLowerCase()]: { allowed: true, cap: 400_000_000n, name: "Nimbus Hosting" } },
};
const fresh = (): SpendState => ({ spentToday: 0n, paidInvoices: new Set() });
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  invoiceId: "INV-1",
  invoiceHash: "0x01",
  payee: VENDOR,
  amount: 100_000_000n,
  ...over,
});

describe("evaluateProposal", () => {
  it("pays an allowlisted vendor inside every cap", () => {
    expect(evaluateProposal(proposal(), mandate, fresh())).toEqual({ kind: "pay" });
  });

  it("sends a new payee to the owner", () => {
    const d = evaluateProposal(proposal({ payee: STRANGER }), mandate, fresh());
    expect(d.kind).toBe("needs_approval");
    expect(d.kind !== "pay" && d.reasons).toContain("the payee is not on the owner's allowlist");
  });

  it("sends an over-cap amount to the owner", () => {
    const d = evaluateProposal(proposal({ amount: 450_000_000n }), mandate, fresh());
    expect(d).toEqual({ kind: "needs_approval", reasons: ["the amount is over this payee's cap"] });
  });

  it("sends a payment that would break today's cap to the owner", () => {
    const d = evaluateProposal(proposal(), mandate, { spentToday: 950_000_000n, paidInvoices: new Set() });
    expect(d).toEqual({ kind: "needs_approval", reasons: ["the amount would go over today's cap"] });
  });

  it("refuses an invoice already paid, whatever its nonce", () => {
    const d = evaluateProposal(proposal({ invoiceHash: "0xABCD" }), mandate, {
      spentToday: 0n,
      paidInvoices: new Set(["0xabcd"]),
    });
    expect(d.kind).toBe("reject");
  });

  it("refuses everything while paused", () => {
    expect(evaluateProposal(proposal(), { ...mandate, paused: true }, fresh()).kind).toBe("reject");
  });

  it("never auto-pays when the Brain raised a fraud signal", () => {
    const d = evaluateProposal(proposal({ flags: ["bank details changed"] }), mandate, fresh());
    expect(d).toEqual({ kind: "needs_approval", reasons: ["fraud signal: bank details changed"] });
  });

  it("refuses a zero amount", () => {
    expect(evaluateProposal(proposal({ amount: 0n }), mandate, fresh()).kind).toBe("reject");
  });
});
