# World IDKit integration debrief

## Time to first success

- IDKit backend (RP signature, `/api/v4/verify` forwarding, attestation) and the onchain policy: about 2 hours,
  including tests.
- First real verification with World App (production): about 3 more hours, almost all spent on the issues below.
  The final successful flow: World App NFC document credential (My Number Card) → Developer Portal
  verification (200) → onchain attestation → purchase in the Verified Market.

## Friction encountered

1. **`passport()` preset + `allow_legacy_proofs: false` still produced a World ID 3.0 `orb` proof.** For a user
   without a 4.0 document credential, World App showed a "Human" request and returned
   `protocol_version: "3.0"`, `identifier: "orb"`, although the request was 4.0-only. Our backend rejected it,
   but users see a confusing "Human" prompt. Requesting the same credential with explicit constraints
   (`any(CredentialRequest("passport"), CredentialRequest("mnc"))`) returned the expected `credential_unavailable`.
2. **My Number Card is a separate identifier (`mnc`, issuer schema 9310)**, even though the docs say it "issues
   the same credential" as a passport. A `passport()` request cannot be satisfied by a Japanese user who enrolled
   with My Number Card; we only found this by reading the SDK types.
3. **Action environment is not configurable in the Portal UI.** The docs say staging actions are needed for the
   simulator, but the UI created production-only actions; the simulator answered "App not found". We switched to
   production and a real device.
4. The credential we actually need (nationality via Identity Check) is in preview behind a contact form, so the
   product had to fall back to the NFC document credential and explain the gap.
5. World ID 4.0 proofs can only be verified onchain on World Chain; our market is on Ethereum, so a backend
   attester carries the result onchain.

## What helped

- `setDebug(true)` and the `onError` debug report (`request_payload`, `response_payload`, `request_id`) made the
  root cause visible in minutes once we logged them server-side.
- Probing `POST /api/v4/verify/{rp_id}` with a well-formed dummy 4.0 proof confirmed the RP was registered (the
  error came from the onchain verifier, not the RP lookup).

## Missing capability or documentation

- A table of `identifier` / `issuer_schema_id` per preset and per country (passport vs. `mnc` vs. eID), and a
  recommended "any government NFC document" constraint.
- A documented way to create staging actions in the Portal UI, or a clearer simulator error.
- Onchain verification of World ID 4.0 proofs on Ethereum mainnet.

## The one improvement with the greatest impact

Make the `passport()` preset honour `allow_legacy_proofs: false` (return `credential_unavailable` instead of a
legacy Human/orb proof) and cover every NFC document type (passport, My Number Card, eID) by default.
