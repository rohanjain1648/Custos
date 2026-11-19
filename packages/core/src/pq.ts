import { pqSign, pqVerify, pqKeyFromSeed } from "@qorechain/qoresign";
import { keccak256, toHex, type Hex } from "viem";

/** ML-DSA-87 sizes (FIPS 204, NIST level 5). */
export const ML_DSA_87 = { algorithmId: 1, publicKeyBytes: 2592, secretKeyBytes: 4896, signatureBytes: 4627 } as const;

export interface PqKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Deterministic ML-DSA-87 signature (the chain also accepts hedged ones). */
export function signPq(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return pqSign(secretKey, message);
}

export function verifyPq(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return pqVerify(publicKey, message, signature);
}

/** Key pair from a 32-byte seed; for tests and the live check only. Real keys come from mnemonics. */
export function pqKeyFromTestSeed(seed: Uint8Array): PqKeyPair {
  const kp = pqKeyFromSeed(seed);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Short, stable fingerprint of a public key for logs and the console. */
export function keyFingerprint(publicKey: Uint8Array): string {
  return keccak256(toHex(publicKey)).slice(0, 18);
}

export function bytesToHexString(bytes: Uint8Array): Hex {
  return toHex(bytes);
}
