"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { fairValue, queues, type QueueStats } from "@/lib/queues";

const d = (x: number) => (x < 1 ? `${(x * 24).toFixed(1)} h` : `${x.toFixed(1)} days`);
const eth = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function useQueues() {
  const [q, setQ] = useState<QueueStats>();
  useEffect(() => {
    queues().then(setQ).catch(() => {});
  }, []);
  return q;
}

function Bar({ label, days, max, sub, tone }: { label: string; days: number; max: number; sub: string; tone: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="font-semibold tabular-nums">{d(days)}</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-line">
        <div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.max(1.5, (days / max) * 100)}%` }} />
      </div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </div>
  );
}

/** Real mainnet queue lengths and the fair premium they imply for already-active stake. */
export function QueuePanel({ amountEth = 32 }: { amountEth?: number }) {
  const q = useQueues();
  if (!q) return null;
  const f = fairValue(q, amountEth);
  const max = Math.max(q.entry.waitDays, q.exit.withdrawableDays, q.consolidation.deliveryDays);
  return (
    <Card className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Why native stake trades at a premium right now</h2>
          <span className="text-xs text-muted">mainnet beacon state · slot {q.baseSlot}</span>
        </div>
        <Bar
          label="New deposit → active (entry queue)"
          days={q.entry.waitDays}
          max={max}
          tone="bg-warn"
          sub={`${eth(q.entry.pendingEth)} ETH in ${q.entry.pendingCount.toLocaleString()} pending deposits · ${q.churnEthPerEpoch.activationExit} ETH/epoch churn · earns nothing while waiting`}
        />
        <Bar
          label="StakePort purchase → delivered (consolidation queue)"
          days={q.consolidation.deliveryDays}
          max={max}
          tone="bg-accent"
          sub={`${q.consolidation.pendingCount.toLocaleString()} pending consolidations · ${q.churnEthPerEpoch.consolidation} ETH/epoch churn · + 256-epoch withdrawability delay`}
        />
        <Bar
          label="Exit → withdrawable (seller's alternative)"
          days={q.exit.withdrawableDays}
          max={max}
          tone="bg-info"
          sub="exit queue + 256-epoch withdrawability delay (withdrawal sweep not included)"
        />
      </div>
      <div className="flex flex-col justify-center gap-3 rounded-xl bg-bg p-4">
        <div className="text-xs uppercase tracking-wider text-muted">Fair value of {amountEth} ETH active stake</div>
        <div className="text-3xl font-semibold tabular-nums">{f.fair.toFixed(4)} ETH</div>
        <div className="text-sm text-good">+{(f.premiumPct * 100).toFixed(3)}% premium</div>
        <p className="text-xs text-muted">
          A buyer skips {f.buyerGainDays.toFixed(1)} days of the entry queue and would pay up to{" "}
          <b className="text-fg">{f.buyerMax.toFixed(4)}</b>. A seller exiting instead would be paid{" "}
          {f.sellerDelayDays.toFixed(1)} days sooner, so accepts from <b className="text-fg">{f.sellerMin.toFixed(4)}</b>.
          At ~{(f.apr * 100).toFixed(1)}% staking APR (estimate).
        </p>
      </div>
    </Card>
  );
}
