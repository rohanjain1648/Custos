// Types mirror the Keeper's JSON (bigints arrive as decimal strings).
export interface Status {
  mode: "dry-run" | "live";
  agent: { evm: string; cosmos: string; pqKeyFingerprint: string };
  vault: string | null;
  token: string;
  decimals: number;
  tokenSymbol: string;
  vaultStatus:
    | null
    | { error: string }
    | { paused: boolean; perTxCap: string; dailyCap: string; remainingToday: string; balance: string; totalPaid: string; paymentCount: string };
  window:
    | { error: string }
    | { found: boolean; live: boolean; remainingTxs: string; remainingBlocks: string; allowedTargets: string[]; nativeOnly: boolean };
  evmNonce: number | null;
  expectedNonce: number | null;
  pending: { invoiceId: string; stage: string } | null;
  pendingApprovals: number;
  paidInvoices: number;
  topUp: { treasury?: string; linkedKey?: string } | null;
}

export interface Activity {
  id: string;
  at: string;
  kind: string;
  invoiceId?: string;
  vendorName?: string;
  payee?: string;
  amount?: string;
  txHash?: string;
  reasons?: string[];
  detail?: string;
}

export interface Approval {
  id: string;
  createdAt: string;
  status: "pending" | "rejected" | "executed" | "failed";
  invoiceId: string;
  vendorName?: string;
  payee: string;
  amount: string;
  reasons: string[];
  txHash?: string;
  error?: string;
}

export interface Vendors {
  decimals: number;
  tokenSymbol: string;
  vendors: { name: string; address: string; cap: string }[];
}

const headers: Record<string, string> = { "content-type": "application/json" };
if (__KEEPER_TOKEN__) headers.authorization = `Bearer ${__KEEPER_TOKEN__}`;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${__KEEPER_URL__}${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const keeper = {
  status: () => get<Status>("/status"),
  activity: () => get<Activity[]>("/activity?limit=40"),
  approvals: () => get<Approval[]>("/approvals"),
  vendors: () => get<Vendors>("/vendors"),
};

/** The local owner signer (`npm run owner -- serve`), standing in for QoreX until it supports message signing. */
export async function ownerDecision(id: string, approve: boolean): Promise<Approval> {
  const r = await fetch(`${__OWNER_SIGNER_URL__}/${approve ? "approve" : "reject"}/${id}`, { method: "POST", headers });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `owner signer answered ${r.status}`);
  return body as Approval;
}

export async function ownerUnpause(): Promise<{ ok: boolean; hash?: string; error?: string; simulated?: boolean }> {
  const r = await fetch(`${__OWNER_SIGNER_URL__}/unpause`, { method: "POST", headers });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `owner signer answered ${r.status}`);
  return body;
}

export async function ownerSignerOnline(): Promise<boolean> {
  try {
    const r = await fetch(`${__OWNER_SIGNER_URL__}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export function formatAmount(base: string | undefined, decimals: number): string {
  if (base === undefined) return "";
  const v = BigInt(base);
  const unit = 10n ** BigInt(decimals);
  const whole = (v / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (v % unit).toString().padStart(decimals, "0").slice(0, 2).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export const short = (hex: string | undefined | null) => (hex ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : "");
export const txUrl = (hash: string) => `https://explore.qore.network/tx/${hash}`;
export const addressUrl = (addr: string) => `https://explore.qore.network/address/${addr}`;
