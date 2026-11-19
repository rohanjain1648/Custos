// npm run live-check
// Proves, against the live qorechain-diana testnet and without spending anything, that:
//  1. the chain runs the features Custos depends on (PQC precompiles, smart accounts, hybrid signatures required);
//  2. an ML-DSA-87 signature the Keeper makes over a CustosVault pay message is accepted by pqcVerify on chain,
//     and a tampered one is refused.
import { createPublicClient, encodeFunctionData, http, toHex } from "viem";
import { qorechainTestnet } from "@qorechain/evm";
import { invoiceHash, payMessage, signPq, TESTNET, ZERO_ADDRESS, type PayIntent } from "@custos/core";
import { loadCustosEnv, RealChainAdapter } from "@custos/keeper";

const env = loadCustosEnv();
let failures = 0;
const line = (ok: boolean, text: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
};

async function getJson(path: string): Promise<any> {
  const r = await fetch(`${TESTNET.rest}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

console.log(`Custos live check against ${TESTNET.cosmosChainId} (EVM chain id ${TESTNET.evmChainId})\n`);

const evmParams = await getJson("/cosmos/evm/vm/v1/params");
const active: string[] = evmParams.params.active_static_precompiles.map((a: string) => a.toLowerCase());
line(active.includes(TESTNET.precompiles.pqcVerify), "pqcVerify precompile (0x…0a01) is active");
line(active.includes(TESTNET.precompiles.pqcKeyStatus), "pqcKeyStatus precompile (0x…0a02) is active");

const aa = await getJson("/qorechain/abstractaccount/v1/config");
line(aa.config.enabled === true, `x/abstractaccount is enabled (max ${aa.config.max_spending_rules} spending rules)`);

const pqc = await getJson("/qorechain/pqc/v1/params");
line(pqc.params.hybrid_signature_mode_name === "required", `hybrid signatures are "${pqc.params.hybrid_signature_mode_name}"`);

const client = createPublicClient({ chain: qorechainTestnet, transport: http(TESTNET.evmRpc) });
line((await client.getChainId()) === TESTNET.evmChainId, "EVM JSON-RPC answers with chain id 9800");

// The Keeper's own agent key (or the public test mnemonic in dry-run without .env).
const adapter = await RealChainAdapter.create({ agentMnemonic: env.agentMnemonic, vault: env.vault, token: env.token });
const vault = env.vault ?? ZERO_ADDRESS;
const payee = "0x0Ba4629a70fa8BA79fA80f705ba9cA4A1AA4AB23" as const;
const intent: PayIntent = {
  payee,
  token: env.token,
  amount: 120_000_000n,
  invoiceHash: invoiceHash("LIVE-CHECK", payee, 120_000_000n),
  nonce: 1n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 600),
};
const msg = payMessage({ cosmosChainId: TESTNET.cosmosChainId, chainId: BigInt(TESTNET.evmChainId), vault }, intent);
const sig = signPq(adapter.agentPqKeypair.secretKey, msg);
console.log(`\n      agent ${adapter.agentEvm} (${env.agentMnemonicIsPublic ? "public test mnemonic" : "from .env"})`);
console.log(`      signed ${msg.length} message bytes; signature ${sig.length} bytes`);

line((await adapter.verifyPqLive(adapter.agentPqKeypair.publicKey, msg, sig)) === true, "pqcVerify accepts the Keeper's ML-DSA-87 signature over a vault pay message");
const tampered = new Uint8Array(msg);
tampered[tampered.length - 1] ^= 1;
line((await adapter.verifyPqLive(adapter.agentPqKeypair.publicKey, tampered, sig)) === false, "pqcVerify refuses the same signature over a tampered message");

const gas = await client.estimateGas({
  to: TESTNET.precompiles.pqcVerify,
  data: encodeFunctionData({
    abi: [{ type: "function", name: "pqcVerify", stateMutability: "view", inputs: [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], outputs: [{ type: "bool" }] }],
    functionName: "pqcVerify",
    args: [toHex(adapter.agentPqKeypair.publicKey), toHex(sig), toHex(msg)],
  }),
});
console.log(`      a standalone pqcVerify call costs about ${gas.toLocaleString("en-US")} gas including calldata`);

if (env.vault) {
  const status = await adapter.readVaultStatus();
  line(true, `vault ${env.vault}: paused=${status.paused}, balance=${status.balance}, payments=${status.paymentCount}`);
}

console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
