import { BinaryReader, BinaryWriter } from "cosmjs-types/binary";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";

/**
 * `cosmos.evm.erc20.v1.MsgConvertCoin`: move a token-pair bank coin (the faucet pays fUSD this way) into its
 * ERC-20 form, so the vault can hold it. The QoreChain SDK has no builder for it, so this is the protobuf by hand:
 * coin = 1, receiver = 2 (0x address), sender = 3 (qor1 address).
 * Docs: https://docs.qorechain.io/developer-guide/evm-development#fest-convert
 */
export const MSG_CONVERT_COIN_TYPE_URL = "/cosmos.evm.erc20.v1.MsgConvertCoin";

export interface MsgConvertCoin {
  coin?: Coin;
  receiver: string;
  sender: string;
}

export const MsgConvertCoin = {
  encode(m: MsgConvertCoin, w: BinaryWriter = BinaryWriter.create()): BinaryWriter {
    if (m.coin !== undefined) Coin.encode(m.coin, w.uint32(10).fork()).ldelim();
    if (m.receiver !== "") w.uint32(18).string(m.receiver);
    if (m.sender !== "") w.uint32(26).string(m.sender);
    return w;
  },
  decode(input: BinaryReader | Uint8Array, length?: number): MsgConvertCoin {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    const end = length === undefined ? reader.len : reader.pos + length;
    const m: MsgConvertCoin = { coin: undefined, receiver: "", sender: "" };
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          m.coin = Coin.decode(reader, reader.uint32());
          break;
        case 2:
          m.receiver = reader.string();
          break;
        case 3:
          m.sender = reader.string();
          break;
        default:
          reader.skipType(tag & 7);
      }
    }
    return m;
  },
  fromPartial(o: Partial<MsgConvertCoin>): MsgConvertCoin {
    return { coin: o.coin ? Coin.fromPartial(o.coin) : undefined, receiver: o.receiver ?? "", sender: o.sender ?? "" };
  },
};

export function convertCoinMsg(sender: string, receiver0x: string, denom: string, amount: bigint) {
  return { typeUrl: MSG_CONVERT_COIN_TYPE_URL, value: MsgConvertCoin.fromPartial({ coin: { denom, amount: amount.toString() }, receiver: receiver0x, sender }) };
}
