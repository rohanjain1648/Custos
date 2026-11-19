import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { invoiceHash, pqKeyFromTestSeed } from "@custos/core";
import { startApi } from "../src/api";
import { Keeper } from "../src/keeper";
import { KeyPairSigner } from "../src/signer";
import { MemoryStore } from "../src/store";
import { FakeChain } from "./fake-chain";

const VAULT = "0x00000000000000000000000000000000000fa017" as const;
const VENDOR = "0x0Ba4629a70fa8BA79fA80f705ba9cA4A1AA4AB23" as const;
let server: Server;
let base: string;

beforeAll(async () => {
  const key = pqKeyFromTestSeed(new Uint8Array(32).fill(3));
  const chain = new FakeChain(VAULT, key.publicKey, { cosmosChainId: "qorechain-diana", chainId: 9800n, vault: VAULT });
  chain.payees.set(VENDOR.toLowerCase(), { allowed: true, cap: 400_000_000n });
  const keeper = new Keeper({
    adapter: chain,
    signer: new KeyPairSigner(key),
    store: new MemoryStore(),
    cosmosChainId: "qorechain-diana",
    chainId: 9800n,
    dryRun: false,
  });
  server = startApi(keeper, { port: 0, token: "s3cret", decimals: 6, tokenSymbol: "fUSD" });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };

describe("Keeper HTTP API", () => {
  it("refuses requests without the API token", async () => {
    const r = await fetch(`${base}/status`);
    expect(r.status).toBe(401);
  });

  it("accepts a proposal and pays it", async () => {
    const body = { invoiceId: "INV-API", invoiceHash: invoiceHash("INV-API", VENDOR, 5_000_000n), payee: VENDOR, amount: "5000000" };
    const r = await fetch(`${base}/proposals`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("paid");
  });

  it("rejects a malformed amount with 400", async () => {
    const body = { invoiceId: "INV-BAD", invoiceHash: "0x01", payee: VENDOR, amount: "12.5" };
    const r = await fetch(`${base}/proposals`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect(r.status).toBe(400);
  });

  it("serves status and activity with bigints as strings", async () => {
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    expect(status.mode).toBe("live");
    expect(typeof status.vaultStatus.balance).toBe("string");
    const activity = await (await fetch(`${base}/activity`, { headers: auth })).json();
    expect(activity[0].kind).toBe("paid");
  });

  it("answers 404 for unknown routes", async () => {
    const r = await fetch(`${base}/nope`, { headers: auth });
    expect(r.status).toBe(404);
  });
});
