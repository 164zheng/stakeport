"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { fairValue, queues, stakingApr, type QueueStats, type StakingApr } from "@/lib/queues";

const d = (x: number) => (x < 1 ? `${(x * 24).toFixed(1)} h` : `${x.toFixed(1)} days`);
const eth = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Real queue lengths (proof service) and the staking APR (Lido API, server-side). */
export function useQueues() {
  const [q, setQ] = useState<QueueStats>();
  const [apr, setApr] = useState<StakingApr>();
  useEffect(() => {
    queues().then(setQ).catch(() => {});
    stakingApr().then(setApr).catch(() => {});
  }, []);
  return q && apr ? { q, apr } : undefined;
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
  const m = useQueues();
  if (!m) return null;
  const { q, apr } = m;
  const f = fairValue(q, amountEth, apr.apr);
  const max = Math.max(q.entry.waitDays, q.consolidation.deliveryDays);
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
      </div>
      <div className="flex flex-col justify-center gap-3 rounded-xl bg-bg p-4">
        <div className="text-xs uppercase tracking-wider text-muted">Fair value of {amountEth} ETH active stake</div>
        <div className="text-3xl font-semibold tabular-nums">{f.fair.toFixed(4)} ETH</div>
        <div className="text-sm text-good">+{(f.premiumPct * 100).toFixed(3)}% premium</div>
        <p className="text-xs text-muted">
          The buyer&apos;s break-even: bought stake earns {f.gainDays.toFixed(1)} days sooner than a new deposit.
        </p>
        <p className="font-mono text-xs text-muted">
          {amountEth} × (1 + {(f.apr * 100).toFixed(2)}% × {f.gainDays.toFixed(1)} / 365)
        </p>
        <p className="text-xs text-muted">APR: {apr.source}</p>
      </div>
    </Card>
  );
}
