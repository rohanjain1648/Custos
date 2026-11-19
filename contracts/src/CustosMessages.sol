// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A payout the agent asks the vault to make.
/// @param payee Who receives the money.
/// @param token The vault's token (address(0) for native QOR).
/// @param amount Amount in the token's base units.
/// @param invoiceHash keccak256 of the invoice the payout settles; each invoice can be paid once.
/// @param nonce Single-use number chosen by the agent.
/// @param expiry Unix time after which the signed intent is void.
struct PayIntent {
    address payee;
    address token;
    uint256 amount;
    bytes32 invoiceHash;
    uint256 nonce;
    uint64 expiry;
}

/// @title CustosMessages
/// @notice Builds the exact bytes an ML-DSA-87 key signs for each Custos operation.
/// @dev Every message follows QoreSign message signing v1:
///      "qorechain-msg-v1|" + cosmosChainId + "|" + payload  (https://docs.qorechain.io/qoresign/spec/message-signing-v1)
///      Every payload starts with a domain tag and binds the EVM chain id and the vault address, so a
///      signature made for one operation, chain or vault can never be replayed as another.
///      The TypeScript twin is packages/core/src/encoding.ts; test/vectors/custos-vectors.json pins both.
library CustosMessages {
    bytes internal constant DOMAIN = "qorechain-msg-v1|";

    string internal constant PAY_TAG = "CUSTOS_PAY_V1";
    string internal constant APPROVED_PAY_TAG = "CUSTOS_APPROVED_PAY_V1";
    string internal constant POLICY_TAG = "CUSTOS_POLICY_V1";
    string internal constant PAYEE_TAG = "CUSTOS_PAYEE_V1";
    string internal constant PAUSE_TAG = "CUSTOS_PAUSE_V1";
    string internal constant UNPAUSE_TAG = "CUSTOS_UNPAUSE_V1";
    string internal constant WITHDRAW_TAG = "CUSTOS_WITHDRAW_V1";

    function wrap(string memory cosmosChainId, bytes memory payload) internal pure returns (bytes memory) {
        return bytes.concat(DOMAIN, bytes(cosmosChainId), "|", payload);
    }

    /// @notice Signed by the agent's key for every payout.
    function pay(string memory cosmosChainId, uint256 chainId, address vault, PayIntent memory i)
        internal
        pure
        returns (bytes memory)
    {
        return wrap(
            cosmosChainId,
            abi.encode(PAY_TAG, chainId, vault, i.payee, i.token, i.amount, i.invoiceHash, i.nonce, i.expiry)
        );
    }

    /// @notice Signed by the owner's key to approve one specific payout outside the mandate.
    function approvedPay(string memory cosmosChainId, uint256 chainId, address vault, PayIntent memory i)
        internal
        pure
        returns (bytes memory)
    {
        return wrap(
            cosmosChainId,
            abi.encode(APPROVED_PAY_TAG, chainId, vault, i.payee, i.token, i.amount, i.invoiceHash, i.nonce, i.expiry)
        );
    }

    function policy(
        string memory cosmosChainId,
        uint256 chainId,
        address vault,
        uint256 perTxCap,
        uint256 dailyCap,
        uint256 nonce,
        uint64 expiry
    ) internal pure returns (bytes memory) {
        return wrap(cosmosChainId, abi.encode(POLICY_TAG, chainId, vault, perTxCap, dailyCap, nonce, expiry));
    }

    function payee(
        string memory cosmosChainId,
        uint256 chainId,
        address vault,
        address who,
        bool allowed,
        uint256 cap,
        uint256 nonce,
        uint64 expiry
    ) internal pure returns (bytes memory) {
        return wrap(cosmosChainId, abi.encode(PAYEE_TAG, chainId, vault, who, allowed, cap, nonce, expiry));
    }

    function pause(string memory cosmosChainId, uint256 chainId, address vault, uint256 nonce, uint64 expiry)
        internal
        pure
        returns (bytes memory)
    {
        return wrap(cosmosChainId, abi.encode(PAUSE_TAG, chainId, vault, nonce, expiry));
    }

    function unpause(string memory cosmosChainId, uint256 chainId, address vault, uint256 nonce, uint64 expiry)
        internal
        pure
        returns (bytes memory)
    {
        return wrap(cosmosChainId, abi.encode(UNPAUSE_TAG, chainId, vault, nonce, expiry));
    }

    function withdraw(
        string memory cosmosChainId,
        uint256 chainId,
        address vault,
        address to,
        uint256 amount,
        uint256 nonce,
        uint64 expiry
    ) internal pure returns (bytes memory) {
        return wrap(cosmosChainId, abi.encode(WITHDRAW_TAG, chainId, vault, to, amount, nonce, expiry));
    }
}
