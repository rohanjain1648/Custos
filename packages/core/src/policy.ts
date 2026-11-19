import type { Decision, Mandate, Proposal, SpendState } from "./types";

/**
 * The Keeper's deterministic policy check. It mirrors the vault's on-chain rules, so a proposal the Keeper
 * lets through is one the vault will accept; anything outside them goes to the owner. The LLM never decides
 * where money goes: this function and the contract do.
 */
export function evaluateProposal(p: Proposal, m: Mandate, s: SpendState): Decision {
  if (m.paused) return { kind: "reject", reasons: ["the vault is paused"] };
  if (p.amount <= 0n) return { kind: "reject", reasons: ["the amount must be positive"] };
  if (s.paidInvoices.has(p.invoiceHash.toLowerCase())) {
    return { kind: "reject", reasons: ["this invoice is already paid or in flight"] };
  }

  const reasons: string[] = [];
  const rule = m.payees[p.payee.toLowerCase()];
  if (!rule?.allowed) {
    reasons.push("the payee is not on the owner's allowlist");
  } else if (p.amount > rule.cap) {
    reasons.push(`the amount is over this payee's cap`);
  }
  if (p.amount > m.perTxCap) reasons.push("the amount is over the per-payment cap");
  if (s.spentToday + p.amount > m.dailyCap) reasons.push("the amount would go over today's cap");
  for (const flag of p.flags ?? []) reasons.push(`fraud signal: ${flag}`);

  return reasons.length > 0 ? { kind: "needs_approval", reasons } : { kind: "pay" };
}
