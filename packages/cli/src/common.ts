import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import { qorechainTestnet } from "@qorechain/evm";
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { TESTNET, type MessageContext, ZERO_ADDRESS } from "@custos/core";
import { loadCustosEnv, type CustosEnv } from "@custos/keeper";

export const publicClient = createPublicClient({ chain: qorechainTestnet, transport: http(TESTNET.evmRpc) });

export interface Accounts {
  env: CustosEnv;
  owner: UnifiedAccount;
  agent: UnifiedAccount;
  linked?: PrivateKeyAccount;
}

export async function loadAccounts(): Promise<Accounts> {
  const env = loadCustosEnv();
  if (!env.ownerMnemonic) throw new Error("OWNER_MNEMONIC is missing: run `npm run keys` first");
  if (env.agentMnemonicIsPublic) throw new Error("AGENT_MNEMONIC is missing: run `npm run keys` first");
  return {
    env,
    owner: await deriveUnifiedAccount(env.ownerMnemonic),
    agent: await deriveUnifiedAccount(env.agentMnemonic),
    linked: env.linkedKeyPrivateKey ? privateKeyToAccount(env.linkedKeyPrivateKey) : undefined,
  };
}

export function messageContext(vault: Address | null): MessageContext {
  return { cosmosChainId: TESTNET.cosmosChainId, chainId: BigInt(TESTNET.evmChainId), vault: vault ?? ZERO_ADDRESS };
}

const KEY_STATUS_ABI = [
  {
    type: "function",
    name: "pqcKeyStatus",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "algorithmId", type: "uint8" },
      { name: "pubkey", type: "bytes" },
      { name: "possessionProven", type: "bool" },
    ],
  },
] as const;

/** Read an account's on-chain PQ key through the pqcKeyStatus precompile. */
export async function pqKeyStatus(address: Address) {
  const ret = await publicClient.call({
    to: TESTNET.precompiles.pqcKeyStatus,
    data: encodeFunctionData({ abi: KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [address] }),
  });
  const [registered, algorithmId, pubkey, possessionProven] = decodeFunctionResult({
    abi: KEY_STATUS_ABI,
    functionName: "pqcKeyStatus",
    data: ret.data!,
  });
  return { registered, algorithmId, pubkey, possessionProven };
}

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export { setEnvVar } from "./envfile";

export function keeperHeaders(env: CustosEnv): Record<string, string> {
  return { "content-type": "application/json", ...(env.keeperApiToken ? { authorization: `Bearer ${env.keeperApiToken}` } : {}) };
}

export async function keeperGet<T>(env: CustosEnv, p: string): Promise<T> {
  const r = await fetch(`${env.keeperUrl}${p}`, { headers: keeperHeaders(env) });
  const body = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`Keeper GET ${p}: ${body.error ?? r.status}`);
  return body;
}

export async function keeperPost<T>(env: CustosEnv, p: string, body: unknown): Promise<T> {
  const r = await fetch(`${env.keeperUrl}${p}`, { method: "POST", headers: keeperHeaders(env), body: JSON.stringify(body) });
  const json = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`Keeper POST ${p}: ${json.error ?? r.status}`);
  return json;
}

export const ok = (t: string) => console.log(`  ok    ${t}`);
export const skip = (t: string) => console.log(`  skip  ${t}`);
export const fail = (t: string) => console.log(`  FAIL  ${t}`);
export const step = (t: string) => console.log(`\n> ${t}`);
