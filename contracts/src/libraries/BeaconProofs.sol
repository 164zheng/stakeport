// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice SSZ Merkle proof verification for Fulu `BeaconState` fields.
/// @dev Generalized indices are derived from the Fulu container layout (38 BeaconState fields,
/// padded to 64 leaves). They are checked against lodestar in proof-generator/src/gindices.ts.
library BeaconProofs {
    uint64 internal constant FAR_FUTURE_EPOCH = type(uint64).max;

    /// BeaconBlockHeader.state_root
    uint256 internal constant STATE_ROOT_GINDEX = 11;
    /// BeaconState.slot
    uint256 internal constant SLOT_GINDEX = 66;
    /// BeaconState.validators[0]: (64 + 11) * 2 (list data root) * 2^40
    uint256 internal constant VALIDATORS_BASE_GINDEX = 150 << 40;
    /// BeaconState.balances chunk 0: (64 + 12) * 2 * 2^38 (4 balances per chunk)
    uint256 internal constant BALANCES_BASE_GINDEX = 152 << 38;
    /// BeaconState.pending_consolidations[0]: (64 + 36) * 2 * 2^18
    uint256 internal constant PENDING_CONSOLIDATIONS_BASE_GINDEX = 200 << 18;
    uint256 internal constant VALIDATOR_REGISTRY_LIMIT = 1 << 40;
    uint256 internal constant PENDING_CONSOLIDATIONS_LIMIT = 1 << 18;

    struct StateRootProof {
        /// @dev EIP-4788 key: timestamp of the execution block whose parent beacon block root is proven.
        uint64 timestamp;
        bytes32 stateRoot;
        bytes32[] branch;
    }

    struct Validator {
        bytes pubkey;
        bytes32 withdrawalCredentials;
        uint64 effectiveBalance;
        bool slashed;
        uint64 activationEligibilityEpoch;
        uint64 activationEpoch;
        uint64 exitEpoch;
        uint64 withdrawableEpoch;
    }

    struct ValidatorProof {
        uint64 index;
        Validator validator;
        bytes32[] branch;
    }

    struct BalanceProof {
        uint64 index;
        bytes32 chunk;
        bytes32[] branch;
    }

    struct PendingConsolidationProof {
        uint64 queueIndex;
        uint64 sourceIndex;
        uint64 targetIndex;
        bytes32[] branch;
    }

    struct SlotProof {
        uint64 slot;
        bytes32[] branch;
    }

    error InvalidProof();
    error InvalidProofLength();
    error InvalidPubkeyLength();
    error IndexOutOfRange();

    // ---------------------------------------------------------------------------------------------
    // Verification
    // ---------------------------------------------------------------------------------------------

    function verifyStateRoot(bytes32 blockRoot, StateRootProof calldata p) internal pure {
        _verify(p.stateRoot, p.branch, STATE_ROOT_GINDEX, blockRoot);
    }

    function verifySlot(bytes32 stateRoot, SlotProof calldata p) internal pure {
        _verify(toLittleEndian(p.slot), p.branch, SLOT_GINDEX, stateRoot);
    }

    function verifyValidator(bytes32 stateRoot, ValidatorProof calldata p) internal pure {
        if (p.index >= VALIDATOR_REGISTRY_LIMIT) revert IndexOutOfRange();
        _verify(validatorRoot(p.validator), p.branch, VALIDATORS_BASE_GINDEX | p.index, stateRoot);
    }

    /// @return balance the proven balance in gwei
    function verifyBalance(bytes32 stateRoot, BalanceProof calldata p) internal pure returns (uint64 balance) {
        if (p.index >= VALIDATOR_REGISTRY_LIMIT) revert IndexOutOfRange();
        _verify(p.chunk, p.branch, BALANCES_BASE_GINDEX | (p.index >> 2), stateRoot);
        return fromLittleEndian(p.chunk, uint256(p.index & 3));
    }

    function verifyPendingConsolidation(bytes32 stateRoot, PendingConsolidationProof calldata p)
        internal
        pure
    {
        if (p.queueIndex >= PENDING_CONSOLIDATIONS_LIMIT) revert IndexOutOfRange();
        bytes32 leaf = sha256(abi.encodePacked(toLittleEndian(p.sourceIndex), toLittleEndian(p.targetIndex)));
        _verify(leaf, p.branch, PENDING_CONSOLIDATIONS_BASE_GINDEX | p.queueIndex, stateRoot);
    }

    // ---------------------------------------------------------------------------------------------
    // SSZ helpers
    // ---------------------------------------------------------------------------------------------

    function validatorRoot(Validator calldata v) internal pure returns (bytes32) {
        bytes32[8] memory leaves = [
            pubkeyRoot(v.pubkey),
            v.withdrawalCredentials,
            toLittleEndian(v.effectiveBalance),
            v.slashed ? bytes32(uint256(1) << 248) : bytes32(0),
            toLittleEndian(v.activationEligibilityEpoch),
            toLittleEndian(v.activationEpoch),
            toLittleEndian(v.exitEpoch),
            toLittleEndian(v.withdrawableEpoch)
        ];
        bytes32[4] memory l1;
        for (uint256 i; i < 4; ++i) {
            l1[i] = sha256(abi.encodePacked(leaves[2 * i], leaves[2 * i + 1]));
        }
        return sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(l1[0], l1[1])), sha256(abi.encodePacked(l1[2], l1[3]))
            )
        );
    }

    function pubkeyRoot(bytes calldata pubkey) internal pure returns (bytes32) {
        if (pubkey.length != 48) revert InvalidPubkeyLength();
        return sha256(abi.encodePacked(pubkey, bytes16(0)));
    }

    function toLittleEndian(uint64 v) internal pure returns (bytes32) {
        uint256 r;
        for (uint256 i; i < 8; ++i) {
            r |= uint256((v >> (8 * i)) & 0xff) << (8 * (31 - i));
        }
        return bytes32(r);
    }

    /// @notice Reads the `slot`-th little-endian uint64 (0..3) from a packed 32-byte chunk.
    function fromLittleEndian(bytes32 chunk, uint256 slot) internal pure returns (uint64 v) {
        uint256 c = uint256(chunk);
        for (uint256 i; i < 8; ++i) {
            v |= uint64((c >> (8 * (31 - (slot * 8 + i)))) & 0xff) << uint64(8 * i);
        }
    }

    function _verify(bytes32 leaf, bytes32[] calldata branch, uint256 gindex, bytes32 root)
        private
        pure
    {
        uint256 depth;
        for (uint256 g = gindex; g > 1; g >>= 1) ++depth;
        if (branch.length != depth) revert InvalidProofLength();
        bytes32 node = leaf;
        for (uint256 i; i < depth; ++i) {
            node = (gindex >> i) & 1 == 1
                ? sha256(abi.encodePacked(branch[i], node))
                : sha256(abi.encodePacked(node, branch[i]));
        }
        if (node != root) revert InvalidProof();
    }
}
