// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {NativeStakeMarket} from "../src/NativeStakeMarket.sol";
import {Stake7702Delegate} from "../src/Stake7702Delegate.sol";
import {BeaconProofs} from "../src/libraries/BeaconProofs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBeaconOracle} from "../src/interfaces/IBeaconOracle.sol";
import {IStakePriceOracle} from "../src/interfaces/IStakePriceOracle.sol";
import {MarketBase} from "./utils/MarketBase.sol";

contract FillTest is MarketBase {
    function test_fill_escrowsPaymentAndRequestsConsolidation() public {
        uint256 buyerEthBefore = buyer.balance;
        uint256 tradeId = _fill();

        assertEq(tradeId, 1);
        assertEq(weth.balanceOf(address(market)), 31.7 ether);
        assertEq(weth.balanceOf(buyer), 1_000 ether - 31.7 ether);

        // The predeploy saw the seller's EOA as caller, with source || target as payload.
        assertEq(predeploy.lastSource(), seller);
        assertEq(predeploy.lastRequest(), abi.encodePacked(sourcePubkey, targetPubkey));
        // Only the fee (1 wei) was spent; the rest came back to the caller.
        assertEq(buyer.balance, buyerEthBefore - 1);
        assertEq(address(market).balance, 0);

        NativeStakeMarket.Trade memory t = market.getTrade(tradeId);
        assertEq(t.seller, seller);
        assertEq(t.buyer, buyer);
        assertEq(t.sourceIndex, SOURCE_INDEX);
        assertEq(t.targetIndex, TARGET_INDEX);
        assertEq(t.amountGwei, 32 gwei);
        assertEq(t.payment, 31.7 ether);
        assertEq(uint8(t.status), uint8(NativeStakeMarket.Status.RequestSubmitted));
        assertEq(market.activeTradeBySource(SOURCE_INDEX), tradeId);
        assertTrue(market.nonceUsed(seller, 1));
    }

    function test_fill_emitsEvent() public {
        vm.expectEmit(address(market));
        emit NativeStakeMarket.OrderFilled(1, seller, buyer, SOURCE_INDEX, TARGET_INDEX, 32 gwei, 31.7 ether);
        _fill();
    }

    function test_fill_withRealEip7702Authorization() public {
        uint256 pk = 0xB0B;
        address eoa = vm.addr(pk);
        vm.signAndAttachDelegation(address(market.delegate()), pk);
        (bool ok,) = eoa.call(""); // any call carries the authorization
        assertTrue(ok);
        assertEq(eoa.code, abi.encodePacked(hex"ef0100", address(market.delegate())));
    }

    function test_fill_listedOrderWithoutSignature() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.prank(seller);
        market.listOrder(o);
        vm.prank(buyer);
        market.fill{value: 1}(o, "", targetPubkey, _defaultProofs(), buyer);
        assertEq(predeploy.requestCount(), 1);
    }

    function test_listOrder_onlySeller() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.expectRevert(NativeStakeMarket.NotSeller.selector);
        market.listOrder(o);
    }

    function test_fill_unlistedOrderWithoutSignature_reverts() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        vm.prank(buyer);
        vm.expectRevert(NativeStakeMarket.InvalidSignature.selector);
        market.fill{value: 1}(o, "", targetPubkey, _defaultProofs(), buyer);
    }

    function test_fill_payerCanDifferFromBuyer() public {
        address payer = makeAddr("payer");
        weth.mint(payer, 40 ether);
        vm.deal(payer, 1);
        vm.startPrank(payer);
        weth.approve(address(market), type(uint256).max);
        NativeStakeMarket.StakeOrder memory o = _order();
        uint256 id = market.fill{value: 1}(o, _sign(o, sellerPk), targetPubkey, _defaultProofs(), buyer);
        vm.stopPrank();
        assertEq(market.getTrade(id).buyer, buyer);
        assertEq(weth.balanceOf(payer), 40 ether - 31.7 ether);
    }

    // --- native ETH ------------------------------------------------------------------------------

    function test_fillWithEth_singleTransaction() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.deal(buyer, 40 ether);
        uint256 wethBefore = weth.balanceOf(buyer);

        vm.prank(buyer);
        uint256 id = market.fillWithEth{value: 31.7 ether + 0.01 ether}(o, sig, targetPubkey, p, buyer);

        assertEq(market.getTrade(id).payment, 31.7 ether);
        assertEq(weth.balanceOf(address(market)), 31.7 ether, "payment escrowed as WETH");
        assertEq(weth.balanceOf(buyer), wethBefore, "no WETH or approval needed");
        assertEq(buyer.balance, 40 ether - 31.7 ether - 1, "only payment + 1 wei fee spent");
        assertEq(address(market).balance, 0);
        assertEq(predeploy.lastSource(), seller);
    }

    function test_fillWithEth_revertsWhenValueBelowPayment() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.deal(buyer, 40 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.InsufficientEth.selector, 31 ether, 31.7 ether));
        market.fillWithEth{value: 31 ether}(o, sig, targetPubkey, p, buyer);
    }

    function test_fillWithEth_revertsWithoutFee() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.deal(buyer, 40 ether);
        vm.prank(buyer);
        // exactly the payment leaves nothing for the EIP-7251 fee
        vm.expectRevert(abi.encodeWithSelector(Stake7702Delegate.InsufficientFee.selector, 1, 0));
        market.fillWithEth{value: 31.7 ether}(o, sig, targetPubkey, p, buyer);
    }

    function test_fillWithEth_settlesLikeWethFill() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.deal(buyer, 40 ether);
        vm.prank(buyer);
        uint256 id = market.fillWithEth{value: 32 ether}(o, sig, targetPubkey, p, buyer);
        // refund path returns WETH to the buyer
        vm.warp(vm.getBlockTimestamp() + ACCEPT_WINDOW + 1);
        uint256 before = weth.balanceOf(buyer);
        market.refundExpired(id);
        assertEq(weth.balanceOf(buyer), before + 31.7 ether);
    }

    // --- order checks ----------------------------------------------------------------------------

    function _expectFillRevert(
        NativeStakeMarket.StakeOrder memory o,
        bytes memory sig,
        NativeStakeMarket.FillProofs memory p,
        bytes memory err
    ) internal {
        vm.prank(buyer);
        vm.expectRevert(err);
        market.fill{value: 1}(o, sig, targetPubkey, p, buyer);
    }

    function test_revert_expired() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        o.expiry = vm.getBlockTimestamp() - 1;
        _expectFillRevert(o, _sign(o, sellerPk), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.OrderExpired.selector));
    }

    function test_revert_nonceReused() public {
        _fill();
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.NonceAlreadyUsed.selector));
    }

    function test_revert_cancelled() public {
        vm.prank(seller);
        market.cancelOrder(1);
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.NonceAlreadyUsed.selector));
    }

    function test_revert_wrongSigner() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, 0xBAD), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.InvalidSignature.selector));
    }

    function test_revert_tamperedOrder() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        o.price = 1 ether;
        _expectFillRevert(o, sig, _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.InvalidSignature.selector));
    }

    function test_revert_sellerNotDelegated() public {
        vm.etch(seller, "");
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.SellerNotDelegated.selector));
    }

    function test_revert_sellerDelegatedElsewhere() public {
        vm.etch(seller, abi.encodePacked(hex"ef0100", makeAddr("other")));
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.SellerNotDelegated.selector));
    }

    // --- proof checks ----------------------------------------------------------------------------

    function test_revert_staleProof() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        p.state.timestamp = uint64(vm.getBlockTimestamp() - MAX_PROOF_AGE - 1);
        _expectFillRevert(o, _sign(o, sellerPk), p, abi.encodeWithSelector(NativeStakeMarket.StaleProof.selector));
    }

    function test_revert_sourceIndexMismatch() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        p.source.index = SOURCE_INDEX + 1;
        _expectFillRevert(o, _sign(o, sellerPk), p, abi.encodeWithSelector(NativeStakeMarket.IndexMismatch.selector));
    }

    function test_revert_sourcePubkeyMismatch() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        p.source.validator.pubkey = targetPubkey;
        _expectFillRevert(o, _sign(o, sellerPk), p, abi.encodeWithSelector(NativeStakeMarket.PubkeyMismatch.selector));
    }

    function test_revert_withdrawalAddressMismatch() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.withdrawalCredentials = _creds(0x01, makeAddr("someoneElse"));
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(s, _targetValidator()), abi.encodeWithSelector(NativeStakeMarket.WithdrawalAddressMismatch.selector));
    }

    function test_revert_blsCredentials() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.withdrawalCredentials = _creds(0x00, seller);
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(s, _targetValidator()), abi.encodeWithSelector(NativeStakeMarket.SourceNotSellable.selector));
    }

    function test_fill_compoundingSourceAllowed() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.withdrawalCredentials = _creds(0x02, seller);
        s.effectiveBalance = 64 gwei;
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        vm.prank(buyer);
        uint256 id = market.fill{value: 1}(o, sig, targetPubkey, _proofs(s, _targetValidator()), buyer);
        assertEq(market.getTrade(id).amountGwei, 64 gwei);
    }

    function test_revert_sourceExiting() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.exitEpoch = _currentEpoch() + 10;
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(s, _targetValidator()), abi.encodeWithSelector(NativeStakeMarket.SourceNotSellable.selector));
    }

    function test_revert_sourceSlashed() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.slashed = true;
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(s, _targetValidator()), abi.encodeWithSelector(NativeStakeMarket.SourceNotSellable.selector));
    }

    function test_revert_sourceTooYoung() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.activationEpoch = _currentEpoch() - 10; // < SHARD_COMMITTEE_PERIOD epochs ago
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(s, _targetValidator()), abi.encodeWithSelector(NativeStakeMarket.SourceNotSellable.selector));
    }

    function test_revert_sourceTooYoungAtProvenSlot() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        NativeStakeMarket.FillProofs memory p = _proofs(s, _targetValidator());
        uint64 epoch = market.epochOf(p.state);
        p.source.validator.activationEpoch = epoch - 256; // old enough by the timestamp ...
        p.state.slot -= 32; // ... but the proven state is one epoch earlier (missed slots)
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), p, abi.encodeWithSelector(NativeStakeMarket.SourceNotSellable.selector));
    }

    function test_revert_sourceNotYetActive() public {
        BeaconProofs.Validator memory s = _sourceValidator();
        s.activationEpoch = FAR;
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(s, _targetValidator()), abi.encodeWithSelector(NativeStakeMarket.SourceNotSellable.selector));
    }

    function test_revert_targetPubkeyMismatch() public {
        BeaconProofs.Validator memory t = _targetValidator();
        t.pubkey = sourcePubkey;
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(_sourceValidator(), t), abi.encodeWithSelector(NativeStakeMarket.PubkeyMismatch.selector));
    }

    function test_revert_targetNotCompounding() public {
        BeaconProofs.Validator memory t = _targetValidator();
        t.withdrawalCredentials = _creds(0x01, buyer);
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(_sourceValidator(), t), abi.encodeWithSelector(NativeStakeMarket.TargetNotEligible.selector));
    }

    function test_revert_targetExiting() public {
        BeaconProofs.Validator memory t = _targetValidator();
        t.exitEpoch = _currentEpoch() + 1;
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(_sourceValidator(), t), abi.encodeWithSelector(NativeStakeMarket.TargetNotEligible.selector));
    }

    function test_revert_targetIsSource() public {
        NativeStakeMarket.StakeOrder memory o = _order();
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        p.target.index = SOURCE_INDEX;
        _expectFillRevert(o, _sign(o, sellerPk), p, abi.encodeWithSelector(NativeStakeMarket.TargetNotEligible.selector));
    }

    function test_revert_targetCapacity() public {
        BeaconProofs.Validator memory t = _targetValidator();
        t.effectiveBalance = 2017 gwei; // 2017 + 32 > 2048
        NativeStakeMarket.StakeOrder memory o = _order();
        _expectFillRevert(o, _sign(o, sellerPk), _proofs(_sourceValidator(), t), abi.encodeWithSelector(NativeStakeMarket.TargetCapacityExceeded.selector));
    }

    function test_fill_targetExactlyAtCapacity() public {
        BeaconProofs.Validator memory t = _targetValidator();
        t.effectiveBalance = 2016 gwei;
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        vm.prank(buyer);
        market.fill{value: 1}(o, sig, targetPubkey, _proofs(_sourceValidator(), t), buyer);
    }

    function test_revert_sourceAlreadyTrading() public {
        _fill();
        NativeStakeMarket.StakeOrder memory o = _order();
        o.nonce = 2;
        _expectFillRevert(o, _sign(o, sellerPk), _defaultProofs(), abi.encodeWithSelector(NativeStakeMarket.SourceAlreadyTrading.selector));
    }

    function test_revert_insufficientFee() public {
        predeploy.setFee(1 ether);
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk);
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Stake7702Delegate.InsufficientFee.selector, 1 ether, 0.5 ether));
        market.fill{value: 0.5 ether}(o, sig, targetPubkey, p, buyer);
    }

    // --- pricing ---------------------------------------------------------------------------------

    function test_lstRelativePricing() public {
        priceOracle.set(0.998e18); // market prices staked ETH at a 20 bps discount
        NativeStakeMarket.StakeOrder memory o = _order();
        o.priceMode = NativeStakeMarket.PriceMode.LstRelative;
        o.price = 30; // seller sells 30 bps below that reference
        o.minPayment = 31 ether;
        bytes memory sig = _sign(o, sellerPk);
        vm.prank(buyer);
        uint256 id = market.fill{value: 1}(o, sig, targetPubkey, _defaultProofs(), buyer);
        // 32 * 0.998 * (1 - 0.003) = 31.840192
        assertEq(market.getTrade(id).payment, 31.840192 ether);
    }

    function test_revert_lstRelativeBelowMinimum() public {
        priceOracle.set(0.9e18);
        NativeStakeMarket.StakeOrder memory o = _order();
        o.priceMode = NativeStakeMarket.PriceMode.LstRelative;
        o.price = 30;
        o.minPayment = 31 ether;
        _expectFillRevert(
            o,
            _sign(o, sellerPk),
            _defaultProofs(),
            abi.encodeWithSelector(NativeStakeMarket.PriceBelowMinimum.selector, 28.7136 ether, 31 ether)
        );
    }

    function testFuzz_lstRelativeQuote(uint256 priceWad, uint16 bps) public {
        priceWad = bound(priceWad, 0.5e18, 1.1e18);
        bps = uint16(bound(bps, 0, 10_000));
        priceOracle.set(priceWad);
        NativeStakeMarket.StakeOrder memory o = _order();
        o.priceMode = NativeStakeMarket.PriceMode.LstRelative;
        o.price = bps;
        uint256 q = market.quote(o, 32 gwei);
        assertLe(q, 32 ether * priceWad / 1e18);
        assertEq(q, (32 ether * priceWad / 1e18) * (10_000 - bps) / 10_000);
    }
}

