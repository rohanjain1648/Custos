import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  closeEvmWindowMsg,
  deriveUnifiedAccount,
  evmAuthSignBytes,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  fetchEvmWindow,
  openEvmWindowMsg,
  resolveEvmAuthDigestVersion,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { qorechainTestnet } from "@qorechain/evm";
import { classifyEvmWindowRejection, evmWindowCost } from "@qorechain/evm/window";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { custosVaultAbi, TESTNET, WINDOW_PROFILE, type NetworkConfig } from "@custos/core";
import { vaultCallArgs, type ChainAdapter, type TxOutcome, type VaultCall, type VaultStatus, type WindowState } from "./types";
import { errMsg } from "./keeper";

const PQC_VERIFY_ABI = [
  {
    type: "function",
    name: "pqcVerify",
    stateMutability: "view",
    inputs: [
      { name: "pubkey", type: "bytes" },
      { name: "signature", type: "bytes" },
      { name: "message", type: "bytes" },
    ],
    outputs: [{ name: "valid", type: "bool" }],
  },
] as const;

export interface RealChainConfig {
  agentMnemonic: string;
  vault: Address | null;
  token: Address;
  /** The treasury (owner) account the linked key spends from, `qor1…`. */
  treasuryCosmos?: string;
  /** Secret key of the linked (authenticator) secp256k1 key; never the agent's own key. */
  linkedKeyPrivateKey?: Hex;
  network?: NetworkConfig;
}

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

function vaultCallData(call: VaultCall): Hex {
  const { functionName, args } = vaultCallArgs(call);
  return encodeFunctionData({ abi: custosVaultAbi, functionName, args } as never);
}

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      const args = revert.data.args?.map((a) => String(a)).join(", ") ?? "";
      return `${revert.data.errorName}(${args})`;
    }
  }
  return errMsg(e);
}

/** ChainAdapter backed by the QoreChain SDK (Cosmos lane, hybrid-signed) and viem (EVM lane). */
export class RealChainAdapter implements ChainAdapter {
  readonly agentEvm: Address;
  readonly agentCosmos: string;
  readonly vault: Address | null;
  readonly token: Address;
  private readonly net: NetworkConfig;
  private readonly publicClient;
  private readonly wallet;
  private readonly evmAccount: PrivateKeyAccount;
  private readonly cosmosSigner: EthNativeSigner;
  private readonly linked?: PrivateKeyAccount;
  private transportPromise?: Promise<StargateClient>;
  private fees?: Fees;
  private digestVersion?: "v1" | "v2";

  private constructor(
    private readonly cfg: RealChainConfig,
    readonly agent: UnifiedAccount,
  ) {
    this.net = cfg.network ?? TESTNET;
    this.agentEvm = agent.evm as Address;
    this.agentCosmos = agent.cosmos;
    this.vault = cfg.vault;
    this.token = cfg.token;
    this.publicClient = createPublicClient({ chain: qorechainTestnet, transport: http(this.net.evmRpc) });
    this.evmAccount = privateKeyToAccount(agent.privateKey as Hex);
    this.wallet = createWalletClient({ chain: qorechainTestnet, transport: http(this.net.evmRpc), account: this.evmAccount });
    this.cosmosSigner = new EthNativeSigner(agent, { rest: this.net.rest });
    if (cfg.linkedKeyPrivateKey) this.linked = privateKeyToAccount(cfg.linkedKeyPrivateKey);
  }

  static async create(cfg: RealChainConfig): Promise<RealChainAdapter> {
    return new RealChainAdapter(cfg, await deriveUnifiedAccount(cfg.agentMnemonic));
  }

