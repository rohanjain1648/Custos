import { getAddress, keccak256, toBytes } from "viem";
import type { MessageContext } from "../src/encoding";
import type { PayIntent } from "../src/types";

/** Fixed inputs shared by the TypeScript and Solidity encoders (contracts/test/vectors/custos-vectors.json). */
export const VECTOR_CTX: MessageContext = {
  cosmosChainId: "qorechain-diana",
  chainId: 9800n,
  vault: getAddress("0x1234567890abcdef1234567890abcdef12345678"),
};

export const VECTOR_EXPIRY = 1_795_000_000n;

export const VECTOR_PAY: PayIntent = {
  payee: getAddress("0x8ba1f109551bd432803012645ac136ddd64dba72"),
  token: getAddress("0x97143b771d34ddb9130b807b135ae675a5a963ca"),
  amount: 1_250_500_000n,
  invoiceHash: keccak256(toBytes("INV-2026-001")),
  nonce: 7_744n,
  expiry: VECTOR_EXPIRY,
};

export const VECTOR_POLICY = { perTxCap: 500_000_000n, dailyCap: 1_000_000_000n, nonce: 1n, expiry: VECTOR_EXPIRY };
export const VECTOR_PAYEE = { who: VECTOR_PAY.payee, allowed: true, cap: 400_000_000n, nonce: 2n, expiry: VECTOR_EXPIRY };
export const VECTOR_PAUSE = { nonce: 3n, expiry: VECTOR_EXPIRY };
export const VECTOR_UNPAUSE = { nonce: 4n, expiry: VECTOR_EXPIRY };
export const VECTOR_WITHDRAW = {
  to: getAddress("0xab5801a7d398351b8be11c439e05c5b3259aec9b"),
  amount: 1_000_000n,
  nonce: 5n,
  expiry: VECTOR_EXPIRY,
};
