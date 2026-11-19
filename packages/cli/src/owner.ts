// npm run owner -- <command>
//   pending                         list approvals waiting for you
//   approve <id> | reject <id>      sign (ML-DSA-87) or refuse an approval
//   add-payee <0x...> <cap> [name]  allowlist a payee (cap in whole fUSD)
//   remove-payee <0x...>
//   set-policy <perTx> <daily>      caps in whole fUSD
//   unpause
//   withdraw <0x...> <amount>
//   serve                           local signer for the owner console (port OWNER_SIGNER_PORT)
//
// Stand-in for QoreX: today's QoreX builds do not support message signing (signArbitrary throws
// QOREX_NOT_SUPPORTED_YET), so the owner's ML-DSA-87 key signs here, derived from OWNER_MNEMONIC exactly as
// QoreX derives it. The vault checks every signature on-chain against the key registered for the owner.
import { createServer } from "node:http";
import { getAddress, hexToBytes, toHex, type Address } from "viem";
import {
  formatUnits,
  newNonce,
  payeeMessage,
  policyMessage,
  signPq,
  toBaseUnits,
  unpauseMessage,
  withdrawMessage,
} from "@custos/core";
import { loadMandateFile } from "@custos/core/node";
import type { ApprovalRecord } from "@custos/keeper";
import { keeperGet, keeperPost, loadAccounts, messageContext } from "./common";

const { env, owner } = await loadAccounts();
const decimals = loadMandateFile(env.mandatePath).decimals;
const ctx = messageContext(env.vault);
const sign = (message: Uint8Array) => toHex(signPq(owner.pqc.secretKey, message));
const expiry = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

async function approve(id: string, approved: boolean) {
  const approvals = await keeperGet<ApprovalRecord[]>(env, "/approvals");
  const rec = approvals.find((a) => a.id === id);
  if (!rec) throw new Error(`no approval ${id}`);
  if (rec.status !== "pending") throw new Error(`approval ${id} is already ${rec.status}`);
  if (approved && !rec.ownerMessage) throw new Error(`approval ${id} has no message to sign; is this Keeper up to date?`);
  const ownerSignature = approved ? sign(hexToBytes(rec.ownerMessage as `0x${string}`)) : undefined;
  return keeperPost<ApprovalRecord>(env, `/approvals/${id}/decision`, { approved, ownerSignature });
}

async function relay(body: Record<string, unknown>) {
  return keeperPost<{ ok: boolean; hash: string; error?: string; simulated?: boolean }>(env, "/relay", body);
}

async function addPayee(who: Address, capText: string, allowed = true) {
  const cap = toBaseUnits(capText, decimals);
  const nonce = newNonce();
  const exp = expiry();
  const ownerSig = sign(payeeMessage(ctx, who, allowed, cap, nonce, exp));
  return relay({ fn: "setPayee", who, allowed, cap: cap.toString(), nonce: nonce.toString(), expiry: exp.toString(), ownerSig });
}

