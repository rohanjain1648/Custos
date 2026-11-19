import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toQorAddress, toEvmAddress } from "@qorechain/evm/window";
import { convertCoinMsg, MsgConvertCoin, MSG_CONVERT_COIN_TYPE_URL } from "../src/convert";

describe("MsgConvertCoin (hand-written protobuf)", () => {
  it("round-trips through encode and decode", () => {
    const m = convertCoinMsg("qor1sender", "0x00000000000000000000000000000000000000Aa", "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA", 1_000_000_000n);
    expect(m.typeUrl).toBe(MSG_CONVERT_COIN_TYPE_URL);
    const bytes = MsgConvertCoin.encode(m.value).finish();
    expect(MsgConvertCoin.decode(bytes)).toEqual(m.value);
  });

  it("puts coin in field 1, receiver in field 2, sender in field 3", () => {
    const bytes = MsgConvertCoin.encode(MsgConvertCoin.fromPartial({ coin: { denom: "d", amount: "1" }, receiver: "r", sender: "s" })).finish();
    // tag bytes: (1<<3)|2 = 0x0a, (2<<3)|2 = 0x12, (3<<3)|2 = 0x1a
    expect(bytes[0]).toBe(0x0a);
    expect(Array.from(bytes)).toContain(0x12);
    expect(Array.from(bytes)).toContain(0x1a);
  });
});

describe("address forms", () => {
  it("maps the attacker's 0x address to the same qor1 account and back", () => {
    const attacker = "0x5CCdd09DDf5B2242e636003bc9CA19e4D96b418c";
    const qor = toQorAddress(attacker);
    expect(qor.startsWith("qor1")).toBe(true);
    expect(toEvmAddress(qor).toLowerCase()).toBe(attacker.toLowerCase());
  });
});

describe("setEnvVar", () => {
  it("replaces a key in place and keeps every other line", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "custos-env-"));
    writeFileSync(path.join(root, ".env"), "# comment\nA=1\nVAULT_ADDRESS=\nB=2\n");
    const { setEnvVar } = await import("../src/envfile");
    setEnvVar(root, "VAULT_ADDRESS", "0xabc");
    setEnvVar(root, "NEW_KEY", "x");
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("# comment\nA=1\nVAULT_ADDRESS=0xabc\nB=2\nNEW_KEY=x\n");
  });
});
