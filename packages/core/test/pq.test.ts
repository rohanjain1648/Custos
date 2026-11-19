import { describe, expect, it } from "vitest";
import { ML_DSA_87, pqKeyFromTestSeed, signPq, verifyPq } from "../src/pq";
import { payMessage } from "../src/encoding";
import { VECTOR_CTX, VECTOR_PAY } from "../scripts/vector-inputs";

const seed = new Uint8Array(32).map((_, i) => (i * 13 + 1) & 0xff);
const kp = pqKeyFromTestSeed(seed);

describe("ML-DSA-87 signing", () => {
  it("produces FIPS 204 level-5 sizes", () => {
    expect(kp.publicKey.length).toBe(ML_DSA_87.publicKeyBytes);
    expect(kp.secretKey.length).toBe(ML_DSA_87.secretKeyBytes);
    expect(signPq(kp.secretKey, new Uint8Array([1, 2, 3])).length).toBe(ML_DSA_87.signatureBytes);
  });

  it("verifies a signature over a vault pay message and rejects a tampered one", () => {
    const msg = payMessage(VECTOR_CTX, VECTOR_PAY);
    const sig = signPq(kp.secretKey, msg);
    expect(verifyPq(kp.publicKey, msg, sig)).toBe(true);

    const tampered = new Uint8Array(msg);
    tampered[tampered.length - 1] ^= 1;
    expect(verifyPq(kp.publicKey, tampered, sig)).toBe(false);

    const badSig = new Uint8Array(sig);
    badSig[7] ^= 0x80;
    expect(verifyPq(kp.publicKey, msg, badSig)).toBe(false);
  });

  it("signs deterministically", () => {
    const msg = new TextEncoder().encode("custos");
    expect(Buffer.from(signPq(kp.secretKey, msg)).equals(Buffer.from(signPq(kp.secretKey, msg)))).toBe(true);
  });
});
