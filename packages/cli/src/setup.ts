// npm run setup:testnet
// Idempotent testnet setup. Every step checks the chain first, so it is safe to run again after a failure.
import {
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  fetchAuthenticators,
  fetchEvmWindow,
  msg,
  openEvmWindowMsg,
  qorechainRegistry,
  registerEthAuthenticatorMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { qorechainTestnet } from "@qorechain/evm";
import { evmWindowCost } from "@qorechain/evm/window";
import { createWalletClient, encodeDeployData, encodeFunctionData, hexToBytes, http, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { custosVaultAbi, payeeMessage, signPq, TESTNET, ZERO_ADDRESS } from "@custos/core";
import { custosVaultBytecode, loadMandateFile } from "@custos/core/node";
import { accountInfo, bankBalance, sendCosmosTx } from "@custos/keeper";
import { convertCoinMsg, MSG_CONVERT_COIN_TYPE_URL, MsgConvertCoin } from "./convert";
import { ERC20_ABI, fail, loadAccounts, messageContext, ok, pqKeyStatus, publicClient, setEnvVar, skip, step } from "./common";

const { env, owner, agent, linked } = await loadAccounts();
const mandate = loadMandateFile(env.mandatePath);
const FUSD = TESTNET.fusd.address;
const QOR = 1_000_000n; // uqor per QOR
// The owner must re-link the agent's key at least every 30 days (QoreChain FAQ). 29 days leaves a margin and
// keeps top-ups working through the judging window when setup runs late in the build period.
const LINKED_KEY_DAYS = 29;
let vault: Address | null = env.vault;
const token: Address = env.token;
if (token === ZERO_ADDRESS) die("setup supports the fUSD vault only (VAULT_TOKEN=native is for tests); remove VAULT_TOKEN or set it to the fUSD address");

console.log(`Custos testnet setup on ${TESTNET.cosmosChainId}`);
console.log(`  owner ${owner.cosmos} ${owner.evm}`);
console.log(`  agent ${agent.cosmos} ${agent.evm}`);

function die(text: string): never {
  fail(text);
  process.exit(1);
}

async function registerPqKey(account: UnifiedAccount, label: string) {
  const status = await pqKeyStatus(account.evm as Address);
  if (status.registered) {
    const ours = status.pubkey.toLowerCase() === toHex(account.pqc.publicKey).toLowerCase();
    if (!ours) die(`${label} has a different PQ key registered on chain; this .env cannot sign for it`);
    return skip(`${label} ML-DSA-87 key already registered (possession proven: ${status.possessionProven})`);
  }
  const proof = signProofOfPossession({ chainId: TESTNET.cosmosChainId, account: account.cosmos, keypair: account.pqc, algorithmId: 1 });
  const reg = buildRegisterPqcKeyMsg(account.cosmos, {
    pqcKeypair: account.pqc,
    ecdsaPubkey: hexToBytes(account.publicKey as Hex),
    keyType: "hybrid",
    proofOfPossession: proof,
  });
  // First registration is the chain's classical-exempt bootstrap path.
  const out = await sendCosmosTx({ account, messages: [reg], signMode: "classical", gas: 800_000 });
  if (!out.ok) die(`${label} key registration failed: ${out.error}`);
  ok(`${label} ML-DSA-87 key registered with proof of possession (${out.hash})`);
}

// ------------------------------------------------------------------ 1. funds
step("1. Owner funds");
const ownerInfo = await accountInfo(owner.cosmos);
if (!ownerInfo) die(`the owner account has no funds yet. Claim at ${TESTNET.faucet} for ${owner.cosmos}, then run again.`);
const ownerQor = await bankBalance(owner.cosmos, TESTNET.denom);
const ownerFusdBank = await bankBalance(owner.cosmos, TESTNET.fusd.bankDenom);
ok(`owner holds ${Number(ownerQor) / 1e6} QOR and ${Number(ownerFusdBank) / 1e6} fUSD (bank form)`);
if (ownerQor < 30n * QOR) die("the owner needs at least 30 QOR for fees and the agent's float; claim from the faucet");

// --------------------------------------------------------------- 2. owner PQ key
step("2. Owner post-quantum key");
await registerPqKey(owner, "owner");

// ------------------------------------------------------------------ 3. agent float
step("3. Agent float (QOR for fees and window budgets)");
const agentQor = await bankBalance(agent.cosmos, TESTNET.denom);
if (agentQor >= 10n * QOR) {
  skip(`agent already holds ${Number(agentQor) / 1e6} QOR`);
} else {
  const out = await sendCosmosTx({
    account: owner,
    messages: [msg.bank.send({ fromAddress: owner.cosmos, toAddress: agent.cosmos, amount: [{ denom: TESTNET.denom, amount: (20n * QOR).toString() }] })],
  });
  if (!out.ok) die(`could not fund the agent: ${out.error}`);
  ok(`sent 20 QOR to the agent (${out.hash})`);
}

// --------------------------------------------------------------- 4. agent PQ key
step("4. Agent post-quantum key");
await registerPqKey(agent, "agent");

// ------------------------------------------------------- 5. fUSD to ERC-20 form
step("5. fUSD into its ERC-20 form");
const decimals = mandate.decimals;
const needed = mandate.mandate.dailyCap;
const erc20Balance = async () => publicClient.readContract({ address: FUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [owner.evm as Address] });
if ((await erc20Balance()) >= needed) {
  skip(`owner already holds ${Number(await erc20Balance()) / 10 ** decimals} fUSD as ERC-20`);
} else if (ownerFusdBank === 0n) {
  die("the owner has no fUSD; the faucet sends 1000 fUSD with each claim (it may arrive in a separate transaction)");
} else {
  const registry = qorechainRegistry([[MSG_CONVERT_COIN_TYPE_URL, MsgConvertCoin as never]]);
  const out = await sendCosmosTx({ account: owner, registry, gas: 700_000, messages: [convertCoinMsg(owner.cosmos, owner.evm, TESTNET.fusd.bankDenom, ownerFusdBank)] });
  if (!out.ok) {
    die(`MsgConvertCoin failed: ${out.error}. See https://docs.qorechain.io/developer-guide/evm-development#fest-convert`);
  }
  ok(`converted ${Number(ownerFusdBank) / 1e6} fUSD to ERC-20 (${out.hash})`);
}

// ------------------------------------------------- 6. deploy and configure vault
step("6. CustosVault: deploy, fund, write the mandate");
const ownerEvm = privateKeyToAccount(owner.privateKey as Hex);
const wallet = createWalletClient({ chain: qorechainTestnet, transport: http(TESTNET.evmRpc), account: ownerEvm });
const perTxCap = mandate.mandate.perTxCap;
const dailyCap = mandate.mandate.dailyCap;
const vaultHasCode = vault ? ((await publicClient.getCode({ address: vault })) ?? "0x") !== "0x" : false;

const pendingPayees = vaultHasCode
  ? (
      await Promise.all(
        mandate.vendors.map(async (v) => {
          const [allowed] = await publicClient.readContract({ address: vault!, abi: custosVaultAbi, functionName: "payees", args: [v.address] });
          return allowed ? null : v;
        }),
      )
    ).filter((v): v is NonNullable<typeof v> => v !== null)
  : mandate.vendors;

if (vaultHasCode && pendingPayees.length === 0) {
  skip(`vault ${vault} is deployed and every mandate payee is set`);
} else {
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  const deployData = encodeDeployData({
    abi: custosVaultAbi,
    bytecode: custosVaultBytecode,
    args: [owner.evm as Address, agent.evm as Address, token, TESTNET.cosmosChainId, perTxCap, dailyCap, true],
  });
  const deployGas = vaultHasCode ? 0n : ((await publicClient.estimateGas({ account: ownerEvm.address, data: deployData })) * 13n) / 10n;
  const plan = { deploy: deployGas, approve: 120_000n, topUp: 250_000n, payee: 900_000n };
  const totalGas = plan.deploy + plan.approve + plan.topUp + plan.payee * BigInt(pendingPayees.length);
  const txCount = (vaultHasCode ? 0 : 3) + pendingPayees.length; // deploy, approve, first top-up, payees
  const budget = evmWindowCost({ gas: totalGas, maxFeePerGas });

  // A deploy needs an unscoped window: a scoped one refuses contract creation.
  const open = await sendCosmosTx({
    account: owner,
    messages: [openEvmWindowMsg({ sender: owner.cosmos, blocks: 600, maxTxs: txCount, maxValue: (budget + budget / 5n + 1n).toString() })],
  });
  if (!open.ok) die(`could not open the owner's EVM window: ${open.error}`);
  ok(`owner window open: ${txCount} txs, ~${600 * TESTNET.blockTimeSeconds}s (${open.hash})`);
  for (let i = 0; i < 30 && !(await fetchEvmWindow({ rest: TESTNET.rest, address: owner.cosmos })).live; i++) await new Promise((r) => setTimeout(r, 1500));

  let nonce = await publicClient.getTransactionCount({ address: ownerEvm.address, blockTag: "pending" });
  const send = async (label: string, tx: { to?: Address; data: Hex; gas: bigint; value?: bigint }) => {
    const hash = await wallet.sendTransaction({ ...tx, maxFeePerGas, maxPriorityFeePerGas, nonce: nonce++ });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") die(`${label} reverted (${hash})`);
    ok(`${label} (${hash})`);
    return receipt;
  };

  try {
    if (!vaultHasCode) {
      const receipt = await send("deployed CustosVault", { data: deployData, gas: plan.deploy });
      vault = receipt.contractAddress!;
      setEnvVar(env.root, "VAULT_ADDRESS", vault);
      ok(`VAULT_ADDRESS=${vault} written to .env`);
      await send("approved the vault to pull fUSD for top-ups", {
        to: token,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [vault, dailyCap * 30n] }),
        gas: plan.approve,
      });
      await send(`funded the vault with ${Number(perTxCap) / 10 ** decimals} fUSD`, {
        to: vault,
        data: encodeFunctionData({ abi: custosVaultAbi, functionName: "topUp", args: [perTxCap] }),
        gas: plan.topUp,
      });
    }
    const ctx = messageContext(vault);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    for (const v of pendingPayees) {
      const nonceOwner = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
      const sig = toHex(signPq(owner.pqc.secretKey, payeeMessage(ctx, v.address, true, v.cap, nonceOwner, expiry)));
      await send(`owner-signed payee: ${v.name} (cap ${Number(v.cap) / 10 ** decimals})`, {
        to: vault!,
        data: encodeFunctionData({ abi: custosVaultAbi, functionName: "setPayee", args: [v.address, true, v.cap, nonceOwner, expiry, sig] }),
        gas: plan.payee,
      });
    }
  } finally {
    const w = await fetchEvmWindow({ rest: TESTNET.rest, address: owner.cosmos });
    if (w.live) {
      const closed = await sendCosmosTx({ account: owner, messages: [closeEvmWindowMsg(owner.cosmos)] });
      closed.ok ? ok(`closed the owner's window (${closed.hash})`) : fail(`could not close the owner's window: ${closed.error}`);
    }
  }
}

