// Prints the generalized indices used by the Solidity verifier.
import { ssz } from "@lodestar/types";

const S = ssz.fulu.BeaconState;
const H = ssz.phase0.BeaconBlockHeader;
const fieldNames = Object.keys(S.fields);
const idx = (f: string) => fieldNames.indexOf(f);

console.log("BeaconState fields:", fieldNames.length);
for (const f of ["slot", "validators", "balances", "pendingConsolidations"]) {
  console.log(`  ${f}: field index ${idx(f)}, gindex ${S.getPathInfo([f]).gindex}`);
}
console.log("validators[0]:", S.getPathInfo(["validators", 0]).gindex.toString());
console.log("balances[0]:", S.getPathInfo(["balances", 0]).gindex.toString());
console.log("pendingConsolidations[0]:", S.getPathInfo(["pendingConsolidations", 0]).gindex.toString());
console.log("header.stateRoot:", H.getPathInfo(["stateRoot"]).gindex.toString());
console.log("Validator fields:", Object.keys(ssz.phase0.Validator.fields));
console.log("PendingConsolidation fields:", Object.keys(ssz.electra.PendingConsolidation.fields));
