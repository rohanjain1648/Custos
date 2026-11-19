import { keccak256, toBytes, type Address, type Hex } from "viem";

/**
 * One invoice, one hash: keccak256 over the vendor's invoice number, the payee address and the amount.
 * The vault refuses a second payment with the same hash, so re-sending the same invoice cannot pay twice.
 */
export function invoiceHash(invoiceNumber: string, payee: Address, amount: bigint): Hex {
  return keccak256(toBytes(`custos-invoice|${invoiceNumber.trim().toUpperCase()}|${payee.toLowerCase()}|${amount}`));
}

/** A single-use nonce: milliseconds since epoch in the high bits plus 32 random bits. */
export function newNonce(now: number = Date.now()): bigint {
  const random = BigInt(Math.floor(Math.random() * 2 ** 32));
  return (BigInt(now) << 32n) | random;
}