async function unpause() {
  const nonce = newNonce();
  const exp = expiry();
  return relay({ fn: "unpause", nonce: nonce.toString(), expiry: exp.toString(), ownerSig: sign(unpauseMessage(ctx, nonce, exp)) });
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case "pending": {
    const list = (await keeperGet<ApprovalRecord[]>(env, "/approvals")).filter((a) => a.status === "pending");
    if (list.length === 0) console.log("No approvals waiting.");
    for (const a of list) {
      console.log(`${a.id}  ${a.invoiceId}  ${a.vendorName ?? a.payee}  ${formatUnits(BigInt(a.amount), decimals)} fUSD`);
      for (const r of a.reasons) console.log(`    - ${r}`);
    }
    break;
  }
  case "approve":
  case "reject":
    if (!a1) throw new Error(`usage: npm run owner -- ${cmd} <approval id>`);
    print(await approve(a1, cmd === "approve"));
    break;
  case "add-payee":
    if (!a1 || !a2) throw new Error("usage: npm run owner -- add-payee <0x address> <cap in fUSD> [name]");
    print({ payee: a3 ?? a1, ...(await addPayee(getAddress(a1), a2)) });
    break;
  case "remove-payee":
    if (!a1) throw new Error("usage: npm run owner -- remove-payee <0x address>");
    print(await addPayee(getAddress(a1), "0", false));
    break;
  case "set-policy": {
    if (!a1 || !a2) throw new Error("usage: npm run owner -- set-policy <per-tx fUSD> <daily fUSD>");
    const perTx = toBaseUnits(a1, decimals);
    const daily = toBaseUnits(a2, decimals);
    const nonce = newNonce();
    const exp = expiry();
    print(await relay({ fn: "setPolicy", perTxCap: perTx.toString(), dailyCap: daily.toString(), nonce: nonce.toString(), expiry: exp.toString(), ownerSig: sign(policyMessage(ctx, perTx, daily, nonce, exp)) }));
    break;
  }
  case "unpause":
    print(await unpause());
    break;
  case "withdraw": {
    if (!a1 || !a2) throw new Error("usage: npm run owner -- withdraw <0x address> <amount in fUSD>");
    const to = getAddress(a1);
    const amount = toBaseUnits(a2, decimals);
    const nonce = newNonce();
    const exp = expiry();
    print(await relay({ fn: "withdraw", to, amount: amount.toString(), nonce: nonce.toString(), expiry: exp.toString(), ownerSig: sign(withdrawMessage(ctx, to, amount, nonce, exp)) }));
    break;
  }
  case "serve": {
    // Only the owner console may drive this signer. Browsers let any page POST to localhost, so the signer checks the
    // Origin header against the console's address and requires the API token in a header (which also forces a CORS
    // preflight that other origins fail).
    const allowedOrigins = new Set([`http://127.0.0.1:${env.consolePort}`, `http://localhost:${env.consolePort}`]);
    const token = env.keeperApiToken;
    if (!token) throw new Error("KEEPER_API_TOKEN is not set; the owner signer refuses to run without it");
    const server = createServer(async (req, res) => {
      const origin = req.headers.origin;
      const originOk = origin === undefined || allowedOrigins.has(origin);
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json",
          ...(origin && originOk
            ? {
                "access-control-allow-origin": origin,
                "access-control-allow-headers": "content-type, authorization",
                "access-control-allow-methods": "GET, POST, OPTIONS",
                vary: "Origin",
              }
            : {}),
        });
        res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      };
      try {
        if (!originOk) return reply(403, { error: "origin not allowed" });
        if (req.method === "OPTIONS") return reply(204, {});
        const parts = new URL(req.url ?? "/", "http://x").pathname.split("/").filter(Boolean);
        if (req.method === "GET" && parts[0] === "health") return reply(200, { ok: true });
        if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "missing or wrong API token" });
        if (req.method === "POST" && (parts[0] === "approve" || parts[0] === "reject") && parts[1]) {
          return reply(200, await approve(parts[1], parts[0] === "approve"));
        }
        if (req.method === "POST" && parts[0] === "unpause") return reply(200, await unpause());
        return reply(404, { error: "not found" });
      } catch (e) {
        return reply(400, { error: (e as Error).message });
      }
    });
    server.listen(env.ownerSignerPort, "127.0.0.1");
    console.log(`Owner signer for the console on http://127.0.0.1:${env.ownerSignerPort}`);
    console.log(`  signs as ${owner.cosmos} (ML-DSA-87), only for the console at ${[...allowedOrigins].join(" or ")}.`);
    console.log(`  Stand-in for QoreX until it supports message signing.`);
    break;
  }
  default:
    console.log("commands: pending | approve <id> | reject <id> | add-payee <0x> <cap> [name] | remove-payee <0x> | set-policy <perTx> <daily> | unpause | withdraw <0x> <amount> | serve");
}
