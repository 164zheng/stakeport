// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IBeaconOracle} from "../../src/interfaces/IBeaconOracle.sol";
import {IStakePriceOracle} from "../../src/interfaces/IStakePriceOracle.sol";
import {BeaconProofs} from "../../src/libraries/BeaconProofs.sol";

/// @notice Accepts every proof. Market logic is tested with it; proofs are tested separately.
/// Balance proofs return the chunk's low 64 bits as the balance.
contract MockBeaconOracle is IBeaconOracle {
    function verifiedStateRoot(BeaconProofs.StateRootProof calldata p) external pure returns (bytes32) {
        return p.stateRoot;
    }

    function verifyValidator(bytes32, BeaconProofs.ValidatorProof calldata) external pure {}

    function verifyBalance(bytes32, BeaconProofs.BalanceProof calldata p) external pure returns (uint64) {
        return uint64(uint256(p.chunk));
    }

    function verifyPendingConsolidation(bytes32, BeaconProofs.PendingConsolidationProof calldata) external pure {}

    function verifySlot(bytes32, BeaconProofs.SlotProof calldata) external pure {}
}

/// @notice Stand-in for the EIP-7251 predeploy: empty calldata returns the fee, 96 bytes queue a request.
contract MockConsolidationPredeploy {
    uint256 public fee = 1;
    address public lastSource;
    bytes public lastRequest;
    uint256 public requestCount;

    function setFee(uint256 f) external {
        fee = f;
    }

    fallback(bytes calldata data) external payable returns (bytes memory) {
        if (data.length == 0) return abi.encode(fee);
        require(data.length == 96, "bad length");
        require(msg.value >= fee, "fee");
        lastSource = msg.sender;
        lastRequest = data;
        requestCount++;
        return "";
    }
}

contract MockWETH is ERC20("Wrapped Ether", "WETH") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockPriceOracle is IStakePriceOracle {
    uint256 public stakedEthPrice = 1e18;

    function set(uint256 p) external {
        stakedEthPrice = p;
    }
}
