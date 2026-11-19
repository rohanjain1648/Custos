import { getAddress, type Address } from "viem";
import { z } from "zod";
import { toBaseUnits } from "./amounts";
import { TESTNET } from "./config";
import type { Mandate } from "./types";

const PayeeEntry = z.object({
  name: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  cap: z.string(),
  aliases: z.array(z.string()).optional(),
});

export const MandateFile = z.object({
  token: z.enum(["fUSD", "QOR"]),
  perTxCap: z.string(),
  dailyCap: z.string(),
  payees: z.array(PayeeEntry),
});
export type MandateFile = z.infer<typeof MandateFile>;

export interface VendorEntry {
  name: string;
  address: Address;
  cap: bigint;
  aliases: string[];
}

export interface LoadedMandate {
  token: "fUSD" | "QOR";
  decimals: number;
  mandate: Mandate;
  vendors: VendorEntry[];
}

export function tokenDecimals(token: "fUSD" | "QOR"): number {
  return token === "fUSD" ? TESTNET.fusd.decimals : 18;
}

/** Parse custos.mandate.json into exact base units. Throws on any malformed amount or address. */
export function parseMandateFile(json: unknown): LoadedMandate {
  const file = MandateFile.parse(json);
  const decimals = tokenDecimals(file.token);
  const vendors: VendorEntry[] = file.payees.map((p) => ({
    name: p.name,
    address: getAddress(p.address),
    cap: toBaseUnits(p.cap, decimals),
    aliases: p.aliases ?? [],
  }));
  const payees: Mandate["payees"] = {};
  for (const v of vendors) payees[v.address.toLowerCase()] = { allowed: true, cap: v.cap, name: v.name };
  return {
    token: file.token,
    decimals,
    vendors,
    mandate: {
      perTxCap: toBaseUnits(file.perTxCap, decimals),
      dailyCap: toBaseUnits(file.dailyCap, decimals),
      paused: false,
      payees,
    },
  };
}
