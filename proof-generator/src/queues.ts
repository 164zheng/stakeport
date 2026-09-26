// Consensus-layer queue lengths (Electra/Fulu churn rules) computed from a real BeaconState.
//
// They drive StakePort's pricing story:
//   - a BUYER's alternative is a fresh deposit, which waits in the entry (deposit) queue earning nothing;
//     buying already-active stake skips it, so the seller can ask a premium;
//   - a SELLER's alternative is exiting, which waits in the exit queue plus the withdrawability delay;
//   - a StakePort trade settles when the consolidation queue processes the source.

export const SECONDS_PER_EPOCH = 12 * 32;
const MIN_PER_EPOCH_CHURN_LIMIT_ELECTRA = 128e9;
const MAX_PER_EPOCH_ACTIVATION_EXIT_CHURN_LIMIT = 256e9;
const CHURN_LIMIT_QUOTIENT = 65536;
const EFFECTIVE_BALANCE_INCREMENT = 1e9;
const MAX_SEED_LOOKAHEAD = 4;
const MIN_VALIDATOR_WITHDRAWABILITY_DELAY = 256;
/** Deposit -> activation after processing: eligibility, finality and the seed lookahead (approximate). */
const ACTIVATION_DELAY_EPOCHS = 1 + 2 + 1 + MAX_SEED_LOOKAHEAD;

// Minimal structural view of the lodestar BeaconState view we read.
interface StateLike {
  slot: number;
  earliestExitEpoch: number;
  earliestConsolidationEpoch: number;
  validators: { getAllReadonlyValues(): { activationEpoch: number; exitEpoch: number; effectiveBalance: number }[] };
  pendingDeposits: { getAllReadonlyValues(): { amount: number }[] };
  pendingConsolidations: { length: number };
}

export interface QueueStats {
  epoch: number;
  totalActiveEth: number;
  churnEthPerEpoch: { activationExit: number; consolidation: number };
  entry: { pendingEth: number; pendingCount: number; waitEpochs: number; waitDays: number };
  exit: { waitEpochs: number; waitDays: number; withdrawableDays: number };
  consolidation: { pendingCount: number; waitEpochs: number; waitDays: number; deliveryDays: number };
}

const days = (epochs: number) => (epochs * SECONDS_PER_EPOCH) / 86400;

export function totalActiveBalance(state: StateLike) {
  const epoch = Math.floor(state.slot / 32);
  let total = 0;
  for (const v of state.validators.getAllReadonlyValues()) {
    if (v.activationEpoch <= epoch && epoch < v.exitEpoch) total += v.effectiveBalance;
  }
  return total;
}

export function queueStats(state: StateLike, totalActiveGwei: number): QueueStats {
  const epoch = Math.floor(state.slot / 32);
  const balanceChurn = Math.max(
    MIN_PER_EPOCH_CHURN_LIMIT_ELECTRA,
    Math.floor(totalActiveGwei / CHURN_LIMIT_QUOTIENT / EFFECTIVE_BALANCE_INCREMENT) * EFFECTIVE_BALANCE_INCREMENT,
  );
  const activationExitChurn = Math.min(MAX_PER_EPOCH_ACTIVATION_EXIT_CHURN_LIMIT, balanceChurn);
  const consolidationChurn = balanceChurn - activationExitChurn;
  const minEpoch = epoch + 1 + MAX_SEED_LOOKAHEAD;

  const deposits = state.pendingDeposits.getAllReadonlyValues();
  const pendingGwei = deposits.reduce((a, d) => a + d.amount, 0);
  const entryEpochs = Math.ceil(pendingGwei / activationExitChurn) + ACTIVATION_DELAY_EPOCHS;

  const exitEpochs = Math.max(state.earliestExitEpoch, minEpoch) - epoch;
  const consolidationEpochs = Math.max(state.earliestConsolidationEpoch, minEpoch) - epoch;

  return {
    epoch,
    totalActiveEth: totalActiveGwei / 1e9,
    churnEthPerEpoch: { activationExit: activationExitChurn / 1e9, consolidation: consolidationChurn / 1e9 },
    entry: {
      pendingEth: pendingGwei / 1e9,
      pendingCount: deposits.length,
      waitEpochs: entryEpochs,
      waitDays: days(entryEpochs),
    },
    exit: {
      waitEpochs: exitEpochs,
      waitDays: days(exitEpochs),
      withdrawableDays: days(exitEpochs + MIN_VALIDATOR_WITHDRAWABILITY_DELAY),
    },
    consolidation: {
      pendingCount: state.pendingConsolidations.length,
      waitEpochs: consolidationEpochs,
      waitDays: days(consolidationEpochs),
      // stake moves to the target when the source becomes withdrawable
      deliveryDays: days(consolidationEpochs + MIN_VALIDATOR_WITHDRAWABILITY_DELAY),
    },
  };
}
