// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MockQorePQC (TEST ONLY)
/// @notice Stand-in for QoreChain's PQC precompiles in local Foundry tests. It is NOT post-quantum and NOT
///         secure: a "signature" is valid iff it equals abi.encodePacked(keccak256(pubkey), keccak256(message)).
///         Real ML-DSA-87 verification is exercised against the live testnet precompile by `npm run live-check`.
/// @dev The tests etch this code at both 0x...0A01 and 0x...0A02. Each address has its own storage, so key
///      registrations are written through the 0x...0A02 copy.
contract MockQorePQC {
    struct Key {
        bool registered;
        uint8 algorithmId;
        bytes pubkey;
        bool possessionProven;
    }

    mapping(address => Key) internal keys;
    bool public returnEmpty;

    function setKey(address account, bool registered, uint8 algorithmId, bytes calldata pubkey, bool possessionProven)
        external
    {
        keys[account] = Key(registered, algorithmId, pubkey, possessionProven);
    }

    function setReturnEmpty(bool value) external {
        returnEmpty = value;
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        if (returnEmpty) {
            assembly {
                return(0, 0)
            }
        }
        Key storage k = keys[account];
        return (k.registered, k.algorithmId, k.pubkey, k.possessionProven);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        if (returnEmpty) {
            assembly {
                return(0, 0)
            }
        }
        return keccak256(signature) == keccak256(abi.encodePacked(keccak256(pubkey), keccak256(message)));
    }
}

/// @notice Minimal ERC-20 for tests (6 decimals like fUSD).
contract MockERC20 {
    string public name = "Mock FestUSD";
    string public symbol = "mfUSD";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
