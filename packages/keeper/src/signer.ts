import { signPq } from "@custos/core";
import type { AgentSigner } from "./types";

/** Holds the agent's ML-DSA-87 key pair in this process only. */
export class KeyPairSigner implements AgentSigner {
  constructor(private readonly kp: { publicKey: Uint8Array; secretKey: Uint8Array }) {}

  get publicKey(): Uint8Array {
    return this.kp.publicKey;
  }

  sign(message: Uint8Array): Uint8Array {
    return signPq(this.kp.secretKey, message);
  }
}
