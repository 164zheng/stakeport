// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ISwapVM} from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/libs/TakerTraits.sol";
import {BalancesArgsBuilder} from "@1inch/swap-vm/instructions/Balances.sol";
import {ControlsArgsBuilder} from "@1inch/swap-vm/instructions/Controls.sol";
import {DutchAuctionArgsBuilder} from "@1inch/swap-vm/instructions/DutchAuction.sol";
import {LimitSwapArgsBuilder} from "@1inch/swap-vm/instructions/LimitSwap.sol";

import {NativeStakeMarket} from "../NativeStakeMarket.sol";
import {IAqua} from "./IAqua.sol";

/// @title AquaStakeBidApp
/// @notice Self-custodial standing bids for native validator stake, built on 1inch Aqua and priced by
/// 1inch SwapVM.
///
/// A buyer ships a `StakeBid` strategy to Aqua with a WETH budget. The WETH stays in the buyer's
/// wallet; Aqua only records a virtual balance for this app. The bid's price is a SwapVM program
/// (e.g. a Dutch auction that raises the offer every second until a seller accepts), evaluated with
/// SwapVM's `quote` for the stake being sold. Native stake is not a token, so the program prices a
/// marker asset (`STAKE_UNIT`, 1 unit = 1 wei of stake) against WETH; no SwapVM transfer happens.
/// When a StakePort listing is priced at or below the bid, anyone can `matchBid`: Aqua pulls exactly
/// the listing's price from the buyer's wallet into the StakePort escrow.
contract AquaStakeBidApp is ReentrancyGuardTransient {
    /// @notice Marker "token" for 1 wei of native stake in SwapVM programs. Never transferred.
    address public constant STAKE_UNIT = 0x0000000000000000000000000000000000057a4e;

    // Opcodes of the deployed 1inch SwapVMRouter v1.0.2 (verified against its opcode table in tests).
    uint8 internal constant OP_STATIC_BALANCES = 17;
    uint8 internal constant OP_LIMIT_SWAP = 25;
    uint8 internal constant OP_DUTCH_AUCTION_BALANCE_OUT = 30;
    uint8 internal constant OP_SALT = 34;

    /// @notice Aqua strategy. Immutable once shipped; re-price with dock + ship.
    struct StakeBid {
        address maker;
        /// @dev 0x02 validator that receives the stake
        bytes targetPubkey;
        /// @dev hard cap: maximum WETH per 1 ETH of stake (1e18 = par)
        uint256 maxPriceWad;
        /// @dev accepted stake size per fill, in gwei
        uint64 minStakeGwei;
        uint64 maxStakeGwei;
        bytes32 salt;
        /// @dev SwapVM order pricing STAKE_UNIT -> WETH for this maker (empty data = cap only)
        ISwapVM.Order pricing;
    }

    IAqua public immutable aqua;
    NativeStakeMarket public immutable market;
    IERC20 public immutable weth;
    ISwapVM public immutable swapVm;

    event BidMatched(
        bytes32 indexed strategyHash,
        address indexed maker,
        uint256 indexed tradeId,
        uint64 sourceIndex,
        uint64 amountGwei,
        uint256 payment,
        uint256 bidPrice
    );

    error StakeSizeOutOfRange(uint64 amountGwei);
    error PriceAboveBid(uint256 payment, uint256 limit);
    error InsufficientBidBalance(uint256 available, uint256 payment);
    error PricingMakerMismatch();
    error SwapVmQuoteFailed(bytes reason);
    error EthRefundFailed();

    constructor(IAqua aqua_, NativeStakeMarket market_, ISwapVM swapVm_) {
        aqua = aqua_;
        market = market_;
        swapVm = swapVm_;
        weth = market_.weth();
        weth.approve(address(market_), type(uint256).max);
    }

    // ---------------------------------------------------------------------------------------------
    // Pricing
    // ---------------------------------------------------------------------------------------------

    function strategyHash(StakeBid calldata bid) public pure returns (bytes32) {
        return keccak256(abi.encode(bid));
    }

    /// @notice WETH still available to this bid (virtual Aqua balance).
    function available(StakeBid calldata bid) public view returns (uint256 balance) {
        (balance,) = aqua.rawBalances(bid.maker, address(this), strategyHash(bid), address(weth));
    }

    /// @notice WETH the bid's SwapVM program pays right now for `amountGwei` of stake.
    function swapVmPrice(ISwapVM.Order calldata order, uint64 amountGwei) public view returns (uint256 amountOut) {
        bytes memory takerData = TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: false,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
        // SwapVM's quote runs the program in a static context (no signature check, no transfers).
        (bool ok, bytes memory ret) = address(swapVm).staticcall(
            abi.encodeCall(ISwapVM.quote, (order, STAKE_UNIT, address(weth), uint256(amountGwei) * 1 gwei, takerData))
        );
        if (!ok) revert SwapVmQuoteFailed(ret);
        (, amountOut,) = abi.decode(ret, (uint256, uint256, bytes32));
    }

    /// @notice Highest payment the bid accepts now for `amountGwei` of stake: the SwapVM price, capped
    /// by `maxPriceWad`.
    function limit(StakeBid calldata bid, uint64 amountGwei) public view returns (uint256 max) {
        max = uint256(amountGwei) * 1 gwei * bid.maxPriceWad / 1e18;
        if (bid.pricing.data.length != 0) {
            if (bid.pricing.maker != bid.maker) revert PricingMakerMismatch();
            uint256 p = swapVmPrice(bid.pricing, amountGwei);
            if (p < max) max = p;
        }
    }

    /// @notice Builds a SwapVM Dutch-auction bid: starts at `startPriceWad` WETH per ETH of stake and
    /// raises the offer by 1/decayFactor every second until `startTime + duration` (then it expires).
    function buildDutchBid(
        address maker,
        uint256 startPriceWad,
        uint40 startTime,
        uint16 duration,
        uint64 decayFactor,
        uint64 salt
    ) external pure returns (ISwapVM.Order memory) {
        address[] memory tokens = new address[](2);
        tokens[0] = STAKE_UNIT;
        tokens[1] = WETH_ADDRESS;
        uint256[] memory balances = new uint256[](2);
        balances[0] = 1e18;
        balances[1] = startPriceWad;
        bytes memory program = bytes.concat(
            _instr(OP_STATIC_BALANCES, BalancesArgsBuilder.build(tokens, balances)),
            _instr(OP_DUTCH_AUCTION_BALANCE_OUT, DutchAuctionArgsBuilder.build(startTime, duration, decayFactor)),
            _instr(OP_LIMIT_SWAP, LimitSwapArgsBuilder.build(STAKE_UNIT, WETH_ADDRESS)),
            _instr(OP_SALT, ControlsArgsBuilder.buildSalt(salt))
        );
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: false,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    address internal constant WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function _instr(uint8 opcode, bytes memory args) internal pure returns (bytes memory) {
        return abi.encodePacked(opcode, uint8(args.length), args);
    }

    // ---------------------------------------------------------------------------------------------
    // Matching
    // ---------------------------------------------------------------------------------------------

    /// @notice Fills a StakePort listing against a standing Aqua bid. Permissionless: the seller,
    /// the buyer or a keeper can call it. `msg.value` pays the EIP-7251 fee (excess refunded).
    function matchBid(
        StakeBid calldata bid,
        NativeStakeMarket.StakeOrder calldata order,
        bytes calldata signature,
        NativeStakeMarket.FillProofs calldata proofs
    ) external payable nonReentrant returns (uint256 tradeId) {
        bytes32 hash = strategyHash(bid);
        uint64 amountGwei = proofs.source.validator.effectiveBalance;
        if (amountGwei < bid.minStakeGwei || amountGwei > bid.maxStakeGwei) revert StakeSizeOutOfRange(amountGwei);

        uint256 payment = market.quote(order, amountGwei);
        uint256 max = limit(bid, amountGwei);
        if (payment > max) revert PriceAboveBid(payment, max);
        uint256 balance = available(bid);
        if (balance < payment) revert InsufficientBidBalance(balance, payment);

        // Funds move from the buyer's wallet only now, straight through Aqua.
        aqua.pull(bid.maker, hash, address(weth), payment, address(this));

        uint256 ethBefore = address(this).balance - msg.value;
        tradeId = market.fill{value: msg.value}(order, signature, bid.targetPubkey, proofs, bid.maker);
        uint256 refund = address(this).balance - ethBefore;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert EthRefundFailed();
        }
        emit BidMatched(hash, bid.maker, tradeId, order.sourceIndex, amountGwei, payment, max);
    }

    /// @dev Receives the market's unused EIP-7251 fee refund.
    receive() external payable {}
}
