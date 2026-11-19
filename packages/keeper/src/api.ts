import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { deserializeProposal, toJson, type SerializedProposal } from "@custos/core";
import type { Keeper } from "./keeper";
import type { OwnerOp } from "./types";

export interface ApiOptions {
  port: number;
  host?: string;
  /** When set, every request must send `Authorization: Bearer <token>`. */
  token?: string;
  decimals: number;
  tokenSymbol: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(toJson(body));
}

/**
 * The Keeper's local HTTP API. It binds to 127.0.0.1 by default: the Brain, the Sentinel and the console run
 * on the same machine. Even a caller that reaches it can only ask for payouts the mandate already allows.
 */
export function startApi(keeper: Keeper, opts: ApiOptions): Server {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) throw new HttpError(401, "unauthorized");
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/status") {
        return send(res, 200, { ...(await keeper.status()), decimals: opts.decimals, tokenSymbol: opts.tokenSymbol });
      }
      if (req.method === "GET" && url.pathname === "/activity") {
        return send(res, 200, keeper.activityLog(Number(url.searchParams.get("limit") ?? 100)));
      }
      if (req.method === "GET" && url.pathname === "/approvals") return send(res, 200, keeper.approvals());
      if (req.method === "GET" && url.pathname === "/vendors") {
        return send(res, 200, { decimals: opts.decimals, tokenSymbol: opts.tokenSymbol, vendors: keeper.vendors() });
      }
      if (req.method === "POST" && url.pathname === "/proposals") {
        const body = (await readJson(req)) as SerializedProposal;
        if (!body?.invoiceId || !body?.payee || !body?.amount || !body?.invoiceHash) {
          throw new HttpError(400, "a proposal needs invoiceId, invoiceHash, payee and amount (base units, as a string)");
        }
        let proposal;
        try {
          proposal = deserializeProposal(body);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        return send(res, 200, await keeper.handleProposal(proposal));
      }
      if (req.method === "POST" && parts[0] === "approvals" && parts[2] === "decision" && parts[1]) {
        const body = await readJson(req);
        if (typeof body.approved !== "boolean") throw new HttpError(400, "approved must be true or false");
        try {
          return send(res, 200, await keeper.decideApproval(parts[1], body.approved, body.ownerSignature));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (req.method === "POST" && url.pathname === "/pause") {
        const body = await readJson(req);
        return send(res, 200, await keeper.pause(String(body.reason ?? "requested")));
      }
      if (req.method === "POST" && url.pathname === "/relay") {
        let op: OwnerOp;
        try {
          op = parseOwnerOp(await readJson(req));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        return send(res, 200, await keeper.relayOwnerOp(op));
      }
      if (req.method === "POST" && url.pathname === "/alert") {
        const body = await readJson(req);
        keeper.alert(String(body.detail ?? "alert"));
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: (e as Error).message });
    }
  });
  server.listen(opts.port, opts.host ?? "127.0.0.1");
  return server;
}

const big = (v: unknown, name: string): bigint => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`${name} must be a base-10 integer string`);
  return BigInt(v);
};
const hex = (v: unknown, name: string): `0x${string}` => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`${name} must be hex`);
  return v as `0x${string}`;
};

/** Parse an owner-signed operation from JSON (bigints as strings). */
export function parseOwnerOp(b: any): OwnerOp {
  if (!["setPayee", "setPolicy", "unpause", "withdraw"].includes(b?.fn)) {
    throw new Error("fn must be setPayee, setPolicy, unpause or withdraw");
  }
  const common = { nonce: big(b.nonce, "nonce"), expiry: big(b.expiry, "expiry"), ownerSig: hex(b.ownerSig, "ownerSig") };
  switch (b?.fn) {
    case "setPayee":
      return { fn: "setPayee", who: hex(b.who, "who"), allowed: Boolean(b.allowed), cap: big(b.cap, "cap"), ...common };
    case "setPolicy":
      return { fn: "setPolicy", perTxCap: big(b.perTxCap, "perTxCap"), dailyCap: big(b.dailyCap, "dailyCap"), ...common };
    case "unpause":
      return { fn: "unpause", ...common };
    case "withdraw":
      return { fn: "withdraw", to: hex(b.to, "to"), amount: big(b.amount, "amount"), ...common };
    default:
      throw new Error("fn must be setPayee, setPolicy, unpause or withdraw");
  }
}
