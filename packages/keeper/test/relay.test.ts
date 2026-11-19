import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { pqKeyFromTestSeed } from "@custos/core";
import { parseOwnerOp } from "../src/api";
import { Keeper } from "../src/keeper";
import { KeyPairSigner } from "../src/signer";
import { MemoryStore } from "../src/store";
import { FakeChain } from "./fake-chain";

const VAULT: Address = "0x00000000000000000000000000000000000fa017";
const NEW_PAYEE: Address = "0xd5563B421C664beC71ed07D65433eE761074242A";

function keeper(dryRun = false) {
  const chain = new FakeChain(VAULT);
  const k = new Keeper({
    adapter: chain,
    signer: new KeyPairSigner(pqKeyFromTestSeed(new Uint8Array(32).fill(1))),
    store: new MemoryStore(),
    cosmosChainId: "qorechain-diana",
    chainId: 9800n,
    dryRun,
  });
  return { chain, k };
}

describe("owner-op relay", () => {
  it("relays an owner-signed setPayee through a vault-only window", async () => {
    const { chain, k } = keeper();
    const out = await k.relayOwnerOp({ fn: "setPayee", who: NEW_PAYEE, allowed: true, cap: 1n, nonce: 9n, expiry: 99n, ownerSig: "0x01" });
    expect(out.ok).toBe(true);
    expect(chain.calls).toEqual(["openWindow", "vault.setPayee"]);
    expect(chain.payees.get(NEW_PAYEE.toLowerCase())).toEqual({ allowed: true, cap: 1n });
  });

  it("only simulates in dry-run", async () => {
    const { chain, k } = keeper(true);
    const out = await k.relayOwnerOp({ fn: "unpause", nonce: 1n, expiry: 2n, ownerSig: "0x01" });
    expect(out.simulated).toBe(true);
    expect(chain.calls).toEqual(["simulate.unpause"]);
  });

  it("parses owner ops from JSON and refuses malformed ones", () => {
    expect(parseOwnerOp({ fn: "withdraw", to: NEW_PAYEE, amount: "5", nonce: "1", expiry: "2", ownerSig: "0xab" })).toMatchObject({
      fn: "withdraw",
      amount: 5n,
    });
    expect(() => parseOwnerOp({ fn: "pay" })).toThrow(/fn must be/);
    expect(() => parseOwnerOp({ fn: "unpause", nonce: "1.5", expiry: "2", ownerSig: "0x" })).toThrow(/nonce/);
  });
});
