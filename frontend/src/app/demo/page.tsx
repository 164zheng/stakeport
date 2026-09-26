"use client";

import Link from "next/link";
import { useState } from "react";
import { parseEther } from "viem";
import { QueuePanel, useQueues } from "@/components/QueuePanel";
import { Badge, Button, Card, ErrorBox, Mono } from "@/components/ui";
import { api } from "@/lib/api";
import { errorMessage, publicClient } from "@/lib/chain";
import { eth, short } from "@/lib/format";
import {
  enableDelegation,
  fillProofs,
  fillWithEth,
  getTrade,
  listOrder,
  listings,
  relayAccepted,
  relayDelivered,
  type Listing,
  type StakeOrder,
  type Trade,
} from "@/lib/market";
import { usePersona } from "@/lib/persona";
import { fairValue } from "@/lib/queues";
import { buyWithUsdc } from "@/lib/uniswap";

type ProofInfo = { slot: string; root: string; simulated: boolean };

interface StepDef {
  title: string;
  eips: string[];
  explain: string;
}

const STEPS: StepDef[] = [
  {
    title: "Seller lists an active validator",
    eips: ["EIP-7702"],
    explain:
      "The seller's withdrawal address delegates to the StakePort contract, so the market can later trigger the consolidation from that address. The price is the fair value implied by today's mainnet queues.",
  },
  {
    title: "Buyer pays; the stake starts moving",
    eips: ["EIP-4788", "EIP-7251", "Uniswap v4"],
    explain:
      "The market checks real beacon state proofs of both validators against an EIP-4788 root, escrows the payment and submits an EIP-7251 consolidation from the seller's address. With USDC, one Uniswap v4 swap does all of it inside the hook.",
  },
  {
    title: "Checkpoint 1: the consensus layer accepted it",
    eips: ["EIP-4788", "SSZ"],
    explain:
      "Proves that BeaconState.pending_consolidations contains (source, target). For this pair the proof comes from the real mainnet beacon state that processed the same request.",
  },
  {
    title: "Checkpoint 2: stake delivered, seller paid",
    eips: ["EIP-4788", "SSZ"],
    explain:
      "Once the source is withdrawable its balance moves to the buyer's validator. The proof shows the source is not slashed, past its withdrawable epoch and emptied; escrow pays the seller. (Simulated: on mainnet this is ~3 days later.)",
  },
];

