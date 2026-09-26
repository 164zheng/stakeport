// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {NativeStakeMarket} from "../src/NativeStakeMarket.sol";
import {IEligibilityPolicy} from "../src/interfaces/IEligibilityPolicy.sol";
import {WorldIdEligibility} from "../src/world/WorldIdEligibility.sol";
import {MarketBase} from "./utils/MarketBase.sol";

contract WorldIdEligibilityTest is MarketBase {
    bytes32 constant PASSPORT = keccak256("world-id:passport");
    uint256 attesterPk = 0xA77E57;
    WorldIdEligibility eligibility;
    bytes32 nullifier = keccak256("world-id-nullifier");

    function setUp() public override {
        super.setUp();
        eligibility = new WorldIdEligibility(vm.addr(attesterPk), PASSPORT);
    }

    function _attestation(address account, bytes32 n, bytes32 credential, uint64 expiresAt)
        internal
        pure
        returns (WorldIdEligibility.Attestation memory)
    {
        return WorldIdEligibility.Attestation({account: account, nullifier: n, credential: credential, expiresAt: expiresAt});
    }

    function _sign(WorldIdEligibility.Attestation memory a, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, eligibility.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }

    function _attest(address account) internal {
        WorldIdEligibility.Attestation memory a =
            _attestation(account, nullifier, PASSPORT, uint64(vm.getBlockTimestamp() + 30 days));
        eligibility.attest(a, _sign(a, attesterPk));
    }

    // --- eligibility registry --------------------------------------------------------------------

    function test_attest_makesAccountEligible() public {
        assertFalse(eligibility.isEligible(buyer));
        vm.expectEmit(address(eligibility));
        emit WorldIdEligibility.Attested(buyer, nullifier, PASSPORT, uint64(vm.getBlockTimestamp() + 30 days));
        _attest(buyer);
        assertTrue(eligibility.isEligible(buyer));
        assertEq(eligibility.accountOfNullifier(nullifier), buyer);
    }

    function test_attest_expires() public {
        _attest(buyer);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertFalse(eligibility.isEligible(buyer));
    }

    function test_attest_sameAccountCanRenew() public {
        _attest(buyer);
        vm.warp(vm.getBlockTimestamp() + 29 days);
        _attest(buyer);
        vm.warp(vm.getBlockTimestamp() + 2 days);
        assertTrue(eligibility.isEligible(buyer));
    }

    function test_revert_onePassportOneAccount() public {
        _attest(buyer);
        address other = makeAddr("other");
        WorldIdEligibility.Attestation memory a =
            _attestation(other, nullifier, PASSPORT, uint64(vm.getBlockTimestamp() + 30 days));
        bytes memory sig = _sign(a, attesterPk);
        vm.expectRevert(abi.encodeWithSelector(WorldIdEligibility.NullifierBoundToOtherAccount.selector, buyer));
        eligibility.attest(a, sig);
    }

    function test_revert_notSignedByAttester() public {
        WorldIdEligibility.Attestation memory a =
            _attestation(buyer, nullifier, PASSPORT, uint64(vm.getBlockTimestamp() + 30 days));
        bytes memory sig = _sign(a, 0xBAD);
        vm.expectRevert(WorldIdEligibility.InvalidAttester.selector);
        eligibility.attest(a, sig);
    }

    function test_revert_tamperedAccount() public {
        WorldIdEligibility.Attestation memory a =
            _attestation(buyer, nullifier, PASSPORT, uint64(vm.getBlockTimestamp() + 30 days));
        bytes memory sig = _sign(a, attesterPk);
        a.account = makeAddr("thief");
        vm.expectRevert(WorldIdEligibility.InvalidAttester.selector);
        eligibility.attest(a, sig);
    }

    function test_revert_wrongCredential() public {
        bytes32 selfie = keccak256("world-id:selfie");
        WorldIdEligibility.Attestation memory a =
            _attestation(buyer, nullifier, selfie, uint64(vm.getBlockTimestamp() + 30 days));
        bytes memory sig = _sign(a, attesterPk);
        vm.expectRevert(abi.encodeWithSelector(WorldIdEligibility.WrongCredential.selector, selfie));
        eligibility.attest(a, sig);
    }

    function test_revert_expiredAttestation() public {
        WorldIdEligibility.Attestation memory a =
            _attestation(buyer, nullifier, PASSPORT, uint64(vm.getBlockTimestamp()));
        bytes memory sig = _sign(a, attesterPk);
        vm.expectRevert(WorldIdEligibility.AttestationExpired.selector);
        eligibility.attest(a, sig);
    }

    // --- Verified Market listings ----------------------------------------------------------------

    function _listVerified() internal returns (NativeStakeMarket.StakeOrder memory o, bytes32 hash) {
        o = _order();
        o.expiry = vm.getBlockTimestamp() + 90 days;
        vm.prank(seller);
        hash = market.listOrderWithPolicy(o, IEligibilityPolicy(address(eligibility)));
    }

    function test_verifiedListing_rejectsUnverifiedBuyer() public {
        (NativeStakeMarket.StakeOrder memory o, bytes32 hash) = _listVerified();
        assertEq(address(market.policyOf(hash)), address(eligibility));
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BuyerNotEligible.selector, buyer));
        market.fill{value: 1}(o, "", targetPubkey, p, buyer);
    }

    function test_verifiedListing_acceptsVerifiedBuyer() public {
        (NativeStakeMarket.StakeOrder memory o,) = _listVerified();
        _attest(buyer);
        vm.prank(buyer);
        uint256 id = market.fill{value: 1}(o, "", targetPubkey, _defaultProofs(), buyer);
        assertEq(market.getTrade(id).buyer, buyer);
    }

    function test_verifiedListing_checksBuyerNotPayer() public {
        // a verified payer cannot buy for an unverified recipient (e.g. through a router or hook)
        (NativeStakeMarket.StakeOrder memory o,) = _listVerified();
        address payer = makeAddr("payer");
        _attest(payer);
        weth.mint(payer, 40 ether);
        vm.deal(payer, 1);
        vm.startPrank(payer);
        weth.approve(address(market), type(uint256).max);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BuyerNotEligible.selector, buyer));
        market.fill{value: 1}(o, "", targetPubkey, p, buyer);
        vm.stopPrank();
    }

    function test_verifiedListing_eligibilityExpiryBlocksFill() public {
        (NativeStakeMarket.StakeOrder memory o,) = _listVerified();
        _attest(buyer);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BuyerNotEligible.selector, buyer));
        market.fill{value: 1}(o, "", targetPubkey, p, buyer);
    }

    function test_openListing_unaffected() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.prank(seller);
        bytes32 hash = market.listOrder(o);
        assertEq(address(market.policyOf(hash)), address(0));
        vm.prank(buyer);
        market.fill{value: 1}(o, "", targetPubkey, _defaultProofs(), buyer);
    }

    function test_listOrderWithPolicy_onlySeller() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.expectRevert(NativeStakeMarket.NotSeller.selector);
        market.listOrderWithPolicy(o, IEligibilityPolicy(address(eligibility)));
    }
}
