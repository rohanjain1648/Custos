import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SerializedIntent } from "@custos/core";

export type ActivityKind =
  | "paid"
  | "approval_requested"
  | "approval_executed"
  | "approval_rejected"
  | "rejected"
  | "window_opened"
  | "window_closed"
  | "topped_up"
  | "paused"
  | "dry_run"
  | "recovered"
  | "alert"
  | "relayed"
  | "error";

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  invoiceId?: string;
  vendorName?: string;
  payee?: string;
  amount?: string;
  txHash?: string;
  reasons?: string[];
  detail?: string;
}

export interface ApprovalRecord {
  id: string;
  createdAt: string;
  status: "pending" | "rejected" | "executed" | "failed";
  invoiceId: string;
  vendorName?: string;
  payee: string;
  amount: string;
  invoiceHash: string;
  reasons: string[];
  intent: SerializedIntent;
  agentSig: string;
  /** Hex of the bytes the owner signs (approvedPayMessage). */
  ownerMessage: string;
  txHash?: string;
  error?: string;
}

export interface PendingPayment {
  invoiceId: string;
  invoiceHash: string;
  startedAt: string;
  stage: "signed" | "window_open" | "sent";
  txHash?: string;
}

export interface KeeperState {
  activity: ActivityItem[];
  approvals: ApprovalRecord[];
  /** Lowercase invoice hashes that are paid (or were processed in dry-run). */
  paidInvoices: string[];
  pending: PendingPayment | null;
  /** The agent's EVM nonce after the Keeper's last transaction; the Sentinel compares against it. */
  expectedNonce: number | null;
}

export interface Store {
  read(): KeeperState;
  update(fn: (s: KeeperState) => void): KeeperState;
}

const MAX_ACTIVITY = 500;

export function emptyState(): KeeperState {
  return { activity: [], approvals: [], paidInvoices: [], pending: null, expectedNonce: null };
}

function trim(s: KeeperState): KeeperState {
  if (s.activity.length > MAX_ACTIVITY) s.activity = s.activity.slice(-MAX_ACTIVITY);
  return s;
}

export class MemoryStore implements Store {
  private state: KeeperState;
  constructor(initial: KeeperState = emptyState()) {
    this.state = structuredClone(initial);
  }
  read(): KeeperState {
    return structuredClone(this.state);
  }
  update(fn: (s: KeeperState) => void): KeeperState {
    fn(this.state);
    trim(this.state);
    return this.read();
  }
}

/** JSON file store with atomic replace, so a crash never leaves a half-written state file. */
export class FileStore implements Store {
  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) this.write(emptyState());
  }
  read(): KeeperState {
    return { ...emptyState(), ...JSON.parse(readFileSync(this.file, "utf8")) };
  }
  update(fn: (s: KeeperState) => void): KeeperState {
    const s = this.read();
    fn(s);
    this.write(trim(s));
    return s;
  }
  private write(s: KeeperState): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}