export default function DemoPage() {
  const { info, setRole } = usePersona();
  const q = useQueues();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  const [listing, setListing] = useState<Listing>();
  const [trade, setTrade] = useState<Trade>();
  const [proofs, setProofs] = useState<Record<number, ProofInfo>>({});

  const replay = info?.replay;
  const seller = info?.personas.seller.address;
  const buyer = info?.personas.buyer.address;
  const add = (s: string) => setLog((l) => [...l, s]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setStep((s) => s + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const doList = () =>
    run(async () => {
      if (!seller || !replay || !q) throw new Error("demo needs the replay fixture and the proof service");
      setRole("seller");
      const [v] = await api.validators({ indices: [replay.source] });
      // price the amount the market will use: the effective balance in the fill proof
      const p = await fillProofs(replay.source, replay.target);
      const amountGwei = Number((p.source.validator as unknown as { effectiveBalance: bigint }).effectiveBalance);
      if (amountGwei === 0) throw new Error("validator already consolidated in this session: restart with scripts/dev.sh");
      add(`Seller ${short(seller, 4)} owns validator #${v.index} (real mainnet validator, ${amountGwei / 1e9} ETH)`);
      await enableDelegation(seller);
      add("EIP-7702 delegation to the StakePort delegate");
      const price = fairValue(q, amountGwei / 1e9).fair;
      const now = (await publicClient.getBlock()).timestamp;
      const order: StakeOrder = {
        seller,
        sourcePubkey: v.pubkey,
        sourceIndex: BigInt(v.index),
        priceMode: 0,
        price: parseEther(price.toFixed(6)),
        minPayment: 0n,
        expiry: now + 30n * 86400n,
        nonce: BigInt(Date.now()),
      };
      await listOrder(order);
      const l = (await listings()).find((x) => x.order.nonce === order.nonce);
      setListing(l);
      add(`Listed at ${price.toFixed(4)} WETH (fair value from the entry-queue premium)`);
    });

  const doBuy = (route: "eth" | "usdc") =>
    run(async () => {
      if (!listing || !buyer || !replay) throw new Error("list first");
      setRole("buyer");
      const onStep = (s: string) => add(s);
      const id =
        route === "usdc"
          ? (await buyWithUsdc(listing, buyer, replay.target, onStep)).tradeId
          : await fillWithEth(listing, buyer, replay.target, onStep);
      setTrade(await getTrade(id));
      add(`Trade #${id}: payment escrowed, consolidation ${replay.source} → ${replay.target} requested`);
    });

  const doAccepted = () =>
    run(async () => {
      if (!trade) throw new Error("buy first");
      const r = await relayAccepted(trade, buyer ?? trade.buyer);
      setProofs((p) => ({ ...p, 1: { slot: r.header.slot, root: r.header.root, simulated: r.simulated } }));
      setTrade(await getTrade(trade.id));
      add(`Checkpoint 1 verified onchain against beacon slot ${r.header.slot} (${r.simulated ? "simulated" : "real mainnet"})`);
    });

  const doDelivered = () =>
    run(async () => {
      if (!trade) throw new Error("accept first");
      const r = await relayDelivered(trade, buyer ?? trade.buyer);
      setProofs((p) => ({ ...p, 2: { slot: r.header.slot, root: r.header.root, simulated: r.simulated } }));
      const t = await getTrade(trade.id);
      setTrade(t);
      add(`Delivered: ${r.movedGwei / 1e9} ETH moved; ${eth(t.payment)} WETH paid to the seller`);
    });

  const actions: Record<number, React.ReactNode> = {
    0: (
      <Button onClick={doList} loading={busy} disabled={!replay || !q}>
        Enable 7702 and list at fair value
      </Button>
    ),
    1: (
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => doBuy("eth")} loading={busy}>
          Buy with ETH (one transaction)
        </Button>
        <Button variant="ghost" onClick={() => doBuy("usdc")} loading={busy}>
          Buy with USDC via Uniswap v4
        </Button>
      </div>
    ),
    2: (
      <Button onClick={doAccepted} loading={busy}>
        Relay checkpoint 1 proof
      </Button>
    ),
    3: (
      <Button onClick={doDelivered} loading={busy}>
        Fast-forward and relay checkpoint 2
      </Button>
    ),
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Guided demo</h1>
        <p className="mt-1 text-sm text-muted">
          Replays a real mainnet consolidation
          {replay && (
            <>
              {" "}
              (#{replay.source} → #{replay.target}, block {replay.block}, <Mono>{short(replay.tx, 6)}</Mono>)
            </>
          )}{" "}
          as a StakePort trade on a mainnet fork.
        </p>
      </div>

      <QueuePanel />
      <ErrorBox error={error} />

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-3">
          {STEPS.map((s, i) => {
            const state = i < step ? "done" : i === step ? "active" : "todo";
            return (
              <Card key={s.title} className={state === "active" ? "border-accent/60" : state === "todo" ? "opacity-50" : ""}>
                <div className="flex items-start gap-3">
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold ${
                      state === "done" ? "bg-good text-ink" : state === "active" ? "bg-accent text-ink" : "bg-line text-muted"
                    }`}
                  >
                    {state === "done" ? "✓" : i + 1}
                  </span>
                  <div className="flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{s.title}</h2>
                      {s.eips.map((e) => (
                        <span key={e} className="rounded-full border border-line px-2 py-0.5 text-xs text-accent">
                          {e}
                        </span>
                      ))}
                    </div>
                    <p className="text-sm text-muted">{s.explain}</p>
                    {proofs[i - 1] && (
                      <div className="flex items-center gap-2 text-xs">
                        <Badge value={proofs[i - 1].simulated ? "simulated" : "real"} />
                        slot {proofs[i - 1].slot} <Mono>root {short(proofs[i - 1].root, 6)}</Mono>
                      </div>
                    )}
                    {state === "active" && actions[i]}
                  </div>
                </div>
              </Card>
            );
          })}
          {step >= STEPS.length && trade && (
            <Card className="flex flex-wrap items-center gap-3">
              <Badge value="Delivered" />
              <span className="text-sm">Native stake sold without exiting, bought without the entry queue.</span>
              <Link href={`/trades/${trade.id}`} className="text-sm text-accent hover:underline">
                Trade #{trade.id.toString()} →
              </Link>
              <Link href="/portfolio" className="text-sm text-accent hover:underline">
                Portfolio →
              </Link>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-2 font-semibold">Onchain log</h2>
          {log.length === 0 ? (
            <p className="text-sm text-muted">Every step below is a real transaction on the mainnet fork.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {log.map((l, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-good">✓</span>
                  <span>{l}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-4 text-xs text-muted">
            Verified Market (World ID) and Aqua bids are on the Market and Bids pages. Restart the demo with scripts/dev.sh.
          </p>
        </Card>
      </div>
    </div>
  );
}
