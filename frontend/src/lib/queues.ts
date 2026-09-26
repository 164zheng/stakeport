import { PROOF_SERVICE_URL } from "./config";
import { EST_STAKING_APR } from "./prices";

export interface QueueStats {
  epoch: number;
  baseSlot: number;
  totalActiveEth: number;
  churnEthPerEpoch: { activationExit: number; consolidation: number };
  entry: { pendingEth: number; pendingCount: number; waitDays: number };
  exit: { waitDays: number; withdrawableDays: number };
  consolidation: { pendingCount: number; waitDays: number; deliveryDays: number };
}

export const queues = (): Promise<QueueStats> =>
  fetch(`${PROOF_SERVICE_URL}/api/queues`, { cache: "no-store" }).then((r) => r.json());

/**
 * Fair value band for `amountEth` of active stake bought through StakePort.
 *
 * Buyer's alternative: deposit fresh ETH and wait in the entry queue, earning nothing. Bought stake
 * starts earning once delivered, so the buyer gains (entry wait - delivery) days of rewards and can
 * pay up to that premium.
 * Seller's alternative: exit and wait until withdrawable (the withdrawal sweep is ignored, which makes this
 * conservative). Selling pays out at delivery; if delivery is slower, the seller wants that delay's yield.
 */
export function fairValue(q: QueueStats, amountEth: number, apr = EST_STAKING_APR) {
  const buyerGainDays = Math.max(0, q.entry.waitDays - q.consolidation.deliveryDays);
  const sellerDelayDays = Math.max(0, q.consolidation.deliveryDays - q.exit.withdrawableDays);
  const buyerMax = amountEth * (1 + (apr * buyerGainDays) / 365);
  const sellerMin = amountEth * (1 + (apr * sellerDelayDays) / 365);
  const fair = (buyerMax + sellerMin) / 2;
  return { buyerGainDays, sellerDelayDays, buyerMax, sellerMin, fair, premiumPct: fair / amountEth - 1, apr };
}
