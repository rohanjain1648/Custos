import { existsSync } from "node:fs";
import path from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { TESTNET, ZERO_ADDRESS } from "@custos/core";

/** The public Hardhat/Foundry test mnemonic: only ever used in dry-run when no AGENT_MNEMONIC is set. */
export const PUBLIC_TEST_MNEMONIC = "test test test test test test test test test test test junk";

export interface CustosEnv {
  root: string;
  dataDir: string;
  mandatePath: string;
  dryRun: boolean;
  agentMnemonic: string;
  agentMnemonicIsPublic: boolean;
  ownerMnemonic?: string;
  ownerCosmos?: string;
  linkedKeyPrivateKey?: Hex;
  vault: Address | null;
  token: Address;
  keeperPort: number;
  keeperApiToken?: string;
  keeperUrl: string;
  ownerSignerPort: number;
  /** Port of the owner console dev server; the owner signer accepts requests only from it. */
  consolePort: number;
  topUpAmount?: string;
  anthropicModel: string;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Load .env from the repository root (Node's built-in loader) and resolve Custos settings. */
export function loadCustosEnv(root = process.cwd()): CustosEnv {
  const envFile = path.join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const e = process.env;

  const dryRun = bool(e.KEEPER_DRY_RUN, true);
  const agentMnemonic = e.AGENT_MNEMONIC?.trim() || (dryRun ? PUBLIC_TEST_MNEMONIC : "");
  if (!agentMnemonic) throw new Error("AGENT_MNEMONIC is required in live mode (run `npm run keys`)");

  const tokenSetting = (e.VAULT_TOKEN ?? TESTNET.fusd.address).trim();
  const token = /^(native|qor|0x0{40})$/i.test(tokenSetting) ? ZERO_ADDRESS : getAddress(tokenSetting);
  const keeperPort = Number(e.KEEPER_PORT ?? 8787);

  return {
    root,
    dataDir: path.resolve(root, e.CUSTOS_DATA_DIR ?? "data"),
    mandatePath: path.resolve(root, e.CUSTOS_MANDATE ?? "custos.mandate.json"),
    dryRun,
    agentMnemonic,
    agentMnemonicIsPublic: agentMnemonic === PUBLIC_TEST_MNEMONIC,
    ownerMnemonic: e.OWNER_MNEMONIC?.trim() || undefined,
    ownerCosmos: e.OWNER_COSMOS_ADDRESS?.trim() || undefined,
    linkedKeyPrivateKey: (e.LINKED_KEY_PRIVATE_KEY?.trim() || undefined) as Hex | undefined,
    vault: e.VAULT_ADDRESS?.trim() ? getAddress(e.VAULT_ADDRESS.trim()) : null,
    token,
    keeperPort,
    keeperApiToken: e.KEEPER_API_TOKEN?.trim() || undefined,
    keeperUrl: e.KEEPER_URL?.trim() || `http://127.0.0.1:${keeperPort}`,
    ownerSignerPort: Number(e.OWNER_SIGNER_PORT ?? 8788),
    consolePort: Number(e.CONSOLE_PORT ?? 5173),
    topUpAmount: e.TOP_UP_AMOUNT?.trim() || undefined,
    anthropicModel: e.CUSTOS_MODEL?.trim() || "claude-opus-5-5",
  };
}
