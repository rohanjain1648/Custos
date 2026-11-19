import { useCallback, useEffect, useState } from "react";
import {
  addressUrl,
  formatAmount,
  keeper,
  ownerDecision,
  ownerSignerOnline,
  ownerUnpause,
  short,
  txUrl,
  type Activity,
  type Approval,
  type Status,
  type Vendors,
} from "./api";

type LockState = "held" | "open" | "breach" | "off";

interface Lock {
  n: number;
  name: string;
  state: LockState;
  stateLabel: string;
  detail: string;
}

const KIND_LABEL: Record<string, string> = {
  paid: "Paid",
  approval_requested: "Sent to you",
  approval_executed: "You approved; paid",
  approval_rejected: "You refused",
  rejected: "Refused by the mandate",
  window_opened: "Window opened",
  window_closed: "Window closed",
  topped_up: "Vault topped up",
  paused: "Vault paused",
  dry_run: "Dry run",
  recovered: "Recovered",
  alert: "Alert",
  relayed: "Owner action relayed",
  error: "Error",
};

function useKeeper() {
  const [status, setStatus] = useState<Status | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [vendors, setVendors] = useState<Vendors | null>(null);
  const [signer, setSigner] = useState(false);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, a, p, v] = await Promise.all([keeper.status(), keeper.activity(), keeper.approvals(), keeper.vendors()]);
      setStatus(s);
      setActivity(a);
      setApprovals(p);
      setVendors(v);
      setOffline(false);
    } catch {
      setOffline(true);
    }
    setSigner(await ownerSignerOnline());
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return { status, activity, approvals, vendors, signer, offline, refresh };
}

function locksFor(s: Status, vendorCount: number): Lock[] {
  const fmt = (v: string) => `${formatAmount(v, s.decimals)} ${s.tokenSymbol}`;
  const vs = s.vaultStatus && !("error" in s.vaultStatus) ? s.vaultStatus : null;
  const w = "error" in s.window ? null : s.window;
  const vault = s.vault?.toLowerCase();
  const scopedToVault = w ? !w.nativeOnly && w.allowedTargets.length === 1 && w.allowedTargets[0].toLowerCase() === vault : false;

  const lock1: Lock = !s.vault
    ? { n: 4, name: "Vault mandate", state: "off", stateLabel: "Not deployed", detail: "Run npm run setup:testnet to deploy the vault." }
    : !vs
      ? { n: 4, name: "Vault mandate", state: "off", stateLabel: "Unreadable", detail: "The vault could not be read from testnet just now." }
      : vs.paused
        ? { n: 4, name: "Vault mandate", state: "breach", stateLabel: "Paused", detail: "Nothing leaves the vault until you unpause it with your ML-DSA-87 key." }
        : {
            n: 4,
            name: "Vault mandate",
            state: "held",
            stateLabel: "Holding",
            detail: `Pays only ${vendorCount} allowlisted payees, at most ${fmt(vs.perTxCap)} a payment and ${fmt(vs.dailyCap)} a day. ${fmt(vs.remainingToday)} left today.`,
          };

  const lock2: Lock = s.topUp?.linkedKey
    ? {
        n: 1,
        name: "Treasury rules",
        state: "held",
        stateLabel: "Set",
        detail: `Linked key ${short(s.topUp.linkedKey)} may only call the vault's topUp, within per-payment and daily limits.`,
      }
    : { n: 1, name: "Treasury rules", state: "off", stateLabel: "Off", detail: "No linked key: the vault is refilled by hand from the treasury." };

  const lock3: Lock = !w
    ? { n: 2, name: "Agent window", state: "off", stateLabel: "Unreadable", detail: "The agent's EVM window could not be read." }
    : !w.live
      ? { n: 2, name: "Agent window", state: "held", stateLabel: "Closed", detail: "The agent's ECDSA key cannot send any EVM transaction right now." }
      : scopedToVault && s.pending
        ? {
            n: 2,
            name: "Agent window",
            state: "open",
            stateLabel: "Open for one payout",
            detail: `Scoped to the vault only, ${w.remainingTxs} transaction left, for invoice ${s.pending.invoiceId}.`,
          }
        : {
            n: 2,
            name: "Agent window",
            state: "breach",
            stateLabel: scopedToVault ? "Open, nothing in flight" : "Open beyond the vault",
            detail: scopedToVault ? "A window is open with no payout in flight. The Sentinel closes it." : `Targets: ${w.nativeOnly ? "native transfers" : w.allowedTargets.join(", ") || "anything"}.`,
          };

  const lock4: Lock = s.vault
    ? {
        n: 3,
        name: "Post-quantum signature",
        state: "held",
        stateLabel: "Required",
        detail: `Every payout needs an ML-DSA-87 signature the vault checks on-chain with pqcVerify. Agent key ${s.agent.pqKeyFingerprint.slice(0, 16)}.`,
      }
    : { n: 3, name: "Post-quantum signature", state: "off", stateLabel: "Not deployed", detail: "Checked by the vault once it is deployed." };

  // In the order money meets them: refill, the agent's window, the signature check, the vault's own mandate.
  return [lock2, lock3, lock4, lock1];
}

