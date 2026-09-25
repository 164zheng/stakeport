// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NativeStakeMarket} from "../../src/NativeStakeMarket.sol";
import {IBeaconOracle} from "../../src/interfaces/IBeaconOracle.sol";
import {IStakePriceOracle} from "../../src/interfaces/IStakePriceOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";
import {MockBeaconOracle, MockConsolidationPredeploy, MockPriceOracle, MockWETH} from "../mocks/Mocks.sol";

/// @notice Market deployed against mock beacon proofs and a mock EIP-7251 predeploy.
abstract contract MarketBase is Test {
    address constant CONSOLIDATION_REQUEST = 0x0000BBdDc7CE488642fb579F8B00f3a590007251;
    uint256 constant MAINNET_GENESIS = 1606824023;
    uint256 constant MAX_PROOF_AGE = 1 days;
    uint256 constant ACCEPT_WINDOW = 1 days;
    uint64 constant FAR = type(uint64).max;
    uint64 constant SOURCE_INDEX = 1_000_060;
    uint64 constant TARGET_INDEX = 42;

    NativeStakeMarket market;
    MockWETH weth;
    MockPriceOracle priceOracle;
    MockConsolidationPredeploy predeploy;

    uint256 sellerPk = 0xA11CE;
    address seller;
    address buyer = makeAddr("buyer");
    address relayer = makeAddr("relayer");

    bytes sourcePubkey = abi.encodePacked(keccak256("source"), bytes16(keccak256("source-tail")));
    bytes targetPubkey = abi.encodePacked(keccak256("target"), bytes16(keccak256("target-tail")));

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        seller = vm.addr(sellerPk);

        weth = new MockWETH();
        priceOracle = new MockPriceOracle();
        market = new NativeStakeMarket(
            IERC20(address(weth)),
            IBeaconOracle(address(new MockBeaconOracle())),
            IStakePriceOracle(address(priceOracle)),
            MAINNET_GENESIS,
            MAX_PROOF_AGE,
            ACCEPT_WINDOW
        );

        vm.etch(CONSOLIDATION_REQUEST, address(new MockConsolidationPredeploy()).code);
        predeploy = MockConsolidationPredeploy(payable(CONSOLIDATION_REQUEST));
        predeploy.setFee(1);

        _delegate(seller);

        weth.mint(buyer, 1_000 ether);
        vm.prank(buyer);
        weth.approve(address(market), type(uint256).max);
        vm.deal(buyer, 1 ether);
    }

    // --- builders --------------------------------------------------------------------------------

    function _delegate(address eoa) internal {
        vm.etch(eoa, abi.encodePacked(hex"ef0100", address(market.delegate())));
    }

    function _currentEpoch() internal view returns (uint64) {
        return market.epochAt(vm.getBlockTimestamp());
    }

    function _order() internal view returns (NativeStakeMarket.StakeOrder memory) {
        return NativeStakeMarket.StakeOrder({
            seller: seller,
            sourcePubkey: sourcePubkey,
            sourceIndex: SOURCE_INDEX,
            priceMode: NativeStakeMarket.PriceMode.Fixed,
            price: 31.7 ether,
            minPayment: 0,
            expiry: vm.getBlockTimestamp() + 1 days,
            nonce: 1
        });
    }

    function _sign(NativeStakeMarket.StakeOrder memory o, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, market.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function _creds(uint8 prefix, address a) internal pure returns (bytes32) {
        return bytes32((uint256(prefix) << 248) | uint256(uint160(a)));
    }

    function _sourceValidator() internal view returns (BeaconProofs.Validator memory) {
        return BeaconProofs.Validator({
            pubkey: sourcePubkey,
            withdrawalCredentials: _creds(0x01, seller),
            effectiveBalance: 32 gwei,
            slashed: false,
            activationEligibilityEpoch: 100,
            activationEpoch: 101,
            exitEpoch: FAR,
            withdrawableEpoch: FAR
        });
    }

    function _targetValidator() internal view returns (BeaconProofs.Validator memory) {
        return BeaconProofs.Validator({
            pubkey: targetPubkey,
            withdrawalCredentials: _creds(0x02, buyer),
            effectiveBalance: 512 gwei,
            slashed: false,
            activationEligibilityEpoch: 10,
            activationEpoch: 11,
            exitEpoch: FAR,
            withdrawableEpoch: FAR
        });
    }

    function _state(uint256 timestamp) internal pure returns (BeaconProofs.StateRootProof memory) {
        return BeaconProofs.StateRootProof({
            timestamp: uint64(timestamp),
            stateRoot: keccak256(abi.encode(timestamp)),
            branch: new bytes32[](0)
        });
    }

    function _proofs(BeaconProofs.Validator memory s, BeaconProofs.Validator memory t)
        internal
        view
        returns (NativeStakeMarket.FillProofs memory)
    {
        return NativeStakeMarket.FillProofs({
            state: _state(vm.getBlockTimestamp() - 12),
            source: BeaconProofs.ValidatorProof({index: SOURCE_INDEX, validator: s, branch: new bytes32[](0)}),
            target: BeaconProofs.ValidatorProof({index: TARGET_INDEX, validator: t, branch: new bytes32[](0)})
        });
    }

    function _defaultProofs() internal view returns (NativeStakeMarket.FillProofs memory) {
        return _proofs(_sourceValidator(), _targetValidator());
    }

    function _fill() internal returns (uint256 tradeId) {
        NativeStakeMarket.StakeOrder memory o = _order();
        bytes memory sig = _sign(o, sellerPk); // sign before prank: hashOrder is an external call
        vm.prank(buyer);
        tradeId = market.fill{value: 0.01 ether}(o, sig, targetPubkey, _defaultProofs(), buyer);
    }

    function _sourceProof(BeaconProofs.Validator memory v) internal pure returns (BeaconProofs.ValidatorProof memory) {
        return BeaconProofs.ValidatorProof({index: SOURCE_INDEX, validator: v, branch: new bytes32[](0)});
    }

    function _pending(uint64 source, uint64 target)
        internal
        pure
        returns (BeaconProofs.PendingConsolidationProof memory)
    {
        return BeaconProofs.PendingConsolidationProof({
            queueIndex: 7,
            sourceIndex: source,
            targetIndex: target,
            branch: new bytes32[](0)
        });
    }

    function _balance(uint64 index, uint64 gweiAmount) internal pure returns (BeaconProofs.BalanceProof memory) {
        return BeaconProofs.BalanceProof({index: index, chunk: bytes32(uint256(gweiAmount)), branch: new bytes32[](0)});
    }

    /// @dev Source validator as seen after the consolidation request was processed.
    function _exitingSource(uint64 withdrawableEpoch) internal view returns (BeaconProofs.Validator memory v) {
        v = _sourceValidator();
        v.exitEpoch = withdrawableEpoch - 256;
        v.withdrawableEpoch = withdrawableEpoch;
    }

    function _accept(uint256 tradeId, uint64 withdrawableEpoch) internal {
        vm.warp(vm.getBlockTimestamp() + 24);
        market.proveAccepted(
            tradeId,
            _state(vm.getBlockTimestamp()),
            _pending(SOURCE_INDEX, TARGET_INDEX),
            _sourceProof(_exitingSource(withdrawableEpoch))
        );
    }
}
