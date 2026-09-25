"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Card, ErrorBox, Mono } from "@/components/ui";
import { eth, gweiToEth, short } from "@/lib/format";
import { trades, type Trade } from "@/lib/market";

export default function TradesPage() {
  const [items, setItems] = useState<Trade[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    trades().then(setItems).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Trades</h1>
      <ErrorBox error={error} />
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-5 py-3">Trade</th>
              <th>Stake</th>
              <th>Route</th>
              <th>Payment</th>
              <th>Seller</th>
              <th>Buyer</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items?.map((t) => (
              <tr key={t.id.toString()} className="border-b border-line last:border-0 hover:bg-white/5">
                <td className="px-5 py-3">
                  <Link href={`/trades/${t.id}`} className="font-semibold text-accent hover:underline">
                    #{t.id.toString()}
                  </Link>
                </td>
                <td>{gweiToEth(t.amountGwei)} ETH</td>
                <td>
                  #{t.sourceIndex.toString()} → #{t.targetIndex.toString()}
                </td>
                <td>{eth(t.payment)} WETH</td>
                <td>
                  <Mono>{short(t.seller, 4)}</Mono>
                </td>
                <td>
                  <Mono>{short(t.buyer, 4)}</Mono>
                </td>
                <td>
                  <Badge value={t.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items?.length === 0 && <p className="px-5 py-4 text-sm text-muted">No trades yet.</p>}
      </Card>
    </div>
  );
}
