import type { Address } from "viem";

/** QoreChain testnet `qorechain-diana`, where the Developer Fest is judged. */
export const TESTNET = {
  name: "testnet",
  cosmosChainId: "qorechain-diana",
  evmChainId: 9800,
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
  explorer: "https://explore.qore.network",
  faucet: "https://dashboard.qorechain.io/faucet",
  denom: "uqor",
  /** Fest stablecoin, an ERC-20 registered as a token pair (testnet governance proposal 26). */
  fusd: {
    symbol: "fUSD",
    address: "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as Address,
    decimals: 6,
    bankDenom: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA",
  },
  /** Lowercase on purpose: viem rejects the mixed-case form as a bad checksum. */
  precompiles: {
    pqcVerify: "0x0000000000000000000000000000000000000a01" as Address,
    pqcKeyStatus: "0x0000000000000000000000000000000000000a02" as Address,
  },
  /** Minimum gas price on the Cosmos lane: 0.1 uqor per gas. */
  minGasPriceUqor: 0.1,
  /** About 1.3 s per block on testnet (docs, Oct 2026). */
  blockTimeSeconds: 1.3,
} as const;

export type NetworkConfig = typeof TESTNET;

/** Window profile the Keeper opens for every payout. */
export const WINDOW_PROFILE = {
  blocks: 50,
  maxTxs: 1,
  /** Gas limit for CustosVault.pay; a pay call measures about 330k gas with pqcVerify. */
  payGasLimit: 900_000n,
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function explorerTxUrl(hash: string, cfg: NetworkConfig = TESTNET): string {
  return `${cfg.explorer}/tx/${hash}`;
}

export function explorerAddressUrl(address: string, cfg: NetworkConfig = TESTNET): string {
  return `${cfg.explorer}/address/${address}`;
}
