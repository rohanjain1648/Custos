import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";
import { invoiceHash, toBaseUnits, type VendorEntry } from "@custos/core";
import { analyzeWithClaude, type Analysis, type ClaudeOptions } from "./claude";
import { loadInvoices, type LoadedInvoice } from "./invoices";
import type { KeeperLike } from "./keeper-client";
import { extractFields, fraudSignals, matchVendor } from "./signals";

export interface BrainOptions {
  inboxDir: string;
  statePath: string;
  keeper: KeeperLike;
  mode: "claude" | "offline";
  claude?: ClaudeOptions;
  log?: (line: string) => void;
}

export interface InvoiceReport {
  file: string;
  invoiceId: string | null;
  vendor: string | null;
  amount: string | null;
  outcome: string;
  flags: string[];
  detail?: string;
}

interface BrainState {
  processed: Record<string, string>;
}

function readState(file: string): BrainState {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { processed: {} };
}

function writeState(file: string, s: BrainState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}

function offlineAnalysis(invoice: LoadedInvoice): Analysis | null {
  const f = extractFields(invoice.text);
  if (!f.invoiceNumber || !f.amountText || !f.payTo) return null;
  return {
    action: "propose",
    vendorName: f.vendorName ?? "",
    invoiceNumber: f.invoiceNumber,
    payTo: f.payTo,
    amountText: f.amountText,
    currency: f.currency ?? "",
    dueDate: f.dueDate ?? "",
    reason: `invoice ${f.invoiceNumber} from ${f.vendorName ?? "an unknown vendor"}`,
    fraudSignals: [],
  };
}

/**
 * Read every new invoice, turn it into a proposal, and hand it to the Keeper. The Brain has no keys and no way to
 * pay: the Keeper and the vault decide. Code-level fraud signals are merged into every proposal.
 */
export async function processInbox(o: BrainOptions): Promise<InvoiceReport[]> {
  const log = o.log ?? (() => undefined);
  const { decimals, tokenSymbol, vendors: raw } = await o.keeper.vendors();
  const vendors: VendorEntry[] = raw.map((v) => ({ ...v, cap: BigInt(v.cap) }));
  const state = readState(o.statePath);
  const reports: InvoiceReport[] = [];

  for (const inv of loadInvoices(o.inboxDir)) {
    if (state.processed[inv.file] === inv.digest) continue;
    const report: InvoiceReport = { file: inv.file, invoiceId: null, vendor: null, amount: null, outcome: "skipped", flags: [] };
    try {
      let analysis: Analysis | null;
      let note = "offline extraction";
      if (o.mode === "claude") {
        const r = await analyzeWithClaude(inv, vendors, tokenSymbol, o.claude!);
        analysis = r.analysis;
        note = r.note;
      } else {
        analysis = offlineAnalysis(inv);
      }
      if (!analysis || analysis.action === "skip") {
        report.detail = analysis ? `skipped: ${analysis.reason}` : `could not read the invoice (${note})`;
        reports.push(report);
        continue;
      }
      if (analysis.currency.toLowerCase() !== tokenSymbol.toLowerCase()) {
        report.detail = `currency "${analysis.currency}" is not the vault's ${tokenSymbol}`;
        reports.push(report);
        continue;
      }
      if (!isAddress(analysis.payTo, { strict: false })) {
        report.detail = `"${analysis.payTo}" is not an address`;
        reports.push(report);
        continue;
      }
      const amount = toBaseUnits(analysis.amountText, decimals);
      const payee = getAddress(analysis.payTo);
      const fields = extractFields(inv.text);
      const vendor = matchVendor(analysis.vendorName || fields.vendorName, vendors);
      const codeSignals = fraudSignals(inv.text, { ...fields, payTo: payee }, vendor, amount);
      const flags = [...new Set([...analysis.fraudSignals, ...codeSignals])];

      report.invoiceId = analysis.invoiceNumber;
      report.vendor = vendor?.name ?? analysis.vendorName;
      report.amount = `${analysis.amountText} ${tokenSymbol}`;
      report.flags = flags;

      const result = await o.keeper.propose({
        invoiceId: analysis.invoiceNumber,
        invoiceHash: invoiceHash(analysis.invoiceNumber, payee, amount),
        payee,
        amount: amount.toString(),
        vendorName: report.vendor ?? undefined,
        reason: analysis.reason,
        flags,
      });
      report.outcome = result.status;
      report.detail = [note, typeof result.txHash === "string" ? `tx ${result.txHash}` : "", Array.isArray(result.reasons) ? result.reasons.join("; ") : ""]
        .filter(Boolean)
        .join(" | ");
      log(`[brain] ${inv.file}: ${report.outcome}${flags.length ? ` (flags: ${flags.join("; ")})` : ""}`);
    } catch (e) {
      report.outcome = "error";
      report.detail = (e as Error).message;
    }
    state.processed[inv.file] = inv.digest;
    writeState(o.statePath, state);
    reports.push(report);
  }
  return reports;
}