// --------------------------------------------- 7. linked key + spending rules
step("7. Treasury smart-account rules for the linked top-up key");
if (!linked) {
  skip("LINKED_KEY_PRIVATE_KEY is not set; top-ups through the treasury are off");
} else {
  const linkedNow = (await fetchAuthenticators({ rest: TESTNET.rest, address: owner.cosmos }).catch(() => [])) as unknown[];
  const already = JSON.stringify(linkedNow).toLowerCase().includes(linked.address.slice(2).toLowerCase());
  if (already) {
    skip(`linked key ${linked.address} is already registered on the treasury`);
  } else {
    const topUpSelector = toFunctionSelector("topUp(uint256)");
    const denom = `erc20/${FUSD}`;
    const rule = {
      id: "custos-topup",
      enabled: true,
      perTxLimit: "0",
      dailyLimit: "0",
      allowedDenoms: [denom],
      allowedEvmCalls: [`${vault}/${topUpSelector}`],
      denomLimits: [{ denom, perTxLimit: perTxCap.toString(), dailyLimit: dailyCap.toString() }],
    };
    const out = await sendCosmosTx({
      account: owner,
      gas: 700_000,
      messages: [
        registerEthAuthenticatorMsg({
          owner: owner.cosmos,
          ethAddress: linked.address,
          permissions: ["evm"],
          expiryUnix: Math.floor(Date.now() / 1000) + LINKED_KEY_DAYS * 24 * 3600,
          label: "custos-linked",
        }),
        msg.abstractaccount.updateSpendingRules({ owner: owner.cosmos, accountAddress: owner.cosmos, rules: [rule] }),
      ],
    });
    out.ok
      ? ok(`linked key ${linked.address} registered (evm only, ${LINKED_KEY_DAYS} days); rule: only ${vault}.topUp, capped per tx and per day (${out.hash})`)
      : fail(`smart-account rules failed: ${out.error}. Payouts still work from the pre-funded vault; top-ups are off.`);
  }
}

console.log(`\nSetup complete.
  vault        ${vault}
  next         set KEEPER_DRY_RUN=false in .env, then:
               npm run keeper      (terminal 1)
               npm run sentinel    (terminal 2)
               npm run brain       (terminal 3)
               npm run console     (owner console)
  status       npm run status`);
