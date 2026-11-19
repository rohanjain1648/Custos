// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CustosVault} from "../src/CustosVault.sol";
import {CustosMessages, PayIntent} from "../src/CustosMessages.sol";
import {MockQorePQC, MockERC20} from "./mocks/MockQorePQC.sol";

contract CustosVaultTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    string constant COSMOS = "qorechain-diana";

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address vendor = makeAddr("vendor");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");

    bytes ownerKey;
    bytes agentKey;
    MockERC20 usd;
    CustosVault vault;

    event Paid(bytes32 indexed invoiceHash, address indexed payee, uint256 amount, uint256 nonce, bool ownerApproved);
    event PayeeSet(address indexed payee, bool allowed, uint256 cap);
    event ToppedUp(address indexed from, uint256 amount);

    function setUp() public {
        vm.warp(1_800_000_000);
        MockQorePQC impl = new MockQorePQC();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEY_STATUS, address(impl).code);
        ownerKey = _key(0x01);
        agentKey = _key(0x02);
        _register(owner, ownerKey, true);
        _register(agent, agentKey, true);

        usd = new MockERC20();
        vault = new CustosVault(owner, agent, address(usd), COSMOS, 500e6, 1_000e6, true);
        usd.mint(address(vault), 10_000e6);
        _setPayee(vendor, true, 400e6, 1);
    }

    // ------------------------------------------------------------------ helpers

    function _key(uint8 tag) internal pure returns (bytes memory k) {
        k = new bytes(2592);
        k[0] = bytes1(tag);
        k[2591] = bytes1(tag);
    }

    function _register(address who, bytes memory key, bool pop) internal {
        MockQorePQC(PQC_KEY_STATUS).setKey(who, true, 1, key, pop);
    }

    function _sig(bytes memory key, bytes memory message) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(key), keccak256(message));
    }

    function _exp() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    function _intent(address payee, uint256 amount, bytes32 inv, uint256 nonce) internal view returns (PayIntent memory) {
        return PayIntent(payee, address(usd), amount, inv, nonce, _exp());
    }

    function _pay(PayIntent memory i) internal {
        vault.pay(i, _sig(agentKey, vault.payMessage(i)));
    }

    function _setPayee(address who, bool allowed, uint256 cap, uint256 nonce) internal {
        uint64 exp = _exp();
        vault.setPayee(who, allowed, cap, nonce, exp, _sig(ownerKey, vault.payeeMessage(who, allowed, cap, nonce, exp)));
    }

    // --------------------------------------------------------------- happy path

    function test_PayAllowlistedVendor() public {
        PayIntent memory i = _intent(vendor, 100e6, keccak256("INV-001"), 11);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Paid(keccak256("INV-001"), vendor, 100e6, 11, false);
        _pay(i);
        assertEq(usd.balanceOf(vendor), 100e6);
        assertEq(vault.spentToday(), 100e6);
        assertEq(vault.paymentCount(), 1);
        assertEq(vault.totalPaid(), 100e6);
        assertTrue(vault.invoicePaid(keccak256("INV-001")));
        assertTrue(vault.agentNonceUsed(11));
        assertEq(vault.remainingToday(), 900e6);
    }

    function test_AnyoneCanRelayASignedIntent() public {
        PayIntent memory i = _intent(vendor, 50e6, keccak256("INV-R"), 12);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.prank(stranger);
        vault.pay(i, sig);
        assertEq(usd.balanceOf(vendor), 50e6);
    }

    // ------------------------------------------------------------ the mandate

    function test_RevertWhen_PayeeNotAllowed() public {
        PayIntent memory i = _intent(stranger, 10e6, keccak256("INV-X"), 13);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.PayeeNotAllowed.selector, stranger));
        vault.pay(i, sig);
    }

    function test_RevertWhen_OverPayeeCap() public {
        PayIntent memory i = _intent(vendor, 401e6, keccak256("INV-2"), 14);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.CapExceeded.selector, 401e6, 400e6));
        vault.pay(i, sig);
    }

    function test_RevertWhen_OverPerTxCap() public {
        _setPayee(vendor, true, 900e6, 2);
        PayIntent memory i = _intent(vendor, 600e6, keccak256("INV-3"), 15);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.CapExceeded.selector, 600e6, 500e6));
        vault.pay(i, sig);
    }

    function test_RevertWhen_DailyCapExceeded() public {
        _pay(_intent(vendor, 400e6, keccak256("A"), 20));
        _pay(_intent(vendor, 400e6, keccak256("B"), 21));
        PayIntent memory i = _intent(vendor, 300e6, keccak256("C"), 22);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.DailyCapExceeded.selector, 1_100e6, 1_000e6));
        vault.pay(i, sig);
    }

    function test_DailyCapResetsNextUtcDay() public {
        _pay(_intent(vendor, 400e6, keccak256("A"), 30));
        _pay(_intent(vendor, 400e6, keccak256("B"), 31));
        _pay(_intent(vendor, 200e6, keccak256("C"), 32));
        assertEq(vault.remainingToday(), 0);

        uint256 nextDay = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(nextDay - 1);
        PayIntent memory early = _intent(vendor, 1e6, keccak256("D"), 33);
        bytes memory earlySig = _sig(agentKey, vault.payMessage(early));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.DailyCapExceeded.selector, 1_001e6, 1_000e6));
        vault.pay(early, earlySig);

        vm.warp(nextDay);
        assertEq(vault.remainingToday(), 1_000e6);
        _pay(_intent(vendor, 1e6, keccak256("D"), 34));
        assertEq(vault.spentToday(), 1e6);
    }

    function test_SetPolicy() public {
        uint64 exp = _exp();
        bytes memory sig = _sig(ownerKey, vault.policyMessage(50e6, 70e6, 5, exp));
        vault.setPolicy(50e6, 70e6, 5, exp, sig);
        assertEq(vault.perTxCap(), 50e6);
        assertEq(vault.dailyCap(), 70e6);
        PayIntent memory i = _intent(vendor, 60e6, keccak256("P"), 40);
        bytes memory paySig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.CapExceeded.selector, 60e6, 50e6));
        vault.pay(i, paySig);
    }

    function test_RemovePayee() public {
        _setPayee(vendor, false, 0, 6);
        PayIntent memory i = _intent(vendor, 1e6, keccak256("R"), 41);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.PayeeNotAllowed.selector, vendor));
        vault.pay(i, sig);
    }

    function test_RevertWhen_AgentKeySignsMandateChange() public {
        uint64 exp = _exp();
        bytes memory sig = _sig(agentKey, vault.payeeMessage(stranger, true, 1_000e6, 7, exp));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.setPayee(stranger, true, 1_000e6, 7, exp, sig);
    }

    function test_RevertWhen_OwnerNonceReused() public {
        uint64 exp = _exp();
        bytes memory sig = _sig(ownerKey, vault.payeeMessage(stranger, true, 1e6, 1, exp));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.NonceUsed.selector, 1));
        vault.setPayee(stranger, true, 1e6, 1, exp, sig);
    }

    // ------------------------------------------------------------------ replay

    function test_RevertWhen_NonceReused() public {
        _pay(_intent(vendor, 10e6, keccak256("N1"), 50));
        PayIntent memory i = _intent(vendor, 10e6, keccak256("N2"), 50);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.NonceUsed.selector, 50));
        vault.pay(i, sig);
    }

    function test_RevertWhen_InvoicePaidTwice() public {
        _pay(_intent(vendor, 10e6, keccak256("INV-DUP"), 51));
        PayIntent memory i = _intent(vendor, 10e6, keccak256("INV-DUP"), 52);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.InvoiceAlreadyPaid.selector, keccak256("INV-DUP")));
        vault.pay(i, sig);
    }

    function test_RevertWhen_Expired() public {
        PayIntent memory i = PayIntent(vendor, address(usd), 10e6, keccak256("E"), 53, uint64(block.timestamp - 1));
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.Expired.selector, uint64(block.timestamp - 1)));
        vault.pay(i, sig);
    }

    function test_RevertWhen_WrongToken() public {
        PayIntent memory i = PayIntent(vendor, address(0xdead), 10e6, keccak256("T"), 54, _exp());
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.WrongToken.selector, address(0xdead)));
        vault.pay(i, sig);
    }

    // ------------------------------------------------------- signature binding

    function test_RevertWhen_SignatureForOtherVault() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("V"), 60);
        bytes memory sig = _sig(agentKey, CustosMessages.pay(COSMOS, block.chainid, address(0xBEEF), i));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, sig);
    }

    function test_RevertWhen_SignatureForOtherChain() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("C9801"), 61);
        bytes memory sig = _sig(agentKey, CustosMessages.pay(COSMOS, 9801, address(vault), i));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, sig);
    }

    function test_RevertWhen_SignatureForOtherCosmosChain() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("VLADI"), 62);
        bytes memory sig = _sig(agentKey, CustosMessages.pay("qorechain-vladi", block.chainid, address(vault), i));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, sig);
    }

    function test_RevertWhen_TamperedAmount() public {
        PayIntent memory signed = _intent(vendor, 100e6, keccak256("TA"), 63);
        bytes memory sig = _sig(agentKey, vault.payMessage(signed));
        PayIntent memory sent = _intent(vendor, 200e6, keccak256("TA"), 63);
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(sent, sig);
    }

    function test_RevertWhen_OwnerKeySignsPayout() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("OK"), 64);
        bytes memory sig = _sig(ownerKey, vault.payMessage(i));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, sig);
    }

    function test_RevertWhen_PayApprovedMessageUsedAsPay() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("DOM"), 65);
        bytes memory sig = _sig(agentKey, vault.approvedPayMessage(i));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, sig);
    }

    // --------------------------------------------------------- the key registry

    function test_RevertWhen_AgentKeyNotRegistered() public {
        MockQorePQC(PQC_KEY_STATUS).setKey(agent, false, 0, "", false);
        PayIntent memory i = _intent(vendor, 10e6, keccak256("K"), 70);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.KeyNotRegistered.selector, agent));
        vault.pay(i, sig);
    }

    function test_RevertWhen_PossessionNotProven() public {
        _register(agent, agentKey, false);
        PayIntent memory i = _intent(vendor, 10e6, keccak256("POP"), 71);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.KeyNotRegistered.selector, agent));
        vault.pay(i, sig);
    }

    function test_PossessionProofOptionalWhenDisabled() public {
        CustosVault lax = new CustosVault(owner, agent, address(usd), COSMOS, 500e6, 1_000e6, false);
        usd.mint(address(lax), 100e6);
        _register(agent, agentKey, false);
        uint64 exp = _exp();
        lax.setPayee(vendor, true, 50e6, 1, exp, _sig(ownerKey, lax.payeeMessage(vendor, true, 50e6, 1, exp)));
        PayIntent memory i = _intent(vendor, 10e6, keccak256("LAX"), 72);
        lax.pay(i, _sig(agentKey, lax.payMessage(i)));
        assertEq(usd.balanceOf(vendor), 10e6);
    }

    function test_RevertWhen_WrongAlgorithm() public {
        MockQorePQC(PQC_KEY_STATUS).setKey(agent, true, 2, agentKey, true);
        PayIntent memory i = _intent(vendor, 10e6, keccak256("ALG"), 73);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(abi.encodeWithSelector(CustosVault.KeyNotRegistered.selector, agent));
        vault.pay(i, sig);
    }

    function test_KeyRotationTakesEffectImmediately() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("ROT"), 74);
        bytes memory oldSig = _sig(agentKey, vault.payMessage(i));
        bytes memory newKey = _key(0x09);
        _register(agent, newKey, true);
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, oldSig);
        vault.pay(i, _sig(newKey, vault.payMessage(i)));
        assertEq(usd.balanceOf(vendor), 10e6);
    }

    function test_RevertWhen_PrecompileReturnsEmpty() public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("EMPTY"), 75);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        MockQorePQC(PQC_KEY_STATUS).setReturnEmpty(true);
        vm.expectRevert(CustosVault.PrecompileUnavailable.selector);
        vault.pay(i, sig);

        MockQorePQC(PQC_KEY_STATUS).setReturnEmpty(false);
        MockQorePQC(PQC_VERIFY).setReturnEmpty(true);
        vm.expectRevert(CustosVault.PrecompileUnavailable.selector);
        vault.pay(i, sig);
    }

    function test_RevertWhen_NoPrecompileCode() public {
        vm.etch(PQC_VERIFY, "");
        PayIntent memory i = _intent(vendor, 10e6, keccak256("NOCODE"), 76);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(CustosVault.PrecompileUnavailable.selector);
        vault.pay(i, sig);
    }

    // ------------------------------------------------------------- kill switch

    function test_AgentCanPause_OnlyOwnerUnpauses() public {
        uint64 exp = _exp();
        vault.pause(900, exp, _sig(agentKey, vault.pauseMessage(900, exp)), false);
        assertTrue(vault.paused());

        PayIntent memory i = _intent(vendor, 10e6, keccak256("PAUSED"), 80);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        vm.expectRevert(CustosVault.VaultPaused.selector);
        vault.pay(i, sig);

        bytes memory agentUnpause = _sig(agentKey, vault.unpauseMessage(901, exp));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.unpause(901, exp, agentUnpause);

        vault.unpause(902, exp, _sig(ownerKey, vault.unpauseMessage(902, exp)));
        assertFalse(vault.paused());
        vault.pay(i, sig);
        assertEq(usd.balanceOf(vendor), 10e6);
    }

    function test_OwnerCanPause() public {
        uint64 exp = _exp();
        vault.pause(903, exp, _sig(ownerKey, vault.pauseMessage(903, exp)), true);
        assertTrue(vault.paused());
        assertTrue(vault.ownerNonceUsed(903));
    }

    function test_RevertWhen_StrangerPauses() public {
        uint64 exp = _exp();
        bytes memory sig = _sig(_key(0x77), vault.pauseMessage(904, exp));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pause(904, exp, sig, false);
    }

    // ---------------------------------------------------- owner-approved payouts

    function test_PayApprovedNewPayeeOverCap() public {
        PayIntent memory i = _intent(stranger, 600e6, keccak256("APPROVED"), 90);
        bytes memory agentSig = _sig(agentKey, vault.payMessage(i));
        bytes memory ownerSig = _sig(ownerKey, vault.approvedPayMessage(i));
        vm.expectEmit(true, true, false, true, address(vault));
        emit Paid(keccak256("APPROVED"), stranger, 600e6, 90, true);
        vault.payApproved(i, agentSig, ownerSig);
        assertEq(usd.balanceOf(stranger), 600e6);
        assertEq(vault.spentToday(), 600e6);
    }

    function test_RevertWhen_PayApprovedWithoutOwner() public {
        PayIntent memory i = _intent(stranger, 600e6, keccak256("NOOWNER"), 91);
        bytes memory agentSig = _sig(agentKey, vault.payMessage(i));
        bytes memory fakeOwnerSig = _sig(agentKey, vault.approvedPayMessage(i));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.payApproved(i, agentSig, fakeOwnerSig);
    }

    function test_RevertWhen_PayApprovedWhilePaused() public {
        uint64 exp = _exp();
        vault.pause(905, exp, _sig(ownerKey, vault.pauseMessage(905, exp)), true);
        PayIntent memory i = _intent(stranger, 1e6, keccak256("PP"), 92);
        bytes memory agentSig = _sig(agentKey, vault.payMessage(i));
        bytes memory ownerSig = _sig(ownerKey, vault.approvedPayMessage(i));
        vm.expectRevert(CustosVault.VaultPaused.selector);
        vault.payApproved(i, agentSig, ownerSig);
    }

    // -------------------------------------------------------------- funds in/out

    function test_TopUpErc20() public {
        usd.mint(treasury, 300e6);
        vm.startPrank(treasury);
        usd.approve(address(vault), 300e6);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ToppedUp(treasury, 300e6);
        vault.topUp(300e6);
        vm.stopPrank();
        assertEq(usd.balanceOf(address(vault)), 10_300e6);
        assertEq(vault.balance(), 10_300e6);
    }

    function test_RevertWhen_TopUpWithoutAllowance() public {
        usd.mint(stranger, 10e6);
        vm.prank(stranger);
        vm.expectRevert(CustosVault.TransferFailed.selector);
        vault.topUp(10e6);
    }

    function test_RevertWhen_NativeSentToErc20Vault() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
        vm.prank(stranger);
        vm.expectRevert(CustosVault.BadValue.selector);
        vault.topUp{value: 1 ether}(1 ether);
    }

    function test_NativeQorVault() public {
        CustosVault native = new CustosVault(owner, agent, address(0), COSMOS, 5 ether, 10 ether, true);
        vm.deal(treasury, 20 ether);
        vm.prank(treasury);
        native.topUp{value: 6 ether}(6 ether);
        vm.prank(treasury);
        (bool ok,) = address(native).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(native.balance(), 7 ether);

        uint64 exp = _exp();
        native.setPayee(vendor, true, 3 ether, 1, exp, _sig(ownerKey, native.payeeMessage(vendor, true, 3 ether, 1, exp)));
        PayIntent memory i = PayIntent(vendor, address(0), 2 ether, keccak256("NATIVE"), 1, exp);
        native.pay(i, _sig(agentKey, native.payMessage(i)));
        assertEq(vendor.balance, 2 ether);
        assertEq(native.balance(), 5 ether);
    }

    function test_Withdraw() public {
        uint64 exp = _exp();
        vault.withdraw(treasury, 1_000e6, 8, exp, _sig(ownerKey, vault.withdrawMessage(treasury, 1_000e6, 8, exp)));
        assertEq(usd.balanceOf(treasury), 1_000e6);

        bytes memory agentSig = _sig(agentKey, vault.withdrawMessage(stranger, 1e6, 9, exp));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.withdraw(stranger, 1e6, 9, exp, agentSig);
    }

    // ------------------------------------------------------- cross-language vectors
    // Inputs and expected bytes come from packages/core (npm run vectors). Each test is small on purpose:
    // the legacy code generator runs out of stack slots when one function parses everything.

    struct VCtx {
        string cosmos;
        uint256 chainId;
        address vault;
    }

    struct VPayee {
        address who;
        bool allowed;
        uint256 cap;
        uint256 nonce;
        uint64 expiry;
    }

    struct VWithdraw {
        address to;
        uint256 amount;
        uint256 nonce;
        uint64 expiry;
    }

    function _json() internal view returns (string memory) {
        return vm.readFile("test/vectors/custos-vectors.json");
    }

    function _vctx(string memory json) internal pure returns (VCtx memory c) {
        c.cosmos = vm.parseJsonString(json, ".cosmosChainId");
        c.chainId = vm.parseJsonUint(json, ".chainId");
        c.vault = vm.parseJsonAddress(json, ".vault");
    }

    function _vintent(string memory json) internal pure returns (PayIntent memory i) {
        i.payee = vm.parseJsonAddress(json, ".pay.payee");
        i.token = vm.parseJsonAddress(json, ".pay.token");
        i.amount = vm.parseJsonUint(json, ".pay.amount");
        i.invoiceHash = vm.parseJsonBytes32(json, ".pay.invoiceHash");
        i.nonce = vm.parseJsonUint(json, ".pay.nonce");
        i.expiry = uint64(vm.parseJsonUint(json, ".pay.expiry"));
    }

    function test_VectorPayMatches() public view {
        string memory json = _json();
        VCtx memory c = _vctx(json);
        PayIntent memory i = _vintent(json);
        assertEq(CustosMessages.pay(c.cosmos, c.chainId, c.vault, i), vm.parseJsonBytes(json, ".pay.message"));
        assertEq(
            CustosMessages.approvedPay(c.cosmos, c.chainId, c.vault, i), vm.parseJsonBytes(json, ".approvedPay.message")
        );
    }

    function test_VectorPolicyMatches() public view {
        string memory json = _json();
        VCtx memory c = _vctx(json);
        uint256 perTx = vm.parseJsonUint(json, ".policy.perTxCap");
        uint256 daily = vm.parseJsonUint(json, ".policy.dailyCap");
        uint256 nonce = vm.parseJsonUint(json, ".policy.nonce");
        uint64 exp = uint64(vm.parseJsonUint(json, ".policy.expiry"));
        assertEq(
            CustosMessages.policy(c.cosmos, c.chainId, c.vault, perTx, daily, nonce, exp),
            vm.parseJsonBytes(json, ".policy.message")
        );
    }

    function test_VectorPayeeMatches() public view {
        string memory json = _json();
        VCtx memory c = _vctx(json);
        VPayee memory p;
        p.who = vm.parseJsonAddress(json, ".payee.who");
        p.allowed = vm.parseJsonBool(json, ".payee.allowed");
        p.cap = vm.parseJsonUint(json, ".payee.cap");
        p.nonce = vm.parseJsonUint(json, ".payee.nonce");
        p.expiry = uint64(vm.parseJsonUint(json, ".payee.expiry"));
        bytes memory got = CustosMessages.payee(c.cosmos, c.chainId, c.vault, p.who, p.allowed, p.cap, p.nonce, p.expiry);
        assertEq(got, vm.parseJsonBytes(json, ".payee.message"));
    }

    function test_VectorPauseAndUnpauseMatch() public view {
        string memory json = _json();
        VCtx memory c = _vctx(json);
        uint256 n1 = vm.parseJsonUint(json, ".pause.nonce");
        uint64 e1 = uint64(vm.parseJsonUint(json, ".pause.expiry"));
        assertEq(CustosMessages.pause(c.cosmos, c.chainId, c.vault, n1, e1), vm.parseJsonBytes(json, ".pause.message"));
        uint256 n2 = vm.parseJsonUint(json, ".unpause.nonce");
        uint64 e2 = uint64(vm.parseJsonUint(json, ".unpause.expiry"));
        assertEq(
            CustosMessages.unpause(c.cosmos, c.chainId, c.vault, n2, e2), vm.parseJsonBytes(json, ".unpause.message")
        );
    }

    function test_VectorWithdrawMatches() public view {
        string memory json = _json();
        VCtx memory c = _vctx(json);
        VWithdraw memory w;
        w.to = vm.parseJsonAddress(json, ".withdraw.to");
        w.amount = vm.parseJsonUint(json, ".withdraw.amount");
        w.nonce = vm.parseJsonUint(json, ".withdraw.nonce");
        w.expiry = uint64(vm.parseJsonUint(json, ".withdraw.expiry"));
        bytes memory got = CustosMessages.withdraw(c.cosmos, c.chainId, c.vault, w.to, w.amount, w.nonce, w.expiry);
        assertEq(got, vm.parseJsonBytes(json, ".withdraw.message"));
    }

    // ------------------------------------------------------------------- fuzzing

    function testFuzz_PayoutsNeverExceedCaps(uint256 amount) public {
        amount = bound(amount, 1, 2_000e6);
        PayIntent memory i = _intent(vendor, amount, keccak256(abi.encode(amount)), 1000);
        bytes memory sig = _sig(agentKey, vault.payMessage(i));
        if (amount > 400e6) {
            vm.expectRevert(abi.encodeWithSelector(CustosVault.CapExceeded.selector, amount, 400e6));
            vault.pay(i, sig);
        } else {
            vault.pay(i, sig);
            assertEq(usd.balanceOf(vendor), amount);
        }
        assertLe(vault.spentToday(), vault.dailyCap());
    }

    function testFuzz_ForgedSignatureAlwaysFails(bytes32 junk) public {
        PayIntent memory i = _intent(vendor, 10e6, keccak256("FORGE"), 1001);
        bytes memory forged = abi.encodePacked(junk, keccak256(vault.payMessage(i)));
        vm.expectRevert(CustosVault.BadPQSig.selector);
        vault.pay(i, forged);
    }
}
