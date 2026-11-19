// npm run status: the four locks, read live from testnet.
import { fetchAuthenticators, fetchEvmWindow, fetchSpendingRules } from "@qorechain/sdk";
import type { Address } from "viem";
import { custosVaultAbi, formatUnits, TESTNET } from "@custos/core";
import { loadMandateFile } from "@custos/core/node";
import { bankBalance } from "@custos/keeper";
import { ERC20_ABI, loadAccounts, pqKeyStatus, publicClient } from "./common";

const { env, owner, agent, linked } = await loadAccounts();
const mandate = loadMandateFile(env.mandatePath);
const fusd = (v: bigint) => `${formatUnits(v, mandate.decimals)} fUSD`;
const qor = (v: bigint) => `${formatUnits(v, 6)} QOR`;

async function account(label: string, a: { cosmos: string; evm: string }) {
  const [q, bankFusd, erc, key, window] = await Promise.all([
    bankBalance(a.cosmos, TESTNET.denom),
    bankBalance(a.cosmos, TESTNET.fusd.bankDenom),
    publicClient.readContract({ address: TESTNET.fusd.address, abi: ERC20_ABI, functionName: "balanceOf", args: [a.evm as Address] }).catch(() => 0n),
    pqKeyStatus(a.evm as Address),
    fetchEvmWindow({ rest: TESTNET.rest, address: a.cosmos }),
  ]);
  console.log(`\n${label}  ${a.cosmos}  ${a.evm}`);
  console.log(`  balances      ${qor(q)}, ${fusd(bankFusd)} (bank), ${fusd(erc)} (ERC-20)`);
  console.log(`  ML-DSA-87     ${key.registered ? `registered (algorithm ${key.algorithmId}, possession proven: ${key.possessionProven})` : "NOT registered"}`);
  console.log(`  EVM window    ${window.live ? `LIVE: ${window.remainingTxs} tx left, targets ${window.allowedTargets.join(", ") || "any"}` : "closed"}`);
}

console.log(`Custos status on ${TESTNET.cosmosChainId}  (mode: ${env.dryRun ? "dry-run" : "live"})`);
await account("Owner / treasury", owner);
await account("Agent / Keeper  ", agent);

if (env.vault) {
  const [paused, perTx, daily, remaining, balance, totalPaid, count] = await publicClient.readContract({ address: env.vault, abi: custosVaultAbi, functionName: "status" });
  console.log(`\nLocks 3+4  CustosVault (ML-DSA-87 check, mandate) ${env.vault}`);
  console.log(`  ${paused ? "PAUSED" : "active"}; caps ${fusd(perTx)} per payment, ${fusd(daily)} per day; ${fusd(remaining)} left today`);
  console.log(`  holds ${fusd(balance)}; paid ${fusd(totalPaid)} in ${count} payouts`);
  for (const v of mandate.vendors) {
    const [allowed, cap] = await publicClient.readContract({ address: env.vault, abi: custosVaultAbi, functionName: "payees", args: [v.address] });
    console.log(`  payee ${v.name.padEnd(22)} ${allowed ? `allowed, cap ${fusd(cap)}` : "NOT allowed"}`);
  }
} else {
  console.log("\nVault not deployed yet: run `npm run setup:testnet`.");
}

console.log(`\nLock 1  Treasury smart-account rules (${owner.cosmos})`);
const [rules, auths] = await Promise.all([
  fetchSpendingRules({ rest: TESTNET.rest, address: owner.cosmos }).catch((e) => ({ error: (e as Error).message })),
  fetchAuthenticators({ rest: TESTNET.rest, address: owner.cosmos }).catch((e) => ({ error: (e as Error).message })),
]);
console.log(`  linked key    ${linked?.address ?? "(none)"}`);
console.log(`  authenticators ${JSON.stringify(auths, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log(`  rules          ${JSON.stringify(rules, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log(`\nLock 2  the agent's EVM window is shown above: it should be closed between payouts.`);
