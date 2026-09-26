"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { QueuePanel } from "@/components/QueuePanel";
import { Badge, Card, ErrorBox, Mono } from "@/components/ui";
import { api, type ValidatorInfo } from "@/lib/api";
import { eth, gweiToEth, pct, short } from "@/lib/format";
import { isVerifiedMarket, listings, quote, trades, type Listing } from "@/lib/market";

export default function MarketPage() {
  const [items, setItems] = useState<Listing[]>();
  const [validators, setValidators] = useState<Record<number, ValidatorInfo>>({});
  const [quotes, setQuotes] = useState<Record<string, bigint>>({});
  /** stake fixed at fill time, per source validator (its live balance is 0 once delivered) */
  const [traded, setTraded] = useState<Record<number, bigint>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    listings()
      .then(async (ls) => {
        setItems(ls);
        const idx = [...new Set(ls.map((l) => Number(l.order.sourceIndex)))];
        if (idx.length) {
          const vs = await api.validators({ indices: idx });
          const byIndex = Object.fromEntries(vs.map((v) => [v.index, v]));
          setValidators(byIndex);
          // LST-relative listings are priced live from the Uniswap TWAP
          const q: Record<string, bigint> = {};
          for (const l of ls.filter((x) => x.order.priceMode === 1 && x.state === "open")) {
            const v = byIndex[Number(l.order.sourceIndex)];
            if (v) q[l.hash] = await quote(l.order, BigInt(v.effectiveBalanceGwei)).catch(() => 0n);
          }
          setQuotes(q);
          const ts = await trades().catch(() => []);
          setTraded(Object.fromEntries(ts.reverse().map((t) => [Number(t.sourceIndex), t.amountGwei])));
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight">
          Buy and sell <span className="text-accent">native</span> Ethereum stake.
          <br />
          Skip the entry queue. No LST. No custodian.
        </h1>
        <p className="max-w-2xl text-muted">
          A validator&apos;s active stake moves straight into the buyer&apos;s validator with an EIP-7251 consolidation. Payment
          sits in escrow and is released only when EIP-4788 beacon state proofs show the stake was delivered.
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          {[
            ["EIP-7251", "native stake transfer"],
            ["EIP-7702", "programmable withdrawal account"],
            ["EIP-4788", "trustless verification"],
          ].map(([k, v]) => (
            <span key={k} className="rounded-full border border-line px-3 py-1">
              <span className="font-semibold text-accent">{k}</span> <span className="text-muted">{v}</span>
            </span>
          ))}
        </div>
      </section>

      <QueuePanel />

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="text-lg font-semibold">Listings</h2>
          <Link href="/sell" className="text-sm text-accent hover:underline">
            List your validator →
          </Link>
        </div>
        <ErrorBox error={error} />
        {!items && !error && <p className="text-sm text-muted">Loading…</p>}
        {items?.length === 0 && (
          <Card>
            <p className="text-sm text-muted">No listings yet. Switch to the seller role and list a validator.</p>
          </Card>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((l) => {
            const v = validators[Number(l.order.sourceIndex)];
            const tradedGwei = l.state !== "open" ? traded[Number(l.order.sourceIndex)] : undefined;
            const stakeGwei = tradedGwei ?? (v ? BigInt(v.effectiveBalanceGwei) : undefined);
            const amount = stakeGwei !== undefined ? stakeGwei * 10n ** 9n : 0n;
            const fixed = l.order.priceMode === 0;
            const livePrice = fixed ? l.order.price : quotes[l.hash];
            const discount = livePrice && amount > 0n ? 1 - Number(livePrice) / Number(amount) : undefined;
            return (
              <Card key={l.hash} className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted">Validator</div>
                    <div className="font-semibold">#{l.order.sourceIndex.toString()}</div>
                  </div>
                  <div className="flex gap-1.5">
                    {isVerifiedMarket(l) && (
                      <span className="rounded-full bg-warn/15 px-2.5 py-0.5 text-xs font-medium text-warn">World ID</span>
                    )}
                    <Badge value={l.state} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-muted">Stake</div>
                    <div className="text-xl font-semibold">{stakeGwei !== undefined ? gweiToEth(stakeGwei) : "…"} ETH</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted">Price</div>
                    <div className="text-xl font-semibold">
                      {livePrice ? `${eth(livePrice)} WETH` : `LST −${Number(l.order.price) / 100}%`}
                    </div>
                            {discount !== undefined && (
                      <div className={`text-xs ${discount >= 0 ? "text-good" : "text-warn"}`}>
                        {discount >= 0 ? `${pct(discount)} discount` : `${pct(-discount)} premium`}
                      </div>
                    )}
                    {!fixed && (
                      <div className="text-xs text-muted">LST market −{Number(l.order.price) / 100}% · Uniswap TWAP</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Mono>seller {short(l.order.seller, 4)}</Mono>
                  {l.state === "open" ? (
                    <Link
                      href={`/buy/${l.hash}`}
                      className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-ink hover:brightness-110"
                    >
                      Buy stake
                    </Link>
                  ) : (
                    <span className="text-xs text-muted">{l.state}</span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
