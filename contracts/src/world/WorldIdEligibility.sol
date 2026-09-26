// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IEligibilityPolicy} from "../interfaces/IEligibilityPolicy.sol";

/// @title WorldIdEligibility
/// @notice Eligibility policy for the Verified Market: the buyer holds a World ID Passport (NFC)
/// credential, verified server-side with the World Developer Portal (`/api/v4/verify`).
///
/// Trust moment: Verified Market listings are meant for sellers who only want counterparties
/// outside sanctioned jurisdictions. The ideal credential is World ID Identity Check with a
/// `nationality` attribute, which is in preview. Until it is available, the policy requires the
/// closest available assurance: a real government-issued passport, one account per document.
/// This is NOT a KYC or sanctions check; `credential` records which check was performed so a
/// stricter policy can be deployed without changing the market.
///
/// The backend (attester) verifies the IDKit proof, checks that its signal is the buyer's address
/// and signs an attestation. Anyone can submit it. The World ID nullifier (scoped to our action)
/// can be bound to only one account.
contract WorldIdEligibility is IEligibilityPolicy, EIP712 {
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address account,bytes32 nullifier,bytes32 credential,uint64 expiresAt)");

    struct Attestation {
        address account;
        /// @dev World ID nullifier for the StakePort action (one per passport)
        bytes32 nullifier;
        /// @dev e.g. keccak256("world-id:nfc-document") (passport or My Number Card)
        bytes32 credential;
        uint64 expiresAt;
    }

    address public immutable attester;
    bytes32 public immutable requiredCredential;

    mapping(address => uint64) public eligibleUntil;
    mapping(bytes32 => address) public accountOfNullifier;

    event Attested(address indexed account, bytes32 indexed nullifier, bytes32 credential, uint64 expiresAt);

    error InvalidAttester();
    error WrongCredential(bytes32 credential);
    error AttestationExpired();
    error NullifierBoundToOtherAccount(address account);

    constructor(address attester_, bytes32 requiredCredential_) EIP712("StakePort WorldIdEligibility", "1") {
        attester = attester_;
        requiredCredential = requiredCredential_;
    }

    function attest(Attestation calldata a, bytes calldata signature) external {
        if (ECDSA.recover(hashAttestation(a), signature) != attester) revert InvalidAttester();
        if (a.credential != requiredCredential) revert WrongCredential(a.credential);
        if (a.expiresAt <= block.timestamp) revert AttestationExpired();
        address bound = accountOfNullifier[a.nullifier];
        if (bound != address(0) && bound != a.account) revert NullifierBoundToOtherAccount(bound);

        accountOfNullifier[a.nullifier] = a.account;
        eligibleUntil[a.account] = a.expiresAt;
        emit Attested(a.account, a.nullifier, a.credential, a.expiresAt);
    }

    function isEligible(address buyer) external view returns (bool) {
        return eligibleUntil[buyer] > block.timestamp;
    }

    function hashAttestation(Attestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, a.account, a.nullifier, a.credential, a.expiresAt))
        );
    }
}
