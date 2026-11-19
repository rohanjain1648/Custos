import path from "node:path";
import { TESTNET, toBaseUnits, ZERO_ADDRESS } from "@custos/core";
import { loadMandateFile } from "@custos/core/node";
import { startApi } from "./api";
import { RealChainAdapter } from "./chain-real";
import { loadCustosEnv } from "./env";
import { Keeper } from "./keeper";
import { KeyPairSigner } from "./signer";
import { FileStore } from "./store";

const env = loadCustosEnv();
const loaded = loadMandateFile(env.mandatePath);

const adapter = await RealChainAdapter.create({
  agentMnemonic: env.agentMnemonic,
  vault: env.vault,
  token: env.token,
  treasuryCosmos: env.ownerCosmos,
  linkedKeyPrivateKey: env.linkedKeyPrivateKey,
});

const keeper = new Keeper({
  adapter,
  signer: new KeyPairSigner(adapter.agentPqKeypair),
  store: new FileStore(path.join(env.dataDir, "keeper-state.json")),
  cosmosChainId: TESTNET.cosmosChainId,
  chainId: BigInt(TESTNET.evmChainId),
  dryRun: env.dryRun,
  fallbackMandate: loaded.mandate,
  vendors: loaded.vendors,
  topUpInfo: { treasury: env.ownerCosmos, linkedKey: adapter.linkedKeyAddress },
  topUpAmount: env.topUpAmount ? toBaseUnits(env.topUpAmount, loaded.decimals) : undefined,
  log: (line) => console.log(line),
});

await keeper.start();
startApi(keeper, {
  port: env.keeperPort,
  token: env.keeperApiToken,
  decimals: loaded.decimals,
  tokenSymbol: env.token === ZERO_ADDRESS ? "QOR" : TESTNET.fusd.symbol,
});

console.log(`Custos Keeper ${env.dryRun ? "(DRY-RUN: signs and verifies, broadcasts nothing)" : "(LIVE on qorechain-diana)"}`);
console.log(`  agent      ${adapter.agentEvm}  ${adapter.agentCosmos}${env.agentMnemonicIsPublic ? "  (public test mnemonic)" : ""}`);
console.log(`  vault      ${env.vault ?? "not deployed yet (using custos.mandate.json)"}`);
console.log(`  API        ${env.keeperUrl}`);
