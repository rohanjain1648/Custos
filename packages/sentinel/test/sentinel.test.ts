import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { assess } from "../src/assess";
import { Sentinel } from "../src/sentinel";
import { FakeChain } from "../../keeper/test/fake-chain";

const VAULT: Address = "0x00000000000000000000000000000000000fa017";
const closed = { found: false, live: false, remainingTxs: 0n, remainingValue: 0n, remainingBlocks: 0n, allowedTargets: [], nativeOnly: false };
const open = (targets: string[], nativeOnly = false) => ({ ...closed, found: true, live: true, remainingTxs: 1n, allowedTargets: targets, nativeOnly });

describe("assess", () => {
  it("is quiet when the chain matches the Keeper's record", () => {
    expect(assess({ evmNonce: 5, expectedNonce: 5, window: closed, keeperBusy: false, vault: VAULT, paused: false })).toEqual([]);
  });

  it("flags a transaction the Keeper did not send", () => {
    const f = assess({ evmNonce: 7, expectedNonce: 5, window: closed, keeperBusy: false, vault: VAULT, paused: false });
    expect(f.map((x) => x.kind)).toEqual(["unexpected_nonce"]);
  });

  it("allows an open vault window while a payout is in flight", () => {
    expect(assess({ evmNonce: 6, expectedNonce: 5, window: open([VAULT]), keeperBusy: true, vault: VAULT, paused: false })).toEqual([]);
  });

  it("flags a window scoped to anything but the vault, even mid-payout", () => {
    const f = assess({ evmNonce: 6, expectedNonce: 6, window: open(["0x000000000000000000000000000000000000dEaD"]), keeperBusy: true, vault: VAULT, paused: false });
    expect(f.map((x) => x.kind)).toEqual(["foreign_window"]);
    const native = assess({ evmNonce: 6, expectedNonce: 6, window: open([], true), keeperBusy: false, vault: VAULT, paused: false });
    expect(native.map((x) => x.kind)).toEqual(["foreign_window"]);
  });

  it("flags an idle vault window", () => {
    const f = assess({ evmNonce: 6, expectedNonce: 6, window: open([VAULT]), keeperBusy: false, vault: VAULT, paused: false });
    expect(f.map((x) => x.kind)).toEqual(["idle_window"]);
  });
});

describe("Sentinel.tick", () => {
  function make(expectedNonce: number | null, pending: unknown = null) {
    const chain = new FakeChain(VAULT);
    const alerts: string[] = [];
    const pauses: string[] = [];
    const sentinel = new Sentinel({
      adapter: chain,
      keeper: { status: async () => ({ expectedNonce, pending }), alert: async (d) => void alerts.push(d) },
      pauseVault: async (reason) => {
        pauses.push(reason);
        chain.vaultState.paused = true;
        return { hash: "0xpause", ok: true };
      },
    });
    return { chain, alerts, pauses, sentinel };
  }

  it("closes the window, pauses the vault and alerts on an unrecorded transaction", async () => {
    const { chain, alerts, pauses, sentinel } = make(0);
    chain.nonce = 2; // an attacker used the agent's ECDSA key twice
    chain.window = open([VAULT]);
    const r = await sentinel.tick();
    expect(r.findings.map((f) => f.kind)).toContain("unexpected_nonce");
    expect(chain.calls).toContain("closeWindow");
    expect(pauses).toHaveLength(1);
    expect(alerts[0]).toMatch(/did not record/);
  });

  it("does nothing when every transaction is the Keeper's", async () => {
    const { chain, pauses, sentinel } = make(3);
    chain.nonce = 3;
    const r = await sentinel.tick();
    expect(r).toEqual({ findings: [], actions: [] });
    expect(pauses).toHaveLength(0);
  });

  it("counts its own transactions so it does not alert on itself", async () => {
    const { chain, pauses, sentinel } = make(0);
    chain.nonce = 1;
    await sentinel.tick();
    expect(pauses).toHaveLength(1);
    const second = await sentinel.tick();
    expect(second.findings).toEqual([]);
  });
});
