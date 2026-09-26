"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseEther } from "viem";
import { Badge, Button, Card, ErrorBox, Mono } from "@/components/ui";
import { api, type ValidatorInfo } from "@/lib/api";
import { errorMessage, publicClient } from "@/lib/chain";
import { getDeployment, type Deployment } from "@/lib/config";
import { gweiToEth, pct, short } from "@/lib/format";
import { enableDelegation, isDelegated, listOrder, type StakeOrder } from "@/lib/market";
import { usePersona } from "@/lib/persona";
import { stakeReference } from "@/lib/uniswap";
import { useQueues } from "@/components/QueuePanel";
import { fairValue } from "@/lib/queues";

export default function SellPage() {
  const { info } = usePersona();
  const seller = info?.personas.seller.address;
  const [validators, setValidators] = useState<ValidatorInfo[]>();
  const [selected, setSelected] = useState<number>();
  const [delegated, setDelegated] = useState<boolean>();
  const [deployment, setDeployment] = useState<Deployment>();
  const [mode, setMode] = useState<"fixed" | "lst">("fixed");
  const [price, setPrice] = useState("31.7");
  const [bps, setBps] = useState("30");
  const [minPayment, setMinPayment] = useState("31");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [listed, setListed] = useState<string>();
  const [reference, setReference] = useState<{ stakedEthPrice: bigint; wstEthPrice: bigint }>();

  const refresh = useCallback(async () => {
    if (!seller) return;
    const [vs, del, d] = await Promise.all([api.validators({ address: seller }), isDelegated(seller), getDeployment()]);
    setValidators(vs);
    setDelegated(del);
    setDeployment(d);
    setReference(await stakeReference());
    setSelected((s) => s ?? vs.find((v) => v.status === "active")?.index);
  }, [seller]);

  useEffect(() => {
    // fetch-on-mount: state is set after the async reads resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  const v = validators?.find((x) => x.index === selected);
  const amountEth = v ? v.effectiveBalanceGwei / 1e9 : 0;
  const market = useQueues();
  const fv = market && amountEth > 0 ? fairValue(market.q, amountEth, market.apr.apr) : undefined;

  async function onDelegate() {
    if (!seller) return;
    setBusy("delegate");
    setError(undefined);
    try {
      await enableDelegation(seller);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function onList() {
    if (!seller || !v) return;
    setBusy("list");
    setError(undefined);
    try {
      const now = (await publicClient.getBlock()).timestamp;
      const order: StakeOrder = {
        seller,
        sourcePubkey: v.pubkey,
        sourceIndex: BigInt(v.index),
        priceMode: mode === "fixed" ? 0 : 1,
        price: mode === "fixed" ? parseEther(price) : BigInt(bps),
        minPayment: mode === "fixed" ? 0n : parseEther(minPayment),
        expiry: now + 30n * 86400n,
        nonce: BigInt(Date.now()),
      };
      const { hash } = await listOrder(order, verifiedOnly);
      setListed(hash);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Sell native stake</h1>
        <p className="mt-1 text-sm text-muted">
          Seller <Mono>{seller ?? "…"}</Mono> is the withdrawal address of these real mainnet validators.
        </p>
      </div>
      <ErrorBox error={error} />

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <h2 className="mb-3 font-semibold">1. Choose a validator</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-2" />
                  <th>Index</th>
                  <th>Credentials</th>
                  <th>Effective</th>
                  <th>Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {validators?.map((x) => {
                  const sellable = x.status === "active" && (x.credentials === "0x01" || x.credentials === "0x02");
                  return (
                    <tr
                      key={x.index}
                      onClick={() => sellable && setSelected(x.index)}
                      className={`border-t border-line ${sellable ? "cursor-pointer hover:bg-white/5" : "opacity-50"}`}
                    >
                      <td className="py-2">
                        <input type="radio" readOnly checked={selected === x.index} disabled={!sellable} />
                      </td>
                      <td>
                        #{x.index}
                        {info?.replay?.source === x.index && (
                          <span className="ml-2 rounded-full bg-good/15 px-2 py-0.5 text-xs text-good" title={`mainnet tx ${info.replay.tx}`}>
                            real mainnet replay
                          </span>
                        )}
                      </td>
                      <td>
                        <Mono>{x.credentials}</Mono>
                      </td>
                      <td>{gweiToEth(x.effectiveBalanceGwei)} ETH</td>
                      <td>{gweiToEth(x.balanceGwei)} ETH</td>
                      <td>
                        <Badge value={x.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!validators && <p className="py-4 text-sm text-muted">Loading validators from the beacon state…</p>}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="font-semibold">2. Make the withdrawal address programmable</h2>
            <p className="mt-1 text-sm text-muted">
              An EIP-7702 delegation lets the StakePort market trigger the EIP-7251 consolidation from your address, but only
              for an order you listed and only once the buyer&apos;s payment is escrowed.
            </p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm">
                Delegate {deployment ? <Mono>{short(deployment.delegate, 4)}</Mono> : "…"}
              </span>
              {delegated ? (
                <Badge value="active" />
              ) : (
                <Button onClick={onDelegate} loading={busy === "delegate"} disabled={!seller}>
                  Enable EIP-7702
                </Button>
              )}
            </div>
            <p className="mt-3 text-xs text-muted">
              Demo note: on the fork we set the delegation designator directly because we don&apos;t hold the real
              seller&apos;s key. In production the wallet signs a 7702 authorization.
            </p>
          </Card>

          <Card>
            <h2 className="font-semibold">3. Set a price</h2>
            <div className="mt-3 flex rounded-xl border border-line p-0.5 text-sm">
              <button onClick={() => setMode("fixed")} className={`flex-1 rounded-lg py-1.5 ${mode === "fixed" ? "bg-white/10" : "text-muted"}`}>
                Fixed price
              </button>
              <button
                onClick={() => setMode("lst")}
                disabled={!deployment?.stakePriceOracle}
                title={deployment?.stakePriceOracle ? "" : "Deploy the Uniswap price oracle to enable"}
                className={`flex-1 rounded-lg py-1.5 disabled:opacity-40 ${mode === "lst" ? "bg-white/10" : "text-muted"}`}
              >
                Relative to LST market
              </button>
            </div>
            {mode === "fixed" ? (
              <>
              <label className="mt-4 block text-sm">
                <span className="text-muted">Total price (WETH)</span>
                <input value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2" />
                {amountEth > 0 && Number(price) > 0 && (
                  <span className={`mt-1 block text-xs ${Number(price) >= amountEth ? "text-good" : "text-warn"}`}>
                    {Number(price) >= amountEth
                      ? `${pct(Number(price) / amountEth - 1, 3)} premium over ${amountEth} ETH of stake`
                      : `${pct(1 - Number(price) / amountEth)} below ${amountEth} ETH of stake`}
                  </span>
                )}
              </label>
              {fv && (
                <div className="mt-3 rounded-xl bg-bg px-3 py-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span>
                      Fair value (buyer&apos;s break-even): <b>{fv.fair.toFixed(4)}</b> WETH
                    </span>
                    <button className="text-accent hover:underline" onClick={() => setPrice(fv.fair.toFixed(4))}>
                      Use it
                    </button>
                  </div>
                  <div className="mt-1 text-muted">
                    Buyers skip {fv.gainDays.toFixed(1)} days of the entry queue, worth +{pct(fv.premiumPct, 3)} at{" "}
                    {pct(fv.apr, 2)} APR.
                  </div>
                </div>
              )}
              </>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <label>
                  <span className="text-muted">Discount (bps)</span>
                  <input value={bps} onChange={(e) => setBps(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2" />
                </label>
                <label>
                  <span className="text-muted">Minimum (WETH)</span>
                  <input value={minPayment} onChange={(e) => setMinPayment(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2" />
                </label>
                <p className="col-span-2 text-xs text-muted">
                  Price = stake × Uniswap wstETH/WETH TWAP ÷ stEthPerToken × (1 − discount), evaluated at fill time.
                </p>
                {reference && (
                  <div className="col-span-2 rounded-xl bg-bg px-3 py-2 text-xs">
                    <div>
                      wstETH TWAP (30 min): <span className="font-semibold">{(Number(reference.wstEthPrice) / 1e18).toFixed(5)} WETH</span>
                    </div>
                    <div>
                      Staked ETH reference: <span className="font-semibold">{(Number(reference.stakedEthPrice) / 1e18).toFixed(5)} WETH</span>
                    </div>
                    {amountEth > 0 && (
                      <div className="text-good">
                        ≈ {((amountEth * Number(reference.stakedEthPrice)) / 1e18 * (1 - Number(bps) / 10_000)).toFixed(4)} WETH for this validator now
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <label className="mt-5 flex items-start gap-3 rounded-xl border border-line px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={verifiedOnly}
                disabled={!deployment?.worldEligibility}
                onChange={(e) => setVerifiedOnly(e.target.checked)}
              />
              <span>
                <span className="font-medium">Verified Market: World ID Passport holders only</span>
                <span className="block text-xs text-muted">
                  For sellers who must avoid counterparties in sanctioned jurisdictions. Enforced onchain at fill time.
                </span>
              </span>
            </label>
            <Button className="mt-4 w-full" onClick={onList} loading={busy === "list"} disabled={!v || !delegated}>
              List validator #{v?.index ?? "…"}
            </Button>
            {listed && (
              <p className="mt-3 text-sm text-good">
                Listed. <Link href="/" className="underline">View on the market →</Link>
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
