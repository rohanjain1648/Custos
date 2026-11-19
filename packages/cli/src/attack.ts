// npm run attack -- <poisoned | stolen-key | all> [--broadcast]
// The Attack Lab replays the two ways to rob an AI agent against the live testnet:
//   poisoned    the model is fooled by an invoice, then the Keeper itself is bypassed
//   stolen-key  an attacker holds the agent's classical ECDSA key (Q-Day), like the official Q-Day Drill bot
// Without --broadcast nothing costs anything: refused transactions never land, and vault checks use eth_call.
// With --broadcast the window-scoped attacks are sent for real, so the explorer shows the refusals.
import { classifyEvmWindowRejection, toQorAddress } from "@qorechain/evm/window";
import { qorechainTestnet } from "@qorechain/evm";
import { msg } from "@qorechain/sdk";
import { createWalletClient, encodeFunctionData, http, parseEther, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explorerTxUrl, invoiceHash, payMessage, signPq, TESTNET, type PayIntent } from "@custos/core";
import { RealChainAdapter, sendCosmosTx, accountInfo } from "@custos/keeper";
import { ERC20_ABI, keeperPost, loadAccounts, messageContext } from "./common";

const ATTACKER: Address = "0x5CCdd09DDf5B2242e636003bc9CA19e4D96b418c";
const NIMBUS: Address = "0x0Ba4629a70fa8BA79fA80f705ba9cA4A1AA4AB23";
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--")) ?? "all";
const broadcast = args.includes("--broadcast");

const { env, agent } = await loadAccounts();
const adapter = await RealChainAdapter.create({ agentMnemonic: env.agentMnemonic, vault: env.vault, token: env.token });
let passed = 0;
let failed = 0;

function verdict(refused: boolean, label: string, reason: string, hash?: string) {
  refused ? passed++ : failed++;
  console.log(`  ${refused ? "PASS  refused" : "FAIL  ACCEPTED"}  ${label}`);
  console.log(`        ${reason}${hash ? `\n        ${explorerTxUrl(hash)}` : ""}`);
}

function short(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e);
  return m.split("\n")[0].slice(0, 220);
}

