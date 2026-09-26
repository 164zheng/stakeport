import { test } from "node:test";
import assert from "node:assert/strict";
import { queueStats, totalActiveBalance } from "../src/queues.ts";

const state = (o: { slot: number; exit: number; cons: number; deposits: number[]; validators: number }) => ({
  slot: o.slot,
  earliestExitEpoch: o.exit,
  earliestConsolidationEpoch: o.cons,
  validators: {
    getAllReadonlyValues: () =>
      Array.from({ length: o.validators }, () => ({ activationEpoch: 0, exitEpoch: Infinity, effectiveBalance: 32e9 })),
  },
  pendingDeposits: { getAllReadonlyValues: () => o.deposits.map((amount) => ({ amount })) },
  pendingConsolidations: { length: 3 },
});

test("churn follows Electra limits", () => {
  // 1.36M validators * 32 ETH = 43.52M ETH -> balance churn 664 ETH, activation/exit capped at 256
  const s = state({ slot: 32 * 1000, exit: 0, cons: 0, deposits: [], validators: 1_360_000 });
  const q = queueStats(s, totalActiveBalance(s));
  assert.equal(q.churnEthPerEpoch.activationExit, 256);
  assert.equal(q.churnEthPerEpoch.consolidation, 664 - 256);
});

test("small network uses the minimum churn and no consolidation churn", () => {
  const s = state({ slot: 32 * 10, exit: 0, cons: 0, deposits: [], validators: 1000 });
  const q = queueStats(s, totalActiveBalance(s));
  assert.equal(q.churnEthPerEpoch.activationExit, 128);
  assert.equal(q.churnEthPerEpoch.consolidation, 0);
});

test("entry wait = pending deposits / activation churn + activation delay", () => {
  const s = state({ slot: 32 * 1000, exit: 0, cons: 0, deposits: Array(256).fill(32e9), validators: 1_360_000 });
  const q = queueStats(s, totalActiveBalance(s));
  assert.equal(q.entry.pendingEth, 8192);
  assert.equal(q.entry.waitEpochs, 32 + 8);
});

test("exit and consolidation waits start no earlier than the seed lookahead", () => {
  const s = state({ slot: 32 * 1000, exit: 900, cons: 1390, deposits: [], validators: 1_360_000 });
  const q = queueStats(s, totalActiveBalance(s));
  assert.equal(q.exit.waitEpochs, 5);
  assert.equal(q.consolidation.waitEpochs, 390);
  assert.ok(Math.abs(q.consolidation.deliveryDays - ((390 + 256) * 384) / 86400) < 1e-9);
});
