// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IQorePQC
/// @notice QoreChain's post-quantum precompiles, active on testnet `qorechain-diana` (governance proposal 21).
/// @dev pqcVerify lives at 0x...0A01 and pqcKeyStatus at 0x...0A02. On a network where a precompile is not
///      active, a call succeeds and returns empty data, so callers must check the return length.
///      See https://docs.qorechain.io/developer-guide/evm-precompiles
interface IQorePQC {
    /// @notice Verify an ML-DSA-87 (FIPS 204) signature over `message`.
    /// @param pubkey The 2592-byte ML-DSA-87 public key.
    /// @param signature The 4627-byte ML-DSA-87 signature.
    /// @param message The exact signed bytes.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    /// @notice Read the post-quantum key registered on chain for `account`.
    /// @return registered True when a key is registered.
    /// @return algorithmId 1 for ML-DSA-87.
    /// @return pubkey The registered public key (empty when none).
    /// @return possessionProven True when the key was registered with a verified proof of possession.
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
