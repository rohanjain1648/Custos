import type { ChainAdapter, TxOutcome } from "@custos/keeper";
import { assess, type Finding } from "./assess";

export interface KeeperView {
  /** Expected nonce and in-flight state, as the Keeper reports them. */
  status(): Promise<{ expectedNonce: number | null; pending: unknown | null }>;
  alert(detail: string): Promise<void>;
}

export interface SentinelOptions {
  adapter: ChainAdapter;
  keeper: KeeperView;
  /** Pause the vault with the agent's ML-DSA-87 key. */
  pauseVault: (reason: string) => Promise<TxOutcome>;
  /** Observe only; never act. */
  watchOnly?: boolean;
  log?: (line: string) => void;
}

export interface TickResult {
  findings: Finding[];
  actions: string[];
}

/**
 * The Sentinel watches the agent account from outside the Keeper. On anything the Keeper did not do, it closes the
 * window, pauses the vault and raises an alert. It needs no new authority: closing the window and pausing are both
 * things the agent's own keys may do, and only the owner can unpause.
 */
export class Sentinel {
  private ownBaseline: number | null = null;

  constructor(private readonly o: SentinelOptions) {}

  async tick(): Promise<TickResult> {
    const a = this.o.adapter;
    const [keeper, evmNonce, window, vaultStatus] = await Promise.all([
      this.o.keeper.status(),
      a.getEvmNonce(),
      a.getWindow(),
      a.vault ? a.readVaultStatus().catch(() => null) : Promise.resolve(null),
    ]);
    const candidates = [keeper.expectedNonce, this.ownBaseline].filter((n): n is number => n !== null);
    const expectedNonce = candidates.length ? Math.max(...candidates) : null;
    const findings = assess({
      evmNonce,
      expectedNonce,
      window,
      keeperBusy: keeper.pending !== null && keeper.pending !== undefined,
      vault: a.vault,
      paused: vaultStatus?.paused ?? false,
    });
    const actions: string[] = [];
    if (findings.length === 0 || this.o.watchOnly) return { findings, actions };

    const summary = findings.map((f) => f.detail).join("; ");
    this.o.log?.(`[sentinel] ALERT: ${summary}`);
    await this.o.keeper.alert(`Sentinel: ${summary}`).catch(() => undefined);

    if (window.live) {
      const closed = await a.closeWindow();
      actions.push(closed.ok ? `closed the window (${closed.hash})` : `could not close the window: ${closed.error}`);
    }
    const serious = findings.some((f) => f.kind === "unexpected_nonce" || f.kind === "foreign_window");
    if (serious && a.vault && !(vaultStatus?.paused ?? false)) {
      const paused = await this.o.pauseVault(summary);
      actions.push(paused.ok ? `paused the vault${paused.hash ? ` (${paused.hash})` : ""}` : `could not pause: ${paused.error}`);
    }
    this.ownBaseline = await a.getEvmNonce();
    for (const action of actions) this.o.log?.(`[sentinel] ${action}`);
    return { findings, actions };
  }
}
