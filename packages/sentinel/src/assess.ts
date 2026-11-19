import type { Address } from "viem";
import type { WindowState } from "@custos/keeper";

export interface Observation {
  evmNonce: number;
  /** The nonce the Keeper (or the Sentinel itself) expects after its own last transaction. */
  expectedNonce: number | null;
  window: WindowState;
  /** True while the Keeper has a payout in flight (it may legitimately hold a window open). */
  keeperBusy: boolean;
  vault: Address | null;
  paused: boolean;
}

export type FindingKind = "unexpected_nonce" | "idle_window" | "foreign_window";

export interface Finding {
  kind: FindingKind;
  detail: string;
}

/**
 * Compare what the chain shows for the agent account with what the Keeper says it did. Anything the Keeper did
 * not do is treated as an attacker holding the agent's classical key.
 */
export function assess(o: Observation): Finding[] {
  const findings: Finding[] = [];
  const targets = o.window.allowedTargets.map((t) => t.toLowerCase());
  const vault = o.vault?.toLowerCase();

  if (o.window.live && (o.window.nativeOnly || targets.length !== 1 || targets[0] !== vault)) {
    findings.push({
      kind: "foreign_window",
      detail: `a live window is scoped to ${o.window.nativeOnly ? "native transfers" : targets.join(", ") || "anything"}, not only the vault`,
    });
  }
  if (!o.keeperBusy) {
    if (o.expectedNonce !== null && o.evmNonce > o.expectedNonce) {
      findings.push({
        kind: "unexpected_nonce",
        detail: `the agent account sent ${o.evmNonce - o.expectedNonce} transaction(s) the Keeper did not record (nonce ${o.evmNonce}, expected ${o.expectedNonce})`,
      });
    }
    if (o.window.live && !findings.some((f) => f.kind === "foreign_window")) {
      findings.push({ kind: "idle_window", detail: "a window is open while no payout is in flight" });
    }
  }
  return findings;
}
