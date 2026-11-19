import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, qorechainRegistry, type UnifiedAccount } from "@qorechain/sdk";
import { TESTNET, type NetworkConfig } from "@custos/core";
import type { TxOutcome } from "./types";

export type CosmosRegistry = ReturnType<typeof qorechainRegistry>;

const transports = new Map<string, Promise<StargateClient>>();

function transport(rpc: string): Promise<StargateClient> {
  let t = transports.get(rpc);
  if (!t) {
    t = StargateClient.connect(rpc);
    transports.set(rpc, t);
  }
  return t;
}

export async function accountInfo(address: string, net: NetworkConfig = TESTNET): Promise<{ accountNumber: bigint; sequence: bigint } | null> {
  const r = await fetch(`${net.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`account lookup for ${address} failed: HTTP ${r.status}`);
  const body = (await r.json()) as { account: Record<string, any> };
  const base = body.account.base_account ?? body.account;
  return { accountNumber: BigInt(base.account_number), sequence: BigInt(base.sequence ?? 0) };
}

export async function bankBalance(address: string, denom: string, net: NetworkConfig = TESTNET): Promise<bigint> {
  const r = await fetch(`${net.rest}/cosmos/bank/v1beta1/balances/${address}`);
  if (!r.ok) return 0n;
  const body = (await r.json()) as { balances: { denom: string; amount: string }[] };
  return BigInt(body.balances.find((b) => b.denom === denom)?.amount ?? "0");
}

/**
 * Sign (hybrid secp256k1 + ML-DSA-87 by default) and broadcast Cosmos-lane messages from an eth-native account.
 * `signMode: "classical"` is only for the first PQ-key registration, which the chain exempts.
 */
export async function sendCosmosTx(o: {
  account: UnifiedAccount;
  messages: readonly { typeUrl: string; value: unknown }[];
  gas?: number;
  signMode?: "hybrid" | "classical";
  registry?: CosmosRegistry;
  memo?: string;
  net?: NetworkConfig;
}): Promise<TxOutcome> {
  const net = o.net ?? TESTNET;
  const gas = o.gas ?? 500_000;
  try {
    const info = await accountInfo(o.account.cosmos, net);
    if (!info) return { hash: "", ok: false, error: `account ${o.account.cosmos} does not exist on chain yet (no funds)` };
    const signer = new EthNativeSigner(o.account, { rest: net.rest, signMode: o.signMode ?? "hybrid", registry: o.registry });
    const res = await signer.signAndBroadcast(await transport(net.rpc), {
      chainId: net.cosmosChainId,
      accountNumber: info.accountNumber,
      sequence: info.sequence,
      messages: o.messages,
      memo: o.memo,
      fee: { amount: [{ denom: net.denom, amount: String(Math.ceil(gas * net.minGasPriceUqor)) }], gas: String(gas) },
    });
    const ok = res.code === 0;
    return { hash: res.transactionHash, ok, gasUsed: res.gasUsed, error: ok ? undefined : `code ${res.code}: ${res.rawLog ?? ""}` };
  } catch (e) {
    return { hash: "", ok: false, error: (e as Error).message };
  }
}
