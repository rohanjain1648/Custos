import type { SerializedProposal, VendorEntry } from "@custos/core";

export interface VendorsResponse {
  decimals: number;
  tokenSymbol: string;
  vendors: (Omit<VendorEntry, "cap"> & { cap: string })[];
}

export interface KeeperLike {
  vendors(): Promise<VendorsResponse>;
  propose(p: SerializedProposal): Promise<{ status: string; [k: string]: unknown }>;
  status?(): Promise<Record<string, unknown>>;
}

/** Thin client for the Keeper's local HTTP API. */
export class KeeperClient implements KeeperLike {
  constructor(
    private readonly base: string,
    private readonly token?: string,
  ) {}

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(`Keeper ${method} ${path}: ${json.error ?? r.status}`);
    return json;
  }

  vendors() {
    return this.req<VendorsResponse>("GET", "/vendors");
  }
  propose(p: SerializedProposal) {
    return this.req<{ status: string }>("POST", "/proposals", p);
  }
  status() {
    return this.req<Record<string, unknown>>("GET", "/status");
  }
}