contract DelegateTest is MarketBase {
    function test_onlyMarketCanRequest() public {
        vm.prank(buyer);
        vm.expectRevert(Stake7702Delegate.OnlyMarket.selector);
        Stake7702Delegate(payable(seller)).requestConsolidation{value: 1}(sourcePubkey, targetPubkey);
    }

    function test_rejectsBadPubkeyLength() public {
        vm.deal(address(market), 1);
        vm.prank(address(market));
        vm.expectRevert(Stake7702Delegate.InvalidPubkeyLength.selector);
        Stake7702Delegate(payable(seller)).requestConsolidation{value: 1}(hex"01", targetPubkey);
    }

    function test_delegatedEoaStillReceivesEth() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        (bool ok,) = seller.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(seller.balance, 1 ether);
    }

    function test_feeView() public {
        predeploy.setFee(7);
        assertEq(Stake7702Delegate(payable(seller)).consolidationFee(), 7);
    }
}

contract SettlementTest is MarketBase {
    uint256 tradeId;
    uint64 withdrawableEpoch;

    function setUp() public override {
        super.setUp();
        tradeId = _fill();
        withdrawableEpoch = _currentEpoch() + 300;
    }

    function _status() internal view returns (NativeStakeMarket.Status) {
        return market.getTrade(tradeId).status;
    }

    function _warpToEpoch(uint64 epoch) internal {
        vm.warp(MAINNET_GENESIS + uint256(epoch) * 32 * 12 + 1);
    }

    // --- checkpoint 1 ----------------------------------------------------------------------------

    function test_proveAccepted() public {
        vm.expectEmit(address(market));
        emit NativeStakeMarket.ConsolidationAccepted(tradeId, withdrawableEpoch);
        vm.prank(relayer);
        _accept(tradeId, withdrawableEpoch);
        assertEq(uint8(_status()), uint8(NativeStakeMarket.Status.Accepted));
        assertEq(market.getTrade(tradeId).withdrawableEpoch, withdrawableEpoch);
    }

    function test_proveAccepted_revertsOnOtherTarget() public {
        vm.warp(vm.getBlockTimestamp() + 24);
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp());
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_exitingSource(withdrawableEpoch));
        vm.expectRevert(NativeStakeMarket.IndexMismatch.selector);
        market.proveAccepted(tradeId, st, _pending(SOURCE_INDEX, TARGET_INDEX + 1), sp);
    }

    function test_proveAccepted_revertsOnProofBeforeFill() public {
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp()); // same block as the fill
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_exitingSource(withdrawableEpoch));
        vm.expectRevert(NativeStakeMarket.ProofBeforeFill.selector);
        market.proveAccepted(tradeId, st, _pending(SOURCE_INDEX, TARGET_INDEX), sp);
    }

    function test_proveAccepted_revertsOnWrongSourcePubkey() public {
        vm.warp(vm.getBlockTimestamp() + 24);
        BeaconProofs.Validator memory v = _exitingSource(withdrawableEpoch);
        v.pubkey = targetPubkey;
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp());
        vm.expectRevert(NativeStakeMarket.PubkeyMismatch.selector);
        market.proveAccepted(tradeId, st, _pending(SOURCE_INDEX, TARGET_INDEX), _sourceProof(v));
    }

    function test_proveAccepted_onlyOnce() public {
        _accept(tradeId, withdrawableEpoch);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BadStatus.selector, NativeStakeMarket.Status.Accepted));
        _accept(tradeId, withdrawableEpoch);
    }

    // --- checkpoint 2 ----------------------------------------------------------------------------

    function _deliver(BeaconProofs.Validator memory v, uint64 balanceGwei) internal {
        market.proveDelivered(tradeId, _state(vm.getBlockTimestamp()), _sourceProof(v), _balance(SOURCE_INDEX, balanceGwei));
    }

    function test_proveDelivered_paysSeller() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch);

        vm.expectEmit(address(market));
        emit NativeStakeMarket.StakeDelivered(tradeId, 31.7 ether);
        vm.prank(relayer);
        _deliver(_exitingSource(withdrawableEpoch), 0.01 gwei);

        assertEq(uint8(_status()), uint8(NativeStakeMarket.Status.Delivered));
        assertEq(weth.balanceOf(seller), 31.7 ether);
        assertEq(weth.balanceOf(address(market)), 0);
        assertEq(market.activeTradeBySource(SOURCE_INDEX), 0);
    }

    function test_proveDelivered_revertsBeforeWithdrawableEpoch() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch - 1);
        BeaconProofs.Validator memory v = _exitingSource(withdrawableEpoch);
        vm.expectRevert(NativeStakeMarket.NotDelivered.selector);
        _deliver(v, 0);
    }

    /// Missed slots make the EIP-4788 timestamp run ahead of the proven state: the epoch comes from the
    /// header slot, not from the timestamp.
    function test_proveDelivered_usesProvenSlotNotTimestamp() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch);
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp());
        st.slot = uint64(withdrawableEpoch) * 32 - 1; // last slot of the previous epoch
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_exitingSource(withdrawableEpoch));
        BeaconProofs.BalanceProof memory bp = _balance(SOURCE_INDEX, 0);
        vm.expectRevert(NativeStakeMarket.NotDelivered.selector);
        market.proveDelivered(tradeId, st, sp, bp);

        st.slot += 1;
        market.proveDelivered(tradeId, st, sp, bp);
        assertEq(uint8(_status()), uint8(NativeStakeMarket.Status.Delivered));
    }

    function test_proveDelivered_revertsWhileBalanceRemains() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch);
        BeaconProofs.Validator memory v = _exitingSource(withdrawableEpoch);
        vm.expectRevert(NativeStakeMarket.NotDelivered.selector);
        _deliver(v, 32 gwei);
    }

    function test_proveDelivered_revertsIfSlashed() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch);
        BeaconProofs.Validator memory v = _exitingSource(withdrawableEpoch);
        v.slashed = true;
        vm.expectRevert(NativeStakeMarket.NotDelivered.selector);
        _deliver(v, 0);
    }

    function test_proveDelivered_revertsOnBalanceOfOtherValidator() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch);
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp());
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_exitingSource(withdrawableEpoch));
        BeaconProofs.BalanceProof memory bp = _balance(TARGET_INDEX, 0);
        vm.expectRevert(NativeStakeMarket.IndexMismatch.selector);
        market.proveDelivered(tradeId, st, sp, bp);
    }

    function test_proveDelivered_requiresAccepted() public {
        _warpToEpoch(withdrawableEpoch);
        BeaconProofs.Validator memory v = _exitingSource(withdrawableEpoch);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BadStatus.selector, NativeStakeMarket.Status.RequestSubmitted));
        _deliver(v, 0);
    }

    // --- failure paths ---------------------------------------------------------------------------

    function _pastDequeueDelay() internal {
        vm.warp(market.getTrade(tradeId).filledAt + market.REQUEST_DEQUEUE_DELAY() + 12);
    }

    function test_proveNotAccepted_refundsBuyer() public {
        _pastDequeueDelay();
        vm.expectEmit(address(market));
        emit NativeStakeMarket.TradeFailed(tradeId, 31.7 ether);
        market.proveNotAccepted(tradeId, _state(vm.getBlockTimestamp()), _sourceProof(_sourceValidator()));
        assertEq(uint8(_status()), uint8(NativeStakeMarket.Status.Failed));
        assertEq(weth.balanceOf(buyer), 1_000 ether);
        assertEq(market.activeTradeBySource(SOURCE_INDEX), 0);
    }

    function test_proveNotAccepted_revertsIfExitInitiated() public {
        _pastDequeueDelay();
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp());
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_exitingSource(withdrawableEpoch));
        vm.expectRevert(NativeStakeMarket.NotFailed.selector);
        market.proveNotAccepted(tradeId, st, sp);
    }

    function test_proveNotAccepted_revertsOnPreFillState() public {
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp() - 12);
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_sourceValidator());
        vm.expectRevert(NativeStakeMarket.RequestMayBeQueued.selector);
        market.proveNotAccepted(tradeId, st, sp);
    }

    /// A state right after the fill may predate the request leaving the EIP-7251 queue: refunding on it
    /// would let a buyer who queued junk requests ahead of the fill keep both the refund and the stake.
    function test_proveNotAccepted_revertsWhileRequestMayBeQueued() public {
        uint256 limit = market.getTrade(tradeId).filledAt + market.REQUEST_DEQUEUE_DELAY();
        vm.warp(limit + 12);
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_sourceValidator());
        BeaconProofs.StateRootProof memory early = _state(vm.getBlockTimestamp() - 12 - 24);
        vm.expectRevert(NativeStakeMarket.RequestMayBeQueued.selector);
        market.proveNotAccepted(tradeId, early, sp);

        market.proveNotAccepted(tradeId, _state(limit + 12), sp);
        assertEq(uint8(_status()), uint8(NativeStakeMarket.Status.Failed));
    }

    function test_proveFailed_slashedAfterAcceptance() public {
        _accept(tradeId, withdrawableEpoch);
        BeaconProofs.Validator memory v = _exitingSource(withdrawableEpoch);
        v.slashed = true;
        market.proveFailed(tradeId, _state(vm.getBlockTimestamp() + 12), _sourceProof(v));
        assertEq(uint8(_status()), uint8(NativeStakeMarket.Status.Failed));
        assertEq(weth.balanceOf(buyer), 1_000 ether);
    }

    function test_proveFailed_revertsIfNotSlashed() public {
        _accept(tradeId, withdrawableEpoch);
        BeaconProofs.StateRootProof memory st = _state(vm.getBlockTimestamp() + 12);
        BeaconProofs.ValidatorProof memory sp = _sourceProof(_exitingSource(withdrawableEpoch));
        vm.expectRevert(NativeStakeMarket.NotFailed.selector);
        market.proveFailed(tradeId, st, sp);
    }

    function test_refundExpired() public {
        vm.warp(vm.getBlockTimestamp() + ACCEPT_WINDOW);
        vm.expectRevert(NativeStakeMarket.AcceptWindowOpen.selector);
        market.refundExpired(tradeId);

        vm.warp(vm.getBlockTimestamp() + 1);
        market.refundExpired(tradeId);
        assertEq(weth.balanceOf(buyer), 1_000 ether);
    }

    function test_refundExpired_notAfterAcceptance() public {
        _accept(tradeId, withdrawableEpoch);
        vm.warp(vm.getBlockTimestamp() + ACCEPT_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BadStatus.selector, NativeStakeMarket.Status.Accepted));
        market.refundExpired(tradeId);
    }

    function test_noDoubleSettlement() public {
        _accept(tradeId, withdrawableEpoch);
        _warpToEpoch(withdrawableEpoch);
        _deliver(_exitingSource(withdrawableEpoch), 0);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BadStatus.selector, NativeStakeMarket.Status.Delivered));
        _deliver(_exitingSource(withdrawableEpoch), 0);
        vm.expectRevert(abi.encodeWithSelector(NativeStakeMarket.BadStatus.selector, NativeStakeMarket.Status.Delivered));
        market.proveFailed(tradeId, _state(vm.getBlockTimestamp()), _sourceProof(_exitingSource(withdrawableEpoch)));
    }

    function test_sourceCanBeSoldAgainAfterFailure() public {
        vm.warp(vm.getBlockTimestamp() + ACCEPT_WINDOW + 1);
        market.refundExpired(tradeId);
        NativeStakeMarket.StakeOrder memory o = _order();
        o.nonce = 2;
        o.expiry = vm.getBlockTimestamp() + 1 days;
        NativeStakeMarket.FillProofs memory p = _defaultProofs();
        bytes memory sig = _sign(o, sellerPk);
        vm.prank(buyer);
        uint256 id2 = market.fill{value: 1}(o, sig, targetPubkey, p, buyer);
        assertEq(id2, 2);
    }
}

contract ConstructorTest is MarketBase {
    IBeaconOracle oracle;

    function _deploy(uint256 acceptWindow) internal {
        new NativeStakeMarket(
            IERC20(address(weth)), oracle, IStakePriceOracle(address(0)), MAINNET_GENESIS, 1 hours, acceptWindow
        );
    }

    /// The accept window must outlast the dequeue delay and end while acceptance is still provable.
    function test_acceptWindowBounds() public {
        uint256 delay = market.REQUEST_DEQUEUE_DELAY();
        uint256 max = market.MAX_ACCEPT_WINDOW();
        oracle = market.beaconOracle();
        vm.expectRevert(NativeStakeMarket.InvalidAcceptWindow.selector);
        _deploy(delay);
        vm.expectRevert(NativeStakeMarket.InvalidAcceptWindow.selector);
        _deploy(max + 1);
        _deploy(delay + 1);
        _deploy(max);
    }
}
