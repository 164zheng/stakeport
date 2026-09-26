"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ErrorBox, Mono } from "@/components/ui";
import { api, type ValidatorInfo } from "@/lib/api";
import { errorMessage } from "@/lib/chain";
import { getDeployment, type Deployment } from "@/lib/config";
import { eth, gweiToEth, pct, short } from "@/lib/format";
import { WorldGate } from "@/components/WorldGate";
import { useQueues } from "@/components/QueuePanel";
import { fairValue } from "@/lib/queues";
import { fillWithWeth, isVerifiedMarket, listings, quote, type Listing } from "@/lib/market";
import { buyWithUsdc, stakeReference, usdcQuoteForListing } from "@/lib/uniswap";
import { usePersona } from "@/lib/persona";

type PayWith = "weth" | "usdc";

export default function BuyPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = use(params);
  const router = useRouter();
  const { info } = usePersona();
  const buyer = info?.personas.buyer.address;

  const [listing, setListing] = useState<Listing>();
  const [source, setSource] = useState<ValidatorInfo>();
  const [targets, setTargets] = useState<ValidatorInfo[]>();
  const [target, setTarget] = useState<number>();
  const [payment, setPayment] = useState<bigint>();
  const [payWith, setPayWith] = useState<PayWith>("weth");
  const [deployment, setDeployment] = useState<Deployment>();
  const [usdcIn, setUsdcIn] = useState<bigint>();
  const [reference, setReference] = useState<bigint>();
  const [steps, setSteps] = useState<string[]>([]);
  const [eligible, setEligible] = useState<boolean>();
  const onEligible = useCallback((e: boolean) => setEligible(e), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!buyer) return;
    (async () => {
      const [ls, d] = await Promise.all([listings(), getDeployment()]);
      setDeployment(d);
      const l = ls.find((x) => x.hash === hash);
      if (!l) throw new Error("listing not found");
      setListing(l);
      const [[src], tgts] = await Promise.all([
        api.validators({ indices: [Number(l.order.sourceIndex)] }),
        api.validators({ address: buyer }),
      ]);
      setSource(src);
      const eligible = tgts.filter((t) => t.credentials === "0x02" && t.status === "active");
      setTargets(eligible);
      setTarget(eligible.find((t) => t.effectiveBalanceGwei + src.effectiveBalanceGwei <= 2048e9)?.index);
      setPayment(await quote(l.order, BigInt(src.effectiveBalanceGwei)));
      const ref = await stakeReference();
      setReference(ref?.stakedEthPrice);
      if (d.hook) {
        const q = await usdcQuoteForListing(l, BigInt(src.effectiveBalanceGwei));
        setUsdcIn(q.usdcIn);
      }
    })().catch((e) => setError(errorMessage(e)));
  }, [buyer, hash]);

  async function onBuy() {
    if (!listing || !buyer || target === undefined) return;
    setBusy(true);
    setError(undefined);
    setSteps([]);
    try {
      const onStep = (s: string) => setSteps((x) => [...x, s]);
      const id =
        payWith === "usdc"
          ? (await buyWithUsdc(listing, buyer, target, onStep)).tradeId
          : await fillWithWeth(listing, buyer, target, onStep);
      router.push(`/trades/${id}`);
    } catch (e) {
      const msg = errorMessage(e);
      setError(
        msg.includes("BuyerNotEligible")
          ? "Rejected onchain (BuyerNotEligible): this Verified Market listing only accepts buyers with a World ID Passport attestation."
          : msg,
      );
      setBusy(false);
    }
  }

  const amountWei = source ? BigInt(source.effectiveBalanceGwei) * 10n ** 9n : 0n;
  const q = useQueues();
  const fv = q && source ? fairValue(q, source.effectiveBalanceGwei / 1e9) : undefined;
  const t = targets?.find((x) => x.index === target);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Buy native stake</h1>
        <p className="mt-1 text-sm text-muted">
          The stake of validator #{listing?.order.sourceIndex.toString() ?? "…"} is consolidated into your 0x02 validator.
        </p>
      </div>
      <ErrorBox error={error} />

      <Card className="grid gap-6 sm:grid-cols-3">
        <div>
          <div className="text-xs text-muted">You receive</div>
          <div className="text-2xl font-semibold">{source ? gweiToEth(source.effectiveBalanceGwei) : "…"} ETH</div>
          <div className="text-xs text-muted">native, already staked</div>
        </div>
        <div>
          <div className="text-xs text-muted">You pay</div>
          <div className="text-2xl font-semibold">{payment !== undefined ? eth(payment) : "…"} WETH</div>
          {payment !== undefined && amountWei > 0n && (
            <div className={`text-xs ${payment <= amountWei ? "text-good" : "text-warn"}`}>
              {payment <= amountWei
                ? `${pct(1 - Number(payment) / Number(amountWei))} below face value`
                : `${pct(Number(payment) / Number(amountWei) - 1, 3)} premium over face value`}
            </div>
          )}
          {reference !== undefined && (
            <div className="text-xs text-muted">
              Uniswap LST market: {pct(1 - Number(reference) / 1e18, 3)} discount
            </div>
          )}
        </div>
        <div>
          <div className="text-xs text-muted">Seller</div>
          <div className="font-mono text-sm">{listing ? short(listing.order.seller, 4) : "…"}</div>
          {listing && <Badge value={listing.state} />}
        </div>
      </Card>

      {fv && q && payment !== undefined && source && (
        <Card className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted">Deposit {gweiToEth(source.effectiveBalanceGwei)} ETH yourself</div>
            <div className="text-lg font-semibold">active in {q.entry.waitDays.toFixed(1)} days</div>
            <div className="text-xs text-muted">entry queue, no rewards meanwhile</div>
          </div>
          <div>
            <div className="text-xs text-muted">Buy this stake</div>
            <div className="text-lg font-semibold text-accent">delivered in {q.consolidation.deliveryDays.toFixed(1)} days</div>
            <div className="text-xs text-muted">already active, earns from delivery</div>
          </div>
          <div>
            <div className="text-xs text-muted">Value of skipping {fv.buyerGainDays.toFixed(1)} days</div>
            <div className="text-lg font-semibold">
              up to {(fv.buyerMax - source.effectiveBalanceGwei / 1e9).toFixed(4)} ETH
            </div>
            <div className={`text-xs ${Number(payment) / 1e18 <= fv.buyerMax ? "text-good" : "text-bad"}`}>
              {Number(payment) / 1e18 <= fv.buyerMax ? "this price is below your break-even" : "priced above break-even vs depositing"}
            </div>
          </div>
        </Card>
      )}

      {listing && buyer && isVerifiedMarket(listing) && <WorldGate buyer={buyer} onEligible={onEligible} />}

      <Card>
        <h2 className="font-semibold">Receive into</h2>
        <p className="mt-1 text-sm text-muted">An active 0x02 (compounding) validator you control, with room up to 2048 ETH.</p>
        <div className="mt-3 space-y-2">
          {targets?.map((x) => {
            const fits = source ? x.effectiveBalanceGwei + source.effectiveBalanceGwei <= 2048e9 : true;
            return (
              <label
                key={x.index}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ${target === x.index ? "border-accent" : "border-line"} ${fits ? "cursor-pointer" : "opacity-50"}`}
              >
                <input type="radio" checked={target === x.index} disabled={!fits} onChange={() => setTarget(x.index)} />
                <span className="font-semibold">#{x.index}</span>
                <Mono>{short(x.pubkey, 6)}</Mono>
                <span className="ml-auto">
                  {gweiToEth(x.effectiveBalanceGwei)} → {source ? gweiToEth(x.effectiveBalanceGwei + source.effectiveBalanceGwei) : "…"} ETH
                </span>
              </label>
            );
          })}
          {targets?.length === 0 && <p className="text-sm text-muted">No eligible 0x02 validator for this buyer.</p>}
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold">Pay with</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => setPayWith("weth")}
            className={`rounded-xl border px-4 py-3 text-left text-sm ${payWith === "weth" ? "border-accent" : "border-line"}`}
          >
            <div className="font-semibold">WETH</div>
            <div className="text-xs text-muted">ETH is wrapped automatically</div>
          </button>
          <button
            onClick={() => setPayWith("usdc")}
            disabled={!deployment?.hook}
            className={`rounded-xl border px-4 py-3 text-left text-sm disabled:opacity-40 ${payWith === "usdc" ? "border-accent" : "border-line"}`}
          >
            <div className="font-semibold">USDC via Uniswap v4</div>
            <div className="text-xs text-muted">
              {deployment?.hook
                ? usdcIn !== undefined
                  ? `≈ ${(Number(usdcIn) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC in one swap (0.5% slippage, excess ETH refunded)`
                  : "quoting…"
                : "hook not deployed"}
            </div>
          </button>
        </div>
      </Card>

      <Button className="w-full py-3 text-base" onClick={onBuy} loading={busy} disabled={!listing || listing.state !== "open" || target === undefined || !t}>
        {listing && isVerifiedMarket(listing) && eligible === false
          ? "Try to buy without verification"
          : `Buy ${source ? gweiToEth(source.effectiveBalanceGwei) : ""} ETH of native stake`}
      </Button>
      {steps.length > 0 && (
        <Card>
          <ol className="space-y-1 text-sm">
            {steps.map((s, i) => (
              <li key={i} className={i === steps.length - 1 && busy ? "text-fg" : "text-good"}>
                {i === steps.length - 1 && busy ? "…" : "✓"} {s}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}
