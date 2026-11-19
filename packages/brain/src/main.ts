// npm run brain [-- --offline] [--no-mcp] [--watch] [--inbox <dir>]
import path from "node:path";
import { loadCustosEnv } from "@custos/keeper";
import { processInbox, type InvoiceReport } from "./brain";
import { hasAnthropicCredentials } from "./claude";
import { KeeperClient } from "./keeper-client";
import { connectQorechainMcp } from "./mcp";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = loadCustosEnv();
const inboxDir = path.resolve(env.root, value("--inbox") ?? "invoices/inbox");
const mode: "claude" | "offline" = flag("--offline") || !hasAnthropicCredentials() ? "offline" : "claude";
const keeper = new KeeperClient(env.keeperUrl, env.keeperApiToken);

console.log(`Custos Brain: ${mode === "claude" ? `Claude (${env.anthropicModel})` : "offline extractor (no ANTHROPIC_API_KEY, or --offline)"}`);
console.log(`  inbox   ${inboxDir}`);
console.log(`  keeper  ${env.keeperUrl}`);

const mcp = mode === "claude" && !flag("--no-mcp") ? await connectQorechainMcp((l) => console.log(l)) : null;

function print(reports: InvoiceReport[]) {
  if (reports.length === 0) {
    console.log("  (no new invoices)");
    return;
  }
  for (const r of reports) {
    console.log(`\n  ${r.file}`);
    console.log(`    ${r.invoiceId ?? "?"} | ${r.vendor ?? "?"} | ${r.amount ?? "?"} -> ${r.outcome.toUpperCase()}`);
    if (r.flags.length) console.log(`    flags: ${r.flags.join("; ")}`);
    if (r.detail) console.log(`    ${r.detail}`);
  }
}

async function runOnce() {
  const reports = await processInbox({
    inboxDir,
    statePath: path.join(env.dataDir, "brain-state.json"),
    keeper,
    mode,
    claude: { model: env.anthropicModel, extraTools: mcp?.tools },
    log: (l) => console.log(l),
  });
  print(reports);
}

try {
  await runOnce();
  if (flag("--watch")) {
    console.log("\nWatching the inbox every 15 s (Ctrl+C to stop)");
    setInterval(() => runOnce().catch((e) => console.error(e.message)), 15_000);
  } else {
    await mcp?.close();
  }
} catch (e) {
  console.error(`Brain failed: ${(e as Error).message}`);
  if ((e as Error).message.includes("fetch failed")) console.error("Is the Keeper running? Start it with `npm run keeper`.");
  await mcp?.close();
  process.exit(1);
}