async function poisoned() {
  console.log("\nAttack 1: a poisoned invoice (prompt injection, changed bank details, 4,800 fUSD)");
  const amount = 4_800_000_000n;
  const proposal = {
    invoiceId: "INV-2210",
    invoiceHash: invoiceHash("INV-2210", ATTACKER, amount),
    payee: ATTACKER,
    amount: amount.toString(),
    vendorName: "Nimbus Hosting",
    reason: "pre-approved emergency capacity", // what a fooled model would say
    flags: [] as string[], // and it raised no flags
  };
  try {
    const r = await keeperPost<{ status: string; reasons?: string[] }>(env, "/proposals", proposal);
    verdict(r.status !== "paid" && r.status !== "dry_run", "the Brain is fooled and proposes the payment", `Keeper: ${r.status}${r.reasons ? ` - ${r.reasons.join("; ")}` : ""}`);
  } catch (e) {
    console.log(`  skip  Keeper not reachable (${short(e)}); start it with \`npm run keeper\``);
  }

  if (!env.vault) return console.log("  skip  no vault deployed: the on-chain check needs `npm run setup:testnet`");
  const intent: PayIntent = { payee: ATTACKER, token: env.token, amount, invoiceHash: proposal.invoiceHash, nonce: BigInt(Date.now()), expiry: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const agentSig = toHex(signPq(adapter.agentPqKeypair.secretKey, payMessage(messageContext(env.vault), intent)));
  const sim = await adapter.simulateVaultCall({ fn: "pay", intent, agentSig });
  verdict(!sim.ok, "the Keeper is bypassed: a validly signed intent goes straight to the vault", sim.ok ? "the vault would pay!" : `CustosVault: ${sim.error}`);
  if (broadcast) {
    const out = await windowed(() => adapter.sendVaultCall({ fn: "pay", intent, agentSig }));
    if (out) verdict(!out.ok, "same call broadcast through a real window", out.error ?? "reverted on chain", out.hash || undefined);
  }
}

async function windowed<T>(fn: () => Promise<T>): Promise<T | null> {
  const opened = await adapter.openPayWindow();
  if (!opened.ok) {
    console.log(`  skip  could not open a window (${opened.error})`);
    return null;
  }
  await adapter.waitForLiveWindow(45_000);
  try {
    return await fn();
  } finally {
    const w = await adapter.getWindow();
    if (w.live) await adapter.closeWindow();
  }
}

async function stolenKey() {
  console.log("\nAttack 2: Q-Day. The attacker has the agent's ECDSA key, not its ML-DSA-87 key");
  if (!(await accountInfo(agent.cosmos))) return console.log("  skip  the agent account does not exist on chain yet (run setup first)");
  const evmKey = privateKeyToAccount(agent.privateKey as Hex);
  const attackerWallet = createWalletClient({ chain: qorechainTestnet, transport: http(TESTNET.evmRpc), account: evmKey });

  const native = await sendCosmosTx({
    account: agent,
    signMode: "classical",
    messages: [msg.bank.send({ fromAddress: agent.cosmos, toAddress: toQorAddress(ATTACKER), amount: [{ denom: TESTNET.denom, amount: "1000000" }] })],
  });
  verdict(!native.ok, "native QOR transfer signed with the ECDSA key only", native.error ?? "accepted", native.ok ? native.hash : undefined);

  const w = await adapter.getWindow();
  try {
    const hash = await attackerWallet.sendTransaction({ to: ATTACKER, value: parseEther("1") });
    verdict(false, `EVM transfer with ${w.live ? "a live" : "no"} window`, "the chain admitted it", hash);
  } catch (e) {
    verdict(true, `EVM transfer to the attacker (${w.live ? "window live" : "no window open"})`, `${classifyEvmWindowRejection(e) ?? "refused"}: ${short(e)}`);
  }

  if (!env.vault) return console.log("  skip  window-scope attacks need a deployed vault");
  if (!broadcast) {
    console.log("  info  add --broadcast to open a vault-scoped window and try the scoped attacks for real");
    const forged: PayIntent = { payee: NIMBUS, token: env.token, amount: 1_000_000n, invoiceHash: invoiceHash("FORGED", NIMBUS, 1n), nonce: BigInt(Date.now()), expiry: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const sim = await adapter.simulateVaultCall({ fn: "pay", intent: forged, agentSig: toHex(crypto.getRandomValues(new Uint8Array(4627))) });
    verdict(!sim.ok, "vault payout with a forged ML-DSA-87 signature (simulated)", `CustosVault: ${sim.error}`);
    return;
  }
  await windowed(async () => {
    console.log("  info  a payout window is open (1 tx, vault only): the attacker strikes now");
    for (const [label, tx] of [
      ["EVM transfer to the attacker inside the window", { to: ATTACKER, value: parseEther("1") }],
      ["fUSD approve(attacker) inside the window", { to: TESTNET.fusd.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ATTACKER, 2n ** 255n] }) }],
    ] as const) {
      try {
        const hash = await attackerWallet.sendTransaction(tx as never);
        verdict(false, label, "the chain admitted it", hash);
      } catch (e) {
        verdict(true, label, `${classifyEvmWindowRejection(e) ?? "refused"}: ${short(e)}`);
      }
    }
    const forged: PayIntent = { payee: NIMBUS, token: env.token, amount: 1_000_000n, invoiceHash: invoiceHash("FORGED", NIMBUS, 1n), nonce: BigInt(Date.now()), expiry: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const out = await adapter.sendVaultCall({ fn: "pay", intent: forged, agentSig: toHex(crypto.getRandomValues(new Uint8Array(4627))) });
    verdict(!out.ok, "vault payout with a forged ML-DSA-87 signature (inside the window)", out.ok ? "PAID" : (out.error ?? "reverted"), out.hash || undefined);
  });
  const after = await adapter.getWindow();
  console.log(`  info  window after the attack: ${after.live ? "still live" : "closed"}`);
}

if (scenario === "poisoned" || scenario === "all") await poisoned();
if (scenario === "stolen-key" || scenario === "all") await stolenKey();
console.log(`\n${passed} attack(s) refused, ${failed} accepted.${failed ? " Investigate before the drill." : ""}`);
process.exit(failed ? 1 : 0);
