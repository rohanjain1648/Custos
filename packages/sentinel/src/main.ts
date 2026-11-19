// npm run sentinel [-- --watch-only] [--interval 10]
import path from "node:path";
import { TESTNET } from "@custos/core";
import { FileStore, Keeper, KeyPairSigner, loadCustosEnv, RealChainAdapter } from "@custos/keeper";
import { Sentinel } from "./sentinel";

const args = process.argv.slice(2);
const watchOnly = args.includes("--watch-only");
const interval = Number(args[args.indexOf("--interval") + 1]) || 10;

const env = loadCustosEnv();
const adapter = await RealChainAdapter.create({ agentMnemonic: env.agentMnemonic, vault: env.vault, token: env.token });

// A Keeper instance used only for its tested pause() path, with its own state file.
const pauser = new Keeper({
  adapter,
  signer: new KeyPairSigner(adapter.agentPqKeypair),
  store: new FileStore(path.join(env.dataDir, "sentinel-state.json")),
  cosmosChainId: TESTNET.cosmosChainId,
  chainId: BigInt(TESTNET.evmChainId),
  dryRun: env.dryRun,
});

const headers = { "content-type": "application/json", ...(env.keeperApiToken ? { authorization: `Bearer ${env.keeperApiToken}` } : {}) };
const sentinel = new Sentinel({
  adapter,
  watchOnly,
  pauseVault: (reason) => pauser.pause(reason),
  keeper: {
    status: async () => {
      const r = await fetch(`${env.keeperUrl}/status`, { headers });
      if (!r.ok) throw new Error(`Keeper /status: HTTP ${r.status}`);
      return r.json();
    },
    alert: async (detail) => {
      await fetch(`${env.keeperUrl}/alert`, { method: "POST", headers, body: JSON.stringify({ detail }) });
    },
  },
  log: (l) => console.log(l),
});

console.log(`Custos Sentinel watching ${adapter.agentCosmos} every ${interval}s${watchOnly ? " (watch-only)" : ""}${env.dryRun ? " (dry-run: pauses are not broadcast)" : ""}`);
const loop = async () => {
  try {
    const { findings } = await sentinel.tick();
    if (findings.length === 0) process.stdout.write(".");
  } catch (e) {
    console.log(`\n[sentinel] ${(e as Error).message}`);
  }
};
await loop();
setInterval(loop, interval * 1000);
