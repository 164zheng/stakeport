# World IDKit integration debrief

## Time to first success

- IDKit backend (RP signature + `/api/v4/verify` forwarding + attestation) and the onchain policy: about
  2 hours, including tests.
- End-to-end verification with a real World ID App / simulator: _TODO (team): fill in once the Developer Portal
  app is configured and the first Passport proof is verified._

## Friction encountered

- The credential we actually need (nationality via Identity Check) is in preview behind a contact form, so the
  product had to fall back to the Passport credential and explain the gap.
- World ID 4.0 proofs can only be verified onchain on World Chain (WorldIDVerifier / satellites). Our market lives
  on Ethereum mainnet, so we needed a backend attester to carry the result onchain.
- Response identifiers differ between World ID 4.0 (`passport`) and the legacy fallback (`document`,
  `secure_document`); we had to read the SDK types to know which values to accept.
- It is not obvious from the docs whether the simulator can issue a Passport credential for `staging` testing.

## Missing capability or documentation

- A way to verify World ID 4.0 proofs on Ethereum mainnet (or a state bridge) for non-World-Chain apps.
- A table of `identifier` / `issuer_schema_id` values per preset, including legacy fallbacks.

## The one improvement with the greatest impact

General availability of Identity Check with `nationality`, so eligibility rules like "not in a sanctioned
jurisdiction" can be expressed directly instead of approximated with a document-possession credential.