function MoneyPath({ status, vendorCount }: { status: Status; vendorCount: number }) {
  const locks = locksFor(status, vendorCount);
  return (
    <section className="path" aria-labelledby="path-title">
      <h2 id="path-title" className="visually-hidden">
        The four locks on the money path
      </h2>
      <ol className="path-track">
        <li className="path-end">
          <span className="path-end-name">Treasury</span>
          <span className="path-end-note">{status.topUp?.treasury ? short(status.topUp.treasury) : "owner account"}</span>
        </li>
        {locks.map((l) => (
          <li key={l.n} className={`lock lock-${l.state}`}>
            <span className="lock-mark" aria-hidden="true">
              {l.n}
            </span>
            <span className="lock-name">
              Lock {l.n}: {l.name}
            </span>
            <span className="lock-state">{l.stateLabel}</span>
            <span className="lock-detail">{l.detail}</span>
          </li>
        ))}
        <li className="path-end">
          <span className="path-end-name">Payee</span>
          <span className="path-end-note">allowlisted vendors</span>
        </li>
      </ol>
    </section>
  );
}

function Approvals({ items, status, signer, onDone }: { items: Approval[]; status: Status; signer: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = items.filter((a) => a.status === "pending");

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError(null);
    try {
      const r = await ownerDecision(id, approve);
      if (r.status === "failed") setError(`Approval signed, but the payout failed: ${r.error ?? "unknown error"}`);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
    onDone();
  }

  return (
    <section className="column" aria-labelledby="approvals-title">
      <h2 id="approvals-title">Waiting for you</h2>
      {!signer && pending.length > 0 && (
        <p className="note">
          To sign from here, start the owner signer with <code>npm run owner -- serve</code>. You can also run <code>npm run owner -- approve &lt;id&gt;</code>.
        </p>
      )}
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {pending.length === 0 ? (
        <p className="empty">Nothing needs your signature. Payments inside the mandate are paid without you.</p>
      ) : (
        <ul className="approvals">
          {pending.map((a) => (
            <li key={a.id} className="approval">
              <div className="approval-head">
                <span className="approval-vendor">{a.vendorName ?? short(a.payee)}</span>
                <span className="amount">
                  {formatAmount(a.amount, status.decimals)} <span className="unit">{status.tokenSymbol}</span>
                </span>
              </div>
              <p className="approval-meta">
                Invoice {a.invoiceId}, to{" "}
                <a href={addressUrl(a.payee)} target="_blank" rel="noreferrer">
                  {short(a.payee)}
                </a>
              </p>
              <ul className="reasons">
                {a.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="actions">
                <button className="btn btn-primary" disabled={!signer || busy !== null} onClick={() => decide(a.id, true)}>
                  {busy === a.id ? "Signing…" : "Approve and pay"}
                </button>
                <button className="btn" disabled={!signer || busy !== null} onClick={() => decide(a.id, false)}>
                  Refuse
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Ledger({ items, status }: { items: Activity[]; status: Status }) {
  return (
    <section className="column" aria-labelledby="ledger-title">
      <h2 id="ledger-title">Ledger</h2>
      {items.length === 0 ? (
        <p className="empty">No activity yet. Drop an invoice in invoices/inbox and run npm run brain.</p>
      ) : (
        <ol className="ledger">
          {items.map((a) => (
            <li key={a.id} className={`entry entry-${a.kind}`}>
              <time dateTime={a.at}>{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</time>
              <div className="entry-body">
                <span className="entry-kind">{KIND_LABEL[a.kind] ?? a.kind.replace(/_/g, " ")}</span>
                {(a.invoiceId || a.vendorName) && (
                  <span className="entry-what">
                    {[a.invoiceId, a.vendorName].filter(Boolean).join(", ")}
                    {a.amount && ` for ${formatAmount(a.amount, status.decimals)} ${status.tokenSymbol}`}
                  </span>
                )}
                {a.reasons && a.reasons.length > 0 && <span className="entry-detail">{a.reasons.join("; ")}</span>}
                {a.detail && <span className="entry-detail">{a.detail}</span>}
                {a.txHash && (
                  <a className="entry-tx" href={txUrl(a.txHash)} target="_blank" rel="noreferrer">
                    View transaction {short(a.txHash)}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PausedBanner({ signer, onDone }: { signer: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function unpause() {
    setBusy(true);
    try {
      const r = await ownerUnpause();
      setResult(r.simulated ? "Dry run: the vault would accept your unpause. Nothing was broadcast." : r.ok ? "Unpause sent." : `Unpause failed: ${r.error}`);
    } catch (e) {
      setResult((e as Error).message);
    }
    setBusy(false);
    onDone();
  }

  return (
    <div className="alarm" role="status">
      <span>The vault is paused. Only your ML-DSA-87 key can unpause it.</span>
      {signer ? (
        <button className="btn" disabled={busy} onClick={unpause}>
          {busy ? "Signing…" : "Unpause the vault"}
        </button>
      ) : (
        <code>npm run owner -- unpause</code>
      )}
      {result && <span className="alarm-result">{result}</span>}
    </div>
  );
}

function headline(s: Status, pending: number): string {
  const vs = s.vaultStatus && !("error" in s.vaultStatus) ? s.vaultStatus : null;
  const guarding = vs ? `Custos is guarding ${formatAmount(vs.balance, s.decimals)} ${s.tokenSymbol}.` : "Custos is running without a vault.";
  if (vs?.paused) return `${guarding} The vault is paused.`;
  if (pending === 1) return `${guarding} One payment waits for you.`;
  if (pending > 1) return `${guarding} ${pending} payments wait for you.`;
  return `${guarding} Nothing waits for you.`;
}

export function App() {
  const { status, activity, approvals, vendors, signer, offline, refresh } = useKeeper();

  if (!status) {
    return (
      <main className="shell">
        <header className="top">
          <h1 className="wordmark">Custos</h1>
        </header>
        <p className="lead">{offline ? `The Keeper is not answering at ${__KEEPER_URL__}. Start it with npm run keeper.` : "Connecting to the Keeper…"}</p>
      </main>
    );
  }

  const pending = approvals.filter((a) => a.status === "pending").length;
  const vs = status.vaultStatus && !("error" in status.vaultStatus) ? status.vaultStatus : null;
  const unrecorded = status.evmNonce !== null && status.expectedNonce !== null && !status.pending && status.evmNonce > status.expectedNonce;

  return (
    <main className="shell">
      <header className="top">
        <h1 className="wordmark">Custos</h1>
        <p className="top-meta">
          <span className={`mode mode-${status.mode}`}>{status.mode === "live" ? "Live on testnet" : "Dry run: nothing is broadcast"}</span>
          <span>
            Agent{" "}
            <a href={addressUrl(status.agent.evm)} target="_blank" rel="noreferrer">
              {short(status.agent.evm)}
            </a>
          </span>
          {offline && <span className="stale">Keeper not answering; showing the last reading</span>}
        </p>
      </header>

      <p className="lead">{headline(status, pending)}</p>

      {unrecorded && (
        <p className="alarm" role="alert">
          The agent account sent {status.evmNonce! - status.expectedNonce!} {status.evmNonce! - status.expectedNonce! === 1 ? "transaction" : "transactions"} the
          Keeper did not record. Treat the agent's ECDSA key as stolen.
        </p>
      )}
      {vs?.paused && <PausedBanner signer={signer} onDone={refresh} />}

      <MoneyPath status={status} vendorCount={vendors?.vendors.length ?? 0} />

      <div className="columns">
        <Approvals items={approvals} status={status} signer={signer} onDone={refresh} />
        <Ledger items={activity} status={status} />
      </div>

      <footer className="foot">
        <p>
          Approvals are signed with your ML-DSA-87 key by the local owner signer, which stands in for QoreX until QoreX supports message signing. The vault
          checks every signature on-chain.
        </p>
        {vs && (
          <p>
            {status.paidInvoices} invoices paid, {formatAmount(vs.totalPaid, status.decimals)} {status.tokenSymbol} in total. Vault{" "}
            <a href={addressUrl(status.vault!)} target="_blank" rel="noreferrer">
              {short(status.vault)}
            </a>
            .
          </p>
        )}
      </footer>
    </main>
  );
}
