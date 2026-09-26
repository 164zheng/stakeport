import { PROOF_SERVICE_URL } from "./config";

export interface QueueStats {
  epoch: number;
  baseSlot: number;
  totalActiveEth: number;
  churnEthPerEpoch: { activationExit: number; consolidation: number };
  entry: { pendingEth: number; pendingCount: number; waitDays: number };
  exit: { waitDays: number; withdrawableDays: number };
  consolidation: { pendingCount: number; waitDays: number; deliveryDays: number };
}

export interface StakingApr {
  apr: number;
  source: string;
}

export const queues = (): Promise<QueueStats> =>
  fetch(`${PROOF_SERVICE_URL}/api/queues`, { cache: "no-store" }).then((r) => r.json());

export const stakingApr = (): Promise<StakingApr> => fetch("/api/apr").then((r) => r.json());

/**
 * Fair value of `amountEth` of active stake = the buyer's break-even price.
 *
 * The buyer's alternative is depositing fresh ETH, which waits `entry` days in the entry queue earning
 * nothing. Bought stake arrives after `delivery` days (consolidation queue) and earns from then, so the
 * buyer gains (entry - delivery) days of rewards:
 *
 *   fair = amount × (1 + APR × max(0, entry − delivery) / 365)
 */
export function fairValue(q: QueueStats, amountEth: number, apr: number) {
  const gainDays = Math.max(0, q.entry.waitDays - q.consolidation.deliveryDays);
  const fair = amountEth * (1 + (apr * gainDays) / 365);
  return { gainDays, fair, premiumPct: fair / amountEth - 1, apr };
}