  /** The agent's canonical ML-DSA-87 key pair (the one registered on chain for the agent account). */
  get agentPqKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
    return this.agent.pqc;
  }

  get linkedKeyAddress(): Address | undefined {
    return this.linked?.address;
  }

  // ------------------------------------------------------------------- vault reads

  private requireVault(): Address {
    if (!this.vault) throw new Error("VAULT_ADDRESS is not set");
    return this.vault;
  }

  async readVaultStatus(): Promise<VaultStatus> {
    const [paused, perTxCap, dailyCap, remainingToday, balance, totalPaid, paymentCount] =
      await this.publicClient.readContract({ address: this.requireVault(), abi: custosVaultAbi, functionName: "status" });
    return { paused, perTxCap, dailyCap, remainingToday, balance, totalPaid, paymentCount };
  }

  async readPayee(who: Address): Promise<{ allowed: boolean; cap: bigint }> {
    const [allowed, cap] = await this.publicClient.readContract({
      address: this.requireVault(),
      abi: custosVaultAbi,
      functionName: "payees",
      args: [who],
    });
    return { allowed, cap };
  }

  async isInvoicePaid(invoiceHash: Hex): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.requireVault(),
      abi: custosVaultAbi,
      functionName: "invoicePaid",
      args: [invoiceHash],
    });
  }

  // ------------------------------------------------------------------- the window

  async getWindow(): Promise<WindowState> {
    const w = await fetchEvmWindow({ rest: this.net.rest, address: this.agentCosmos });
    return {
      found: w.found,
      live: w.live,
      remainingTxs: BigInt(w.remainingTxs ?? 0),
      remainingValue: BigInt(w.remainingValue ?? 0),
      remainingBlocks: BigInt(w.remainingBlocks ?? 0),
      allowedTargets: w.allowedTargets ?? [],
      nativeOnly: Boolean(w.nativeOnly),
    };
  }

  private async freshFees(): Promise<Fees> {
    const f = await this.publicClient.estimateFeesPerGas();
    // Headroom: the window's value budget is sized from these numbers, so they must not be exceeded later.
    return { maxFeePerGas: f.maxFeePerGas * 2n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
  }

  async openPayWindow(): Promise<TxOutcome> {
    if (!this.vault) return { hash: "", ok: false, error: "no vault configured" };
    try {
      this.fees = await this.freshFees();
      const cost = evmWindowCost({ gas: WINDOW_PROFILE.payGasLimit, maxFeePerGas: this.fees.maxFeePerGas });
      const maxValue = cost + cost / 5n + 1n;
      const msg = openEvmWindowMsg({
        sender: this.agentCosmos,
        blocks: WINDOW_PROFILE.blocks,
        maxTxs: WINDOW_PROFILE.maxTxs,
        maxValue: maxValue.toString(),
        allowedTargets: [this.vault],
      });
      return await this.broadcastCosmos([msg]);
    } catch (e) {
      return { hash: "", ok: false, error: errMsg(e) };
    }
  }

  async closeWindow(): Promise<TxOutcome> {
    return this.broadcastCosmos([closeEvmWindowMsg(this.agentCosmos)]);
  }

  async waitForLiveWindow(timeoutMs = 45_000): Promise<WindowState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const w = await this.getWindow();
      if (w.live) return w;
      if (Date.now() > deadline) throw new Error("the EVM window did not become live in time");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async getEvmNonce(): Promise<number> {
    return this.publicClient.getTransactionCount({ address: this.agentEvm, blockTag: "pending" });
  }

  // ------------------------------------------------------------------- EVM calls

  async sendVaultCall(call: VaultCall): Promise<TxOutcome> {
    if (!this.vault) return { hash: "", ok: false, error: "no vault configured" };
    try {
      const fees = this.fees ?? (await this.freshFees());
      const nonce = await this.getEvmNonce();
      const hash = await this.wallet.sendTransaction({
        to: this.vault,
        data: vaultCallData(call),
        gas: WINDOW_PROFILE.payGasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        nonce,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      const ok = receipt.status === "success";
      return { hash, ok, gasUsed: receipt.gasUsed, error: ok ? undefined : "reverted on chain" };
    } catch (e) {
      const why = classifyEvmWindowRejection(e);
      return { hash: "", ok: false, error: why ? `the EVM window refused the transaction (${why})` : errMsg(e) };
    }
  }

  async simulateVaultCall(call: VaultCall): Promise<{ ok: boolean; error?: string }> {
    if (!this.vault) return { ok: false, error: "no vault configured" };
    try {
      await this.publicClient.call({ account: this.agentEvm, to: this.vault, data: vaultCallData(call) });
      return { ok: true };
    } catch (e) {
      // Re-run as a typed simulation to decode the vault's custom error name.
      try {
        const { functionName, args } = vaultCallArgs(call);
        await this.publicClient.simulateContract({
          address: this.vault,
          abi: custosVaultAbi,
          functionName,
          args,
          account: this.agentEvm,
        } as never);
      } catch (typed) {
        return { ok: false, error: revertReason(typed) };
      }
      return { ok: false, error: errMsg(e) };
    }
  }

  /** Linked-key top-up: the treasury calls CustosVault.topUp through MsgExecuteEVM, relayed by the agent. */
  async topUp(amount: bigint): Promise<TxOutcome> {
    if (!this.vault || !this.linked || !this.cfg.treasuryCosmos) {
      return { hash: "", ok: false, error: "top-up needs VAULT_ADDRESS, LINKED_KEY_PRIVATE_KEY and OWNER_COSMOS_ADDRESS" };
    }
    try {
      const data = hexToBytes(encodeFunctionData({ abi: custosVaultAbi, functionName: "topUp", args: [amount] }));
      const pubkey = hexToBytes(this.linked.address);
      const { nonce } = await fetchAuthNonce({ rest: this.net.rest, address: this.cfg.treasuryCosmos, pubkey });
      this.digestVersion ??= await resolveEvmAuthDigestVersion({ rest: this.net.rest });
      const gasLimit = 250_000;
      const input = {
        chainId: this.net.cosmosChainId,
        account: this.cfg.treasuryCosmos,
        pubkey,
        to: this.vault,
        value: "0",
        data,
        nonce,
        gasLimit,
      };
      const digest = this.digestVersion === "v2" ? evmAuthSignBytesV2(input) : evmAuthSignBytes(input);
      const signature = hexToBytes(await this.linked.signMessage({ message: { raw: digest } }));
      const msg = executeEvmMsg({
        relayer: this.agentCosmos,
        account: this.cfg.treasuryCosmos,
        scheme: "secp256k1",
        pubkey,
        signature,
        to: this.vault,
        value: "0",
        data,
        gasLimit,
        nonce,
      });
      return await this.broadcastCosmos([msg], 900_000);
    } catch (e) {
      return { hash: "", ok: false, error: errMsg(e) };
    }
  }

  async verifyPqLive(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean | null> {
    try {
      const ret = await this.publicClient.call({
        to: this.net.precompiles.pqcVerify,
        data: encodeFunctionData({
          abi: PQC_VERIFY_ABI,
          functionName: "pqcVerify",
          args: [toHex(publicKey), toHex(signature), toHex(message)],
        }),
      });
      if (!ret.data || ret.data === "0x") return null;
      return decodeFunctionResult({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", data: ret.data });
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ Cosmos lane

  private transport(): Promise<StargateClient> {
    this.transportPromise ??= StargateClient.connect(this.net.rpc);
    return this.transportPromise;
  }

  private async accountInfo(): Promise<{ accountNumber: bigint; sequence: bigint }> {
    const r = await fetch(`${this.net.rest}/cosmos/auth/v1beta1/accounts/${this.agentCosmos}`);
    if (r.status === 404) {
      throw new Error(`the agent account ${this.agentCosmos} does not exist on chain yet; fund it from the faucet first`);
    }
    if (!r.ok) throw new Error(`account lookup failed: HTTP ${r.status}`);
    const body = (await r.json()) as { account: Record<string, any> };
    const base = body.account.base_account ?? body.account;
    return { accountNumber: BigInt(base.account_number), sequence: BigInt(base.sequence ?? 0) };
  }

  private async broadcastCosmos(messages: readonly { typeUrl: string; value: unknown }[], gas = 500_000): Promise<TxOutcome> {
    try {
      const transport = await this.transport();
      const { accountNumber, sequence } = await this.accountInfo();
      const fee = { amount: [{ denom: this.net.denom, amount: String(Math.ceil(gas * this.net.minGasPriceUqor)) }], gas: String(gas) };
      const res = await this.cosmosSigner.signAndBroadcast(transport, {
        chainId: this.net.cosmosChainId,
        accountNumber,
        sequence,
        messages,
        fee,
      });
      const ok = res.code === 0;
      return { hash: res.transactionHash, ok, gasUsed: res.gasUsed, error: ok ? undefined : `code ${res.code}: ${res.rawLog ?? ""}` };
    } catch (e) {
      return { hash: "", ok: false, error: errMsg(e) };
    }
  }
}
