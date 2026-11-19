// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CustosMessages, PayIntent} from "./CustosMessages.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title CustosVault
/// @notice The operating float of a Custos agent. Money leaves this contract only on an ML-DSA-87 signature
///         that the vault checks on-chain with QoreChain's pqcVerify precompile, against the key the chain has
///         registered for the signer. Classical keys can only move money in (topUp) or deliver signed messages.
/// @dev Roles are fixed at deployment:
///      - owner: the human treasury account. Its ML-DSA-87 key sets the mandate (policy and payees), approves
///        out-of-mandate payouts, unpauses and withdraws.
///      - agent: the Custos Keeper account. Its ML-DSA-87 key signs payouts inside the mandate and can pause.
///      Keys are read from the chain's registry (pqcKeyStatus) on every call, so a key rotated on chain takes
///      effect immediately and a revoked key stops working at once.
contract CustosVault {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint8 internal constant ML_DSA_87 = 1;
    uint256 internal constant ML_DSA_87_PUBKEY_LENGTH = 2592;

    struct Payee {
        bool allowed;
        uint256 cap;
    }

    address public immutable owner;
    address public immutable agent;
    /// @notice ERC-20 the vault pays in; address(0) means native QOR.
    address public immutable token;
    /// @notice When true, a signer's key must have been registered with a verified proof of possession.
    bool public immutable requirePossessionProof;
    /// @notice Cosmos chain id bound into every signed message, e.g. "qorechain-diana".
    string public cosmosChainId;

    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public spentToday;
    uint64 public currentDay;
    bool public paused;
    uint256 public totalPaid;
    uint256 public paymentCount;

    mapping(address => Payee) public payees;
    mapping(uint256 => bool) public agentNonceUsed;
    mapping(uint256 => bool) public ownerNonceUsed;
    mapping(bytes32 => bool) public invoicePaid;

    uint256 private _locked = 1;

    event Paid(bytes32 indexed invoiceHash, address indexed payee, uint256 amount, uint256 nonce, bool ownerApproved);
    event PolicySet(uint256 perTxCap, uint256 dailyCap);
    event PayeeSet(address indexed payee, bool allowed, uint256 cap);
    event Paused(bool byOwner);
    event Unpaused();
    event ToppedUp(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error PayeeNotAllowed(address payee);
    error CapExceeded(uint256 amount, uint256 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint256 dailyCap);
    error BadPQSig();
    error KeyNotRegistered(address account);
    error NonceUsed(uint256 nonce);
    error InvoiceAlreadyPaid(bytes32 invoiceHash);
    error Expired(uint64 expiry);
    error VaultPaused();
    error WrongToken(address token);
    error ZeroAmount();
    error ZeroAddress();
    error PrecompileUnavailable();
    error TransferFailed();
    error BadValue();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address owner_,
        address agent_,
        address token_,
        string memory cosmosChainId_,
        uint256 perTxCap_,
        uint256 dailyCap_,
        bool requirePossessionProof_
    ) {
        if (owner_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        owner = owner_;
        agent = agent_;
        token = token_;
        cosmosChainId = cosmosChainId_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        requirePossessionProof = requirePossessionProof_;
        currentDay = uint64(block.timestamp / 1 days);
        emit PolicySet(perTxCap_, dailyCap_);
    }

    // ---------------------------------------------------------------- payouts

    /// @notice Pay an allowlisted vendor inside the mandate. Needs the agent's ML-DSA-87 signature.
    function pay(PayIntent calldata intent, bytes calldata agentSig) external nonReentrant {
        _checkIntent(intent);
        Payee memory p = payees[intent.payee];
        if (!p.allowed) revert PayeeNotAllowed(intent.payee);
        if (intent.amount > p.cap) revert CapExceeded(intent.amount, p.cap);
        if (intent.amount > perTxCap) revert CapExceeded(intent.amount, perTxCap);
        _rollDay();
        if (spentToday + intent.amount > dailyCap) revert DailyCapExceeded(spentToday + intent.amount, dailyCap);
        _verify(agent, CustosMessages.pay(cosmosChainId, block.chainid, address(this), intent), agentSig);
        _settle(intent, false);
    }

    /// @notice Pay outside the mandate (a new payee or an amount over a cap) with the owner's explicit approval.
    /// @dev Needs both the agent's signature over the pay message and the owner's over the approved-pay message.
    ///      Pausing still blocks it; caps do not.
    function payApproved(PayIntent calldata intent, bytes calldata agentSig, bytes calldata ownerSig)
        external
        nonReentrant
    {
        _checkIntent(intent);
        _rollDay();
        _verify(agent, CustosMessages.pay(cosmosChainId, block.chainid, address(this), intent), agentSig);
        _verify(owner, CustosMessages.approvedPay(cosmosChainId, block.chainid, address(this), intent), ownerSig);
        _settle(intent, true);
    }

    // -------------------------------------------------------------- the mandate

    function setPolicy(uint256 perTxCap_, uint256 dailyCap_, uint256 nonce, uint64 expiry, bytes calldata ownerSig)
        external
    {
        _useOwnerNonce(nonce, expiry);
        _verify(
            owner,
            CustosMessages.policy(cosmosChainId, block.chainid, address(this), perTxCap_, dailyCap_, nonce, expiry),
            ownerSig
        );
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit PolicySet(perTxCap_, dailyCap_);
    }

    function setPayee(address who, bool allowed, uint256 cap, uint256 nonce, uint64 expiry, bytes calldata ownerSig)
        external
    {
        if (who == address(0)) revert ZeroAddress();
        _useOwnerNonce(nonce, expiry);
        _verify(
            owner,
            CustosMessages.payee(cosmosChainId, block.chainid, address(this), who, allowed, cap, nonce, expiry),
            ownerSig
        );
        payees[who] = Payee({allowed: allowed, cap: cap});
        emit PayeeSet(who, allowed, cap);
    }

    // ------------------------------------------------------------- kill switch

    /// @notice Stop all payouts. The agent's key (used by the Sentinel) or the owner's key can pause;
    ///         only the owner can unpause.
    function pause(uint256 nonce, uint64 expiry, bytes calldata sig, bool byOwner) external {
        if (expiry < block.timestamp) revert Expired(expiry);
        if (byOwner) {
            if (ownerNonceUsed[nonce]) revert NonceUsed(nonce);
            ownerNonceUsed[nonce] = true;
        } else {
            if (agentNonceUsed[nonce]) revert NonceUsed(nonce);
            agentNonceUsed[nonce] = true;
        }
        _verify(
            byOwner ? owner : agent,
            CustosMessages.pause(cosmosChainId, block.chainid, address(this), nonce, expiry),
            sig
        );
        paused = true;
        emit Paused(byOwner);
    }

    function unpause(uint256 nonce, uint64 expiry, bytes calldata ownerSig) external {
        _useOwnerNonce(nonce, expiry);
        _verify(owner, CustosMessages.unpause(cosmosChainId, block.chainid, address(this), nonce, expiry), ownerSig);
        paused = false;
        emit Unpaused();
    }

    // ------------------------------------------------------------ funds in/out

    /// @notice Move money into the vault. Anyone may call; it only ever pulls from the caller.
    /// @dev The treasury's linked agent key is allowed to call exactly this function (x/abstractaccount rule).
    function topUp(uint256 amount) external payable nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) {
            if (msg.value != amount) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            _safeTransferFrom(msg.sender, address(this), amount);
        }
        emit ToppedUp(msg.sender, amount);
    }

    /// @notice Return funds to the owner's chosen address. Owner signature only.
    function withdraw(address to, uint256 amount, uint256 nonce, uint64 expiry, bytes calldata ownerSig)
        external
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _useOwnerNonce(nonce, expiry);
        _verify(
            owner,
            CustosMessages.withdraw(cosmosChainId, block.chainid, address(this), to, amount, nonce, expiry),
            ownerSig
        );
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    receive() external payable {
        if (token != address(0)) revert WrongToken(address(0));
        emit ToppedUp(msg.sender, msg.value);
    }

    // ------------------------------------------------- views for signers & UIs

    /// @notice The exact bytes the agent signs for `intent` (QoreSign message v1).
    function payMessage(PayIntent calldata intent) external view returns (bytes memory) {
        return CustosMessages.pay(cosmosChainId, block.chainid, address(this), intent);
    }

    function approvedPayMessage(PayIntent calldata intent) external view returns (bytes memory) {
        return CustosMessages.approvedPay(cosmosChainId, block.chainid, address(this), intent);
    }

    function policyMessage(uint256 perTxCap_, uint256 dailyCap_, uint256 nonce, uint64 expiry)
        external
        view
        returns (bytes memory)
    {
        return CustosMessages.policy(cosmosChainId, block.chainid, address(this), perTxCap_, dailyCap_, nonce, expiry);
    }

    function payeeMessage(address who, bool allowed, uint256 cap, uint256 nonce, uint64 expiry)
        external
        view
        returns (bytes memory)
    {
        return CustosMessages.payee(cosmosChainId, block.chainid, address(this), who, allowed, cap, nonce, expiry);
    }

    function pauseMessage(uint256 nonce, uint64 expiry) external view returns (bytes memory) {
        return CustosMessages.pause(cosmosChainId, block.chainid, address(this), nonce, expiry);
    }

    function unpauseMessage(uint256 nonce, uint64 expiry) external view returns (bytes memory) {
        return CustosMessages.unpause(cosmosChainId, block.chainid, address(this), nonce, expiry);
    }

    function withdrawMessage(address to, uint256 amount, uint256 nonce, uint64 expiry)
        external
        view
        returns (bytes memory)
    {
        return CustosMessages.withdraw(cosmosChainId, block.chainid, address(this), to, amount, nonce, expiry);
    }

    /// @notice What the vault can still pay today, after the daily cap.
    function remainingToday() public view returns (uint256) {
        uint256 spent = uint64(block.timestamp / 1 days) == currentDay ? spentToday : 0;
        return spent >= dailyCap ? 0 : dailyCap - spent;
    }

    function balance() public view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20Minimal(token).balanceOf(address(this));
    }

    /// @notice One-call snapshot for the owner console.
    function status()
        external
        view
        returns (
            bool paused_,
            uint256 perTxCap_,
            uint256 dailyCap_,
            uint256 remainingToday_,
            uint256 balance_,
            uint256 totalPaid_,
            uint256 paymentCount_
        )
    {
        return (paused, perTxCap, dailyCap, remainingToday(), balance(), totalPaid, paymentCount);
    }

    // ---------------------------------------------------------------- internals

    function _checkIntent(PayIntent calldata intent) internal view {
        if (paused) revert VaultPaused();
        if (intent.token != token) revert WrongToken(intent.token);
        if (intent.payee == address(0)) revert ZeroAddress();
        if (intent.amount == 0) revert ZeroAmount();
        if (intent.expiry < block.timestamp) revert Expired(intent.expiry);
        if (agentNonceUsed[intent.nonce]) revert NonceUsed(intent.nonce);
        if (invoicePaid[intent.invoiceHash]) revert InvoiceAlreadyPaid(intent.invoiceHash);
    }

    function _settle(PayIntent calldata intent, bool ownerApproved) internal {
        agentNonceUsed[intent.nonce] = true;
        invoicePaid[intent.invoiceHash] = true;
        spentToday += intent.amount;
        totalPaid += intent.amount;
        paymentCount += 1;
        _send(intent.payee, intent.amount);
        emit Paid(intent.invoiceHash, intent.payee, intent.amount, intent.nonce, ownerApproved);
    }

    function _rollDay() internal {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != currentDay) {
            currentDay = today;
            spentToday = 0;
        }
    }

    function _useOwnerNonce(uint256 nonce, uint64 expiry) internal {
        if (expiry < block.timestamp) revert Expired(expiry);
        if (ownerNonceUsed[nonce]) revert NonceUsed(nonce);
        ownerNonceUsed[nonce] = true;
    }

    /// @dev Reads the signer's ML-DSA-87 key from the chain registry, then verifies with pqcVerify.
    ///      An inactive precompile returns empty data; that is treated as a failure, never as a pass.
    function _verify(address signer, bytes memory message, bytes calldata sig) internal view {
        bytes memory pubkey = _registeredKey(signer);
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeWithSignature("pqcVerify(bytes,bytes,bytes)", pubkey, sig, message));
        if (!ok || ret.length != 32) revert PrecompileUnavailable();
        if (!abi.decode(ret, (bool))) revert BadPQSig();
    }

    function _registeredKey(address account) internal view returns (bytes memory pubkey) {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeWithSignature("pqcKeyStatus(address)", account));
        if (!ok || ret.length < 160) revert PrecompileUnavailable();
        (bool registered, uint8 algorithmId, bytes memory key, bool possessionProven) =
            abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || algorithmId != ML_DSA_87 || key.length != ML_DSA_87_PUBKEY_LENGTH) {
            revert KeyNotRegistered(account);
        }
        if (requirePossessionProof && !possessionProven) revert KeyNotRegistered(account);
        return key;
    }

    function _send(address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
