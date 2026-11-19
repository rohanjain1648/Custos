import { encodeAbiParameters, hexToBytes, parseAbiParameters, type Address, type Hex } from "viem";
import { messagePqSignBytes } from "@qorechain/qoresign";
import type { PayIntent } from "./types";

/**
 * TypeScript twin of contracts/src/CustosMessages.sol. Every message is QoreSign message signing v1:
 * "qorechain-msg-v1|" + cosmosChainId + "|" + abi.encode(tag, chainId, vault, ...fields).
 * contracts/test/vectors/custos-vectors.json pins both implementations to the same bytes.
 */
export const TAGS = {
  pay: "CUSTOS_PAY_V1",
  approvedPay: "CUSTOS_APPROVED_PAY_V1",
  policy: "CUSTOS_POLICY_V1",
  payee: "CUSTOS_PAYEE_V1",
  pause: "CUSTOS_PAUSE_V1",
  unpause: "CUSTOS_UNPAUSE_V1",
  withdraw: "CUSTOS_WITHDRAW_V1",
} as const;

export interface MessageContext {
  cosmosChainId: string;
  chainId: bigint;
  vault: Address;
}

function wrap(ctx: MessageContext, payload: Hex): Uint8Array {
  return messagePqSignBytes(ctx.cosmosChainId, hexToBytes(payload));
}

const INTENT_PARAMS = parseAbiParameters(
  "string tag, uint256 chainId, address vault, address payee, address token, uint256 amount, bytes32 invoiceHash, uint256 nonce, uint64 expiry",
);

function intentPayload(tag: string, ctx: MessageContext, i: PayIntent): Hex {
  return encodeAbiParameters(INTENT_PARAMS, [
    tag,
    ctx.chainId,
    ctx.vault,
    i.payee,
    i.token,
    i.amount,
    i.invoiceHash,
    i.nonce,
    i.expiry,
  ]);
}

/** Bytes the agent's ML-DSA-87 key signs for a payout. */
export function payMessage(ctx: MessageContext, intent: PayIntent): Uint8Array {
  return wrap(ctx, intentPayload(TAGS.pay, ctx, intent));
}

/** Bytes the owner's ML-DSA-87 key signs to approve one payout outside the mandate. */
export function approvedPayMessage(ctx: MessageContext, intent: PayIntent): Uint8Array {
  return wrap(ctx, intentPayload(TAGS.approvedPay, ctx, intent));
}

export function policyMessage(
  ctx: MessageContext,
  perTxCap: bigint,
  dailyCap: bigint,
  nonce: bigint,
  expiry: bigint,
): Uint8Array {
  return wrap(
    ctx,
    encodeAbiParameters(
      parseAbiParameters("string, uint256, address, uint256, uint256, uint256, uint64"),
      [TAGS.policy, ctx.chainId, ctx.vault, perTxCap, dailyCap, nonce, expiry],
    ),
  );
}

export function payeeMessage(
  ctx: MessageContext,
  who: Address,
  allowed: boolean,
  cap: bigint,
  nonce: bigint,
  expiry: bigint,
): Uint8Array {
  return wrap(
    ctx,
    encodeAbiParameters(
      parseAbiParameters("string, uint256, address, address, bool, uint256, uint256, uint64"),
      [TAGS.payee, ctx.chainId, ctx.vault, who, allowed, cap, nonce, expiry],
    ),
  );
}

function nonceExpiryMessage(tag: string, ctx: MessageContext, nonce: bigint, expiry: bigint): Uint8Array {
  return wrap(
    ctx,
    encodeAbiParameters(parseAbiParameters("string, uint256, address, uint256, uint64"), [
      tag,
      ctx.chainId,
      ctx.vault,
      nonce,
      expiry,
    ]),
  );
}

export function pauseMessage(ctx: MessageContext, nonce: bigint, expiry: bigint): Uint8Array {
  return nonceExpiryMessage(TAGS.pause, ctx, nonce, expiry);
}

export function unpauseMessage(ctx: MessageContext, nonce: bigint, expiry: bigint): Uint8Array {
  return nonceExpiryMessage(TAGS.unpause, ctx, nonce, expiry);
}

export function withdrawMessage(
  ctx: MessageContext,
  to: Address,
  amount: bigint,
  nonce: bigint,
  expiry: bigint,
): Uint8Array {
  return wrap(
    ctx,
    encodeAbiParameters(
      parseAbiParameters("string, uint256, address, address, uint256, uint256, uint64"),
      [TAGS.withdraw, ctx.chainId, ctx.vault, to, amount, nonce, expiry],
    ),
  );
}
