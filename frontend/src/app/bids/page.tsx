"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { parseEther } from "viem";
import { Badge, Button, Card, ErrorBox, Mono } from "@/components/ui";
import { api, type ValidatorInfo } from "@/lib/api";
import { bidLimit, createBid, dockBid, listBids, matchBid, matchQuote, type BidInfo } from "@/lib/aqua";
import { errorMessage } from "@/lib/chain";
import { getDeployment, type Deployment } from "@/lib/config";
import { eth, gweiToEth, pct, short } from "@/lib/format";
import { listings, type Listing } from "@/lib/market";
import { usePersona } from "@/lib/persona";

interface Match {
  bid: BidInfo;
  listing: Listing;
  payment: bigint;
  limit: bigint;
  amountGwei: number;
}

export default function BidsPage() {
  const router = useRouter();
  const { role, info } = usePersona();
  const buyer = info?.personas.buyer.address;
  const actor = info?.personas[role].address;

  const [deployment, setDeployment] = useState<Deployment>();
  const [bids, setBids] = useState<BidInfo[]>();
  const [matches, setMatches] = useState<Match[]>([]);
  const [targets, setTargets] = useState<ValidatorInfo[]>([]);
  const [target, setTarget] = useState<number>();
  const [pricePct, setPricePct] = useState("100.2");
  const [budget, setBudget] = useState("64");
  const [busy, setBusy] = useState<string>();
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const [d, bs, ls] = await Promise.all([getDeployment(), listBids(), listings()]);
    setDeployment(d);
    setBids(bs);
    const open = ls.filter((l) => l.state === "open");
    const vs = open.length ? await api.validators({ indices: open.map((l) => Number(l.order.sourceIndex)) }) : [];
    const found: Match[] = [];
    for (const b of bs.filter((x) => x.available > 0n)) {
      for (const l of open) {
        const v = vs.find((x) => x.index === Number(l.order.sourceIndex));
        if (!v) continue;
        const q = await matchQuote(b, l, BigInt(v.effectiveBalanceGwei)).catch(() => undefined);
        if (q?.ok) found.push({ bid: b, listing: l, payment: q.payment, limit: q.limit, amountGwei: v.effectiveBalanceGwei });
      }
    }
    setMatches(found);
  }, []);

  useEffect(() => {
    // fetch-on-mount: state is set after the async reads resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((e) => setError(errorMessage(e)));
  }, [refresh]);

  useEffect(() => {
    if (!buyer) return;
    api.validators({ address: buyer }).then((vs) => {
      const eligible = vs.filter((v) => v.credentials === "0x02" && v.status === "active");
      setTargets(eligible);
      setTarget(eligible[0]?.index);
    });
  }, [buyer]);

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    setError(undefined);
    setSteps([]);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const onCreate = () =>
    run("create", async () => {
      const t = targets.find((x) => x.index === target);
      if (!buyer || !t) throw new Error("choose a target validator");
      await createBid(
        { maker: buyer, targetPubkey: t.pubkey, priceWad: parseEther((Number(pricePct) / 100).toString()), budget: parseEther(budget) },
        (s) => setSteps((x) => [...x, s]),
      );
    });

  const onMatch = (m: Match) =>
    run(`match-${m.bid.hash}-${m.listing.hash}`, async () => {
      const id = await matchBid(m.bid, m.listing, actor ?? m.bid.bid.maker);
      router.push(`/trades/${id}`);
    });

  if (deployment && !deployment.aquaBidApp) {
    return <ErrorBox error="Aqua bid app not deployed: rerun scripts/deploy.sh" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Standing bids · 1inch Aqua</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Buyers post bids for native stake without locking funds: the WETH stays in their wallet and Aqua only tracks a
          virtual balance. When a listing is priced at or below a bid, anyone can match it and Aqua pulls exactly the payment
          into the StakePort escrow.
        </p>
      </div>
      <ErrorBox error={error} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <h2 className="font-semibold">Post a bid {role !== "buyer" && <span className="text-xs text-muted">(as buyer)</span>}</h2>
          <div className="mt-4 space-y-3 text-sm">
            <label className="block">
              <span className="text-muted">Receive into (0x02 validator)</span>
              <select
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2"
              >
                {targets.map((t) => (
                  <option key={t.index} value={t.index}>
                    #{t.index} · {gweiToEth(t.effectiveBalanceGwei)} ETH
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className="text-muted">Max price (% of face)</span>
                <input value={pricePct} onChange={(e) => setPricePct(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2" />
              </label>
              <label>
                <span className="text-muted">Budget (WETH)</span>
                <input value={budget} onChange={(e) => setBudget(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2" />
              </label>
            </div>
            <p className="text-xs text-muted">
              Pays up to {(32 * Number(pricePct) / 100).toFixed(3)} WETH per 32 ETH validator. Funds never leave your wallet
              until a match.
            </p>
            <Button className="w-full" onClick={onCreate} loading={busy === "create"} disabled={!buyer || target === undefined}>
              Ship bid to Aqua
            </Button>
            {steps.length > 0 && (
              <ol className="space-y-1 text-xs text-good">
                {steps.map((s, i) => (
                  <li key={i}>✓ {s}</li>
                ))}
              </ol>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="font-semibold">Matchable now</h2>
          {matches.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No open listing is priced within a bid.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {matches.map((m) => (
                <li key={m.bid.hash + m.listing.hash} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2 text-sm">
                  <span>
                    Validator <b>#{m.listing.order.sourceIndex.toString()}</b> ({gweiToEth(m.amountGwei)} ETH)
                  </span>
                  <span className="text-muted">for</span>
                  <span className="font-semibold">{eth(m.payment)} WETH</span>
                  <span className="text-xs text-muted">bid limit {eth(m.limit)}</span>
                  <Button className="ml-auto" onClick={() => onMatch(m)} loading={busy === `match-${m.bid.hash}-${m.listing.hash}`}>
                    Match
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">Matching is permissionless: the seller, the buyer or a keeper can execute it.</p>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <h2 className="mb-3 font-semibold">Bids</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-2">Strategy</th>
              <th>Maker</th>
              <th>Max price</th>
              <th>Per 32 ETH</th>
              <th>Available / budget</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bids?.map((b) => (
              <tr key={b.hash} className="border-t border-line">
                <td className="py-2">
                  <Mono>{short(b.hash, 4)}</Mono>
                </td>
                <td>
                  <Mono>{short(b.bid.maker, 4)}</Mono>
                </td>
                <td>{pct(Number(b.bid.maxPriceWad) / 1e18)}</td>
                <td>{eth(bidLimit(b.bid, 32n * 10n ** 9n), 3)} WETH</td>
                <td>
                  {eth(b.available, 2)} / {eth(b.budget, 2)} WETH
                </td>
                <td>
                  <Badge value={b.available > 0n ? "open" : "filled"} />
                </td>
                <td>
                  {b.available > 0n && b.bid.maker === buyer && role === "buyer" && (
                    <Button variant="ghost" onClick={() => run(`dock-${b.hash}`, async () => void (await dockBid(b)))} loading={busy === `dock-${b.hash}`}>
                      Dock
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bids?.length === 0 && <p className="py-3 text-sm text-muted">No bids yet.</p>}
      </Card>
    </div>
  );
}
