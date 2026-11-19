import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toHex } from "viem";
import {
  approvedPayMessage,
  pauseMessage,
  payMessage,
  payeeMessage,
  policyMessage,
  unpauseMessage,
  withdrawMessage,
} from "../src/encoding";
import {
  VECTOR_CTX as ctx,
  VECTOR_PAUSE,
  VECTOR_PAY,
  VECTOR_PAYEE,
  VECTOR_POLICY,
  VECTOR_UNPAUSE,
  VECTOR_WITHDRAW,
} from "../scripts/vector-inputs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(path.resolve(here, "../../../contracts/test/vectors/custos-vectors.json"), "utf8"),
);

describe("message encoding (twin of CustosMessages.sol)", () => {
  it("matches the pinned vectors byte for byte", () => {
    expect(toHex(payMessage(ctx, VECTOR_PAY))).toBe(vectors.pay.message);
    expect(toHex(approvedPayMessage(ctx, VECTOR_PAY))).toBe(vectors.approvedPay.message);
    expect(
      toHex(policyMessage(ctx, VECTOR_POLICY.perTxCap, VECTOR_POLICY.dailyCap, VECTOR_POLICY.nonce, VECTOR_POLICY.expiry)),
    ).toBe(vectors.policy.message);
    expect(
      toHex(payeeMessage(ctx, VECTOR_PAYEE.who, VECTOR_PAYEE.allowed, VECTOR_PAYEE.cap, VECTOR_PAYEE.nonce, VECTOR_PAYEE.expiry)),
    ).toBe(vectors.payee.message);
    expect(toHex(pauseMessage(ctx, VECTOR_PAUSE.nonce, VECTOR_PAUSE.expiry))).toBe(vectors.pause.message);
    expect(toHex(unpauseMessage(ctx, VECTOR_UNPAUSE.nonce, VECTOR_UNPAUSE.expiry))).toBe(vectors.unpause.message);
    expect(
      toHex(withdrawMessage(ctx, VECTOR_WITHDRAW.to, VECTOR_WITHDRAW.amount, VECTOR_WITHDRAW.nonce, VECTOR_WITHDRAW.expiry)),
    ).toBe(vectors.withdraw.message);
  });

  it("uses the QoreSign message-v1 domain with the cosmos chain id", () => {
    const text = new TextDecoder().decode(payMessage(ctx, VECTOR_PAY).slice(0, 33));
    expect(text).toBe("qorechain-msg-v1|qorechain-diana|");
  });

  it("binds the vault: a different vault gives different bytes", () => {
    const other = { ...ctx, vault: "0x000000000000000000000000000000000000dEaD" as const };
    expect(toHex(payMessage(other, VECTOR_PAY))).not.toBe(vectors.pay.message);
  });

  it("separates operations: pay and approved-pay never collide", () => {
    expect(toHex(payMessage(ctx, VECTOR_PAY))).not.toBe(toHex(approvedPayMessage(ctx, VECTOR_PAY)));
  });
});
