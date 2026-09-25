"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { Badge, Card, ErrorBox, Mono, Stat } from "@/components/ui";
import { api, type ValidatorInfo } from "@/lib/api";
import { publicClient } from "@/lib/chain";
import { MAINNET_GENESIS, SECONDS_PER_EPOCH } from "@/lib/config";
import { duration, eth, gweiToEth, pct, short, usd } from "@/lib/format";
import { listings, trades, wethBalance, type Listing, type Trade } from "@/lib/market";
import { usePersona } from "@/lib/persona";
import { EST_STAKING_APR, ethUsd } from "@/lib/prices";

const MAX_EB = 2048e9;
const ACCEPT_WINDOW = 86400;

interface Action {
  level: "now" | "soon" | "info";
  text: string;
  href?: string;
}

export default function PortfolioPage() {
  const { role, info } = usePersona();
  const address = info?.personas[role].address;
  const [validators, setValidators] = useState<ValidatorInfo[]>();
  const [myTrades, setMyTrades] = useState<Trade[]>([]);
  const [myListings, setMyListings] = useState<Listing[]>([]);
  const [price, setPrice] = useState<number>();
  const [weth, setWeth] = useState<bigint>(0n);
  const [now, setNow] = useState<number>(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!address) return;
    const lower = address.toLowerCase();
    Promise.all([api.validators({ address }), trades(), listings(), ethUsd(), wethBalance(address as Address), publicClient.getBlock()])
      .then(([vs, ts, ls, p, w, b]) => {
        setValidators(vs);
        setMyTrades(ts.filter((t) => t.buyer.toLowerCase() === lower || t.seller.toLowerCase() === lower));
        setMyListings(ls.filter((l) => l.order.seller.toLowerCase() === lower));
        setPrice(p);
        setWeth(w);
        setNow(Number(b.timestamp));
      })
      .catch((e) => setError(e.message));
  }, [address]);

  const m = useMemo(() => {
    const vs = validators ?? [];
    const live = vs.filter((v) => v.status === "active" || v.status === "exiting");
    const stakeGwei = live.reduce((a, v) => a + v.balanceGwei, 0);
    const effGwei = live.reduce((a, v) => a + v.effectiveBalanceGwei, 0);
    const compounding = vs.filter((v) => v.credentials === "0x02" && v.status === "active");
    const capacityGwei = compounding.reduce((a, v) => a + Math.max(0, MAX_EB - v.effectiveBalanceGwei), 0);
    const lower = address?.toLowerCase();
    const bought = myTrades.filter((t) => t.buyer.toLowerCase() === lower && t.status !== "Failed");
    const sold = myTrades.filter((t) => t.seller.toLowerCase() === lower && t.status !== "Failed");
    const faceBought = bought.reduce((a, t) => a + Number(t.amountGwei) / 1e9, 0);
    const paidBought = bought.reduce((a, t) => a + Number(t.payment) / 1e18, 0);
    const pendingIn = bought.filter((t) => t.status !== "Delivered").reduce((a, t) => a + Number(t.amountGwei) / 1e9, 0);
    const escrowedOut = sold.filter((t) => t.status !== "Delivered").reduce((a, t) => a + Number(t.payment) / 1e18, 0);
    return { live, stakeGwei, effGwei, compounding, capacityGwei, bought, sold, faceBought, paidBought, pendingIn, escrowedOut };
  }, [validators, myTrades, address]);

  const actions = useMemo<Action[]>(() => {
    const out: Action[] = [];
    for (const t of myTrades) {
      const link = `/trades/${t.id}`;
      if (t.status === "RequestSubmitted") {
        if (now - Number(t.filledAt) > ACCEPT_WINDOW) out.push({ level: "now", text: `Trade #${t.id}: accept window passed, refund can be claimed`, href: link });
        else out.push({ level: "now", text: `Trade #${t.id}: relay the checkpoint 1 proof (consolidation accepted)`, href: link });
      }
      if (t.status === "Accepted") {
        const at = MAINNET_GENESIS + Number(t.withdrawableEpoch) * SECONDS_PER_EPOCH;
        if (at <= now) out.push({ level: "now", text: `Trade #${t.id}: stake is withdrawable, relay the delivery proof to settle`, href: link });
        else out.push({ level: "soon", text: `Trade #${t.id}: delivery expected in ${duration(at - now)} (epoch ${t.withdrawableEpoch})`, href: link });
      }
    }
    for (const v of m.compounding) {
      if (v.effectiveBalanceGwei > MAX_EB - 64e9) out.push({ level: "soon", text: `Validator #${v.index} is within 64 ETH of the 2048 ETH cap: buy into another 0x02 validator` });
    }
    if (role === "seller") {
      const listed = new Set(myListings.filter((l) => l.state === "open" || l.state === "trading").map((l) => Number(l.order.sourceIndex)));
      const idle = (validators ?? []).filter((v) => v.status === "active" && !listed.has(v.index));
      if (idle.length) out.push({ level: "info", text: `${idle.length} active validator(s) could be listed without exiting`, href: "/sell" });
      for (const l of myListings) {
        if (l.state === "open" && Number(l.order.expiry) - now < 3 * 86400) out.push({ level: "soon", text: `Listing for #${l.order.sourceIndex} expires in ${duration(Number(l.order.expiry) - now)}` });
      }
    }
    if (role === "buyer" && m.compounding.length === 0) out.push({ level: "info", text: "No 0x02 validator: convert one to compounding credentials to receive stake" });
    if (weth > 10n ** 18n) out.push({ level: "info", text: `${eth(weth)} WETH idle: browse listings to put it to work`, href: "/" });
    return out;
  }, [myTrades, m, myListings, validators, role, weth, now]);

  const usdOf = (ethAmount: number) => (price ? usd(ethAmount * price) : "…");
  const statusCounts = (validators ?? []).reduce<Record<string, number>>((a, v) => ((a[v.status] = (a[v.status] ?? 0) + 1), a), {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Native stake portfolio</h1>
          <p className="mt-1 text-sm text-muted">
            {role === "buyer" ? "Buyer" : "Seller"} <Mono>{address ?? "…"}</Mono> · validator data from a real mainnet beacon state
          </p>
        </div>
        <span className="text-xs text-muted">ETH {price ? usd(price) : "…"} (Chainlink)</span>
      </div>
      <ErrorBox error={error} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat label="Native stake" value={`${gweiToEth(m.stakeGwei, 2)} ETH`} sub={usdOf(m.stakeGwei / 1e9)} />
        </Card>
        <Card>
          <Stat
            label="Est. yearly rewards"
            value={`${(m.effGwei / 1e9 * EST_STAKING_APR).toFixed(2)} ETH`}
            sub={`at ~${pct(EST_STAKING_APR, 1)} APR (estimate)`}
          />
        </Card>
        <Card>
          <Stat
            label={role === "buyer" ? "Receiving capacity" : "Pending sales"}
            value={role === "buyer" ? `${gweiToEth(m.capacityGwei, 0)} ETH` : `${m.escrowedOut.toFixed(2)} WETH`}
            sub={role === "buyer" ? `across ${m.compounding.length} 0x02 validator(s)` : "escrowed, released on delivery"}
          />
        </Card>
        <Card>
          <Stat
            label={role === "buyer" ? "Bought below face" : "Sold"}
            value={
              role === "buyer"
                ? `${(m.faceBought - m.paidBought).toFixed(3)} ETH`
                : `${m.sold.reduce((a, t) => a + Number(t.amountGwei) / 1e9, 0)} ETH`
            }
            sub={
              role === "buyer"
                ? m.faceBought > 0
                  ? `${pct(1 - m.paidBought / m.faceBought)} avg discount · ${m.pendingIn} ETH in settlement`
                  : "no purchases yet"
                : `${m.sold.length} trade(s) without exiting`
            }
          />
        </Card>
      </div>

      <Card>
        <h2 className="font-semibold">Action items</h2>
        {actions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing needs your attention.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {actions.map((a, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${a.level === "now" ? "bg-warn" : a.level === "soon" ? "bg-info" : "bg-muted"}`}
                />
                {a.href ? (
                  <Link href={a.href} className="hover:underline">
                    {a.text}
                  </Link>
                ) : (
                  <span>{a.text}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card className="overflow-x-auto">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Validators</h2>
            <div className="flex gap-2 text-xs text-muted">
              {Object.entries(statusCounts).map(([k, n]) => (
                <span key={k}>
                  {n} {k}
                </span>
              ))}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-2">Index</th>
                <th>Type</th>
                <th>Balance</th>
                <th>Fill</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {validators?.map((v) => {
                const cap = v.credentials === "0x02" ? MAX_EB : 32e9;
                const fill = Math.min(1, v.effectiveBalanceGwei / cap);
                return (
                  <tr key={v.index} className="border-t border-line">
                    <td className="py-2">#{v.index}</td>
                    <td>
                      <Mono>{v.credentials === "0x02" ? "0x02 compounding" : v.credentials}</Mono>
                    </td>
                    <td className="tabular-nums">{gweiToEth(v.balanceGwei, 3)} ETH</td>
                    <td className="w-28">
                      <div className="h-1.5 rounded-full bg-line">
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${fill * 100}%` }} />
                      </div>
                    </td>
                    <td>
                      <Badge value={v.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!validators && <p className="py-3 text-sm text-muted">Loading…</p>}
        </Card>

        <Card className="overflow-x-auto">
          <h2 className="mb-3 font-semibold">Trades</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-2">Trade</th>
                <th>Side</th>
                <th>Stake</th>
                <th>Price</th>
                <th>Settles</th>
              </tr>
            </thead>
            <tbody>
              {myTrades.map((t) => {
                const side = t.buyer.toLowerCase() === address?.toLowerCase() ? "buy" : "sell";
                const at = t.withdrawableEpoch > 0n ? MAINNET_GENESIS + Number(t.withdrawableEpoch) * SECONDS_PER_EPOCH : undefined;
                return (
                  <tr key={t.id.toString()} className="border-t border-line">
                    <td className="py-2">
                      <Link href={`/trades/${t.id}`} className="text-accent hover:underline">
                        #{t.id.toString()}
                      </Link>
                    </td>
                    <td className={side === "buy" ? "text-good" : "text-warn"}>{side}</td>
                    <td>{gweiToEth(t.amountGwei)} ETH</td>
                    <td>
                      {eth(t.payment, 2)} <span className="text-xs text-muted">({pct(1 - Number(t.payment) / (Number(t.amountGwei) * 1e9), 1)} off)</span>
                    </td>
                    <td>
                      {t.status === "Accepted" && at ? (
                        <span className="text-xs">{at > now ? `in ${duration(at - now)}` : "ready"}</span>
                      ) : (
                        <Badge value={t.status} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {myTrades.length === 0 && <p className="py-3 text-sm text-muted">No trades yet.</p>}
          <p className="mt-4 text-xs text-muted">
            Idle WETH: {eth(weth)} · {short(address ?? "", 4)}
          </p>
        </Card>
      </div>
    </div>
  );
}
