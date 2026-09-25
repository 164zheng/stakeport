"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ErrorBox, Mono } from "@/components/ui";
import { errorMessage, publicClient } from "@/lib/chain";
import { MAINNET_GENESIS, SECONDS_PER_EPOCH } from "@/lib/config";
import { duration, eth, gweiToEth, short } from "@/lib/format";
import { getTrade, refundExpired, relayAccepted, relayDelivered, trades, type Trade } from "@/lib/market";
import { usePersona } from "@/lib/persona";

interface ProofNote {
  slot: string;
  root: string;
  simulated: boolean;
  tx: string;
}

type StepState = "done" | "active" | "todo" | "failed";

function Step({ state, title, children }: { state: StepState; title: string; children?: React.ReactNode }) {
  const dot = {
    done: "bg-good text-ink",
    active: "bg-info text-ink animate-pulse",
    todo: "bg-line text-muted",
    failed: "bg-bad text-ink",
  }[state];
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      <span className={`z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${dot}`}>
        {state === "done" ? "✓" : state === "failed" ? "✕" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`font-medium ${state === "todo" ? "text-muted" : ""}`}>{title}</div>
        {children && <div className="mt-1 space-y-2 text-sm text-muted">{children}</div>}
      </div>
    </li>
  );
}

export default function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { address } = usePersona();
  const [trade, setTrade] = useState<Trade>();
  const [fillTx, setFillTx] = useState<string>();
  const [now, setNow] = useState<number>();
  const [accepted, setAccepted] = useState<ProofNote>();
  const [delivered, setDelivered] = useState<ProofNote & { moved: number }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const [t, all, block] = await Promise.all([getTrade(BigInt(id)), trades(), publicClient.getBlock()]);
    setTrade(t);
    setFillTx(all.find((x) => x.id === t.id)?.fillTx);
    setNow(Number(block.timestamp));
  }, [id]);

  useEffect(() => {
    // fetch-on-mount: state is set after the async reads resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((e) => setError(errorMessage(e)));
  }, [refresh]);

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    setError(undefined);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  const onAccepted = () =>
    run("accepted", async () => {
      const r = await relayAccepted(trade!, address ?? trade!.buyer);
      setAccepted({ slot: r.header.slot, root: r.header.root, simulated: r.simulated, tx: r.tx.hash });
    });
  const onDelivered = () =>
    run("delivered", async () => {
      const r = await relayDelivered(trade!, address ?? trade!.buyer);
      setDelivered({ slot: r.header.slot, root: r.header.root, simulated: r.simulated, tx: r.tx.hash, moved: r.movedGwei });
    });
  const onRefund = () => run("refund", async () => void (await refundExpired(trade!, address ?? trade!.buyer)));

  if (!trade) {
    return <div className="text-sm text-muted">{error ? <ErrorBox error={error} /> : "Loading…"}</div>;
  }

  const s = trade.status;
  const done = (x: boolean): StepState => (x ? "done" : "todo");
  const withdrawableAt = trade.withdrawableEpoch > 0n ? MAINNET_GENESIS + Number(trade.withdrawableEpoch) * SECONDS_PER_EPOCH : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Trade #{trade.id.toString()}</h1>
        <Badge value={s} />
      </div>
      <ErrorBox error={error} />

      <Card className="grid gap-6 sm:grid-cols-3">
        <div>
          <div className="text-xs text-muted">Stake</div>
          <div className="text-xl font-semibold">{gweiToEth(trade.amountGwei)} ETH</div>
          <div className="text-xs text-muted">
            #{trade.sourceIndex.toString()} → #{trade.targetIndex.toString()}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">Escrowed payment</div>
          <div className="text-xl font-semibold">{eth(trade.payment)} WETH</div>
        </div>
        <div className="space-y-1 text-xs">
          <div>
            seller <Mono>{short(trade.seller, 4)}</Mono>
          </div>
          <div>
            buyer <Mono>{short(trade.buyer, 4)}</Mono>
          </div>
        </div>
      </Card>

      <Card>
        <ol className="relative before:absolute before:left-3 before:top-1 before:h-[calc(100%-1.5rem)] before:w-px before:bg-line">
          <Step state="done" title="Payment escrowed">
            WETH is held by the market until the stake is delivered or the trade fails.
          </Step>
          <Step state="done" title="EIP-7251 consolidation submitted from the seller's address">
            <p>
              The seller&apos;s EIP-7702 delegate called the consolidation predeploy with{" "}
              <Mono>source_pubkey ‖ target_pubkey</Mono>.
            </p>
            {fillTx && <Mono>tx {short(fillTx, 8)}</Mono>}
          </Step>
          <Step
            state={s === "RequestSubmitted" ? "active" : s === "Failed" && trade.withdrawableEpoch === 0n ? "failed" : done(true)}
            title="Checkpoint 1: consensus layer accepted the consolidation"
          >
            <p>
              Proves <Mono>pending_consolidations</Mono> contains ({trade.sourceIndex.toString()}, {trade.targetIndex.toString()}) under an EIP-4788 beacon root.
            </p>
            {accepted && <ProofLine note={accepted} />}
            {s === "RequestSubmitted" && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={onAccepted} loading={busy === "accepted"}>
                  Relay beacon proof
                </Button>
                <Button variant="danger" onClick={onRefund} loading={busy === "refund"}>
                  Refund (after accept window)
                </Button>
              </div>
            )}
          </Step>
          <Step
            state={s === "Accepted" ? "active" : s === "Failed" ? "failed" : done(s === "Delivered")}
            title="Checkpoint 2: stake delivered to the buyer's validator"
          >
            {withdrawableAt && s === "Accepted" && now !== undefined && (
              <p>
                Source becomes withdrawable at epoch {trade.withdrawableEpoch.toString()} (in {duration(withdrawableAt - now)} of chain time).
                On mainnet the churn queue adds more.
              </p>
            )}
            <p>
              Proves the source is not slashed, past its withdrawable epoch and its balance has left (moved to #{trade.targetIndex.toString()}).
            </p>
            {delivered && (
              <>
                <ProofLine note={delivered} />
                <p className="text-good">{gweiToEth(delivered.moved)} ETH moved to validator #{trade.targetIndex.toString()}</p>
              </>
            )}
            {s === "Accepted" && (
              <Button onClick={onDelivered} loading={busy === "delivered"}>
                Fast-forward to delivery & relay proof
              </Button>
            )}
          </Step>
          <Step state={s === "Delivered" ? "done" : s === "Failed" ? "failed" : "todo"} title={s === "Failed" ? "Payment refunded to buyer" : "Payment released to seller"}>
            {s === "Delivered" && <p className="text-good">{eth(trade.payment)} WETH sent to {short(trade.seller, 4)}</p>}
          </Step>
        </ol>
      </Card>

      <p className="text-xs text-muted">
        Fill proofs use a real mainnet beacon state. Checkpoint states are simulated from it (the real wait is 27h+ plus the
        churn queue) and verified by the same on-chain code path.
      </p>
    </div>
  );
}

function ProofLine({ note }: { note: ProofNote }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-bg px-3 py-2">
      <Badge value={note.simulated ? "simulated" : "real"} />
      <span className="text-xs">slot {note.slot}</span>
      <Mono>root {short(note.root, 6)}</Mono>
      <Mono>tx {short(note.tx, 6)}</Mono>
    </div>
  );
}
