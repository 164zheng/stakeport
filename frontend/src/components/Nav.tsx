"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePersona } from "@/lib/persona";
import { short } from "@/lib/format";
import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { errorMessage, publicClient, testClient } from "@/lib/chain";
import { IS_FORK } from "@/lib/config";

const links = [
  { href: "/demo", label: "Demo" },
  { href: "/", label: "Market" },
  { href: "/sell", label: "Sell" },
  { href: "/bids", label: "Bids" },
  { href: "/trades", label: "Trades" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Nav() {
  const path = usePathname();
  const { role, setRole, address, error, wallet, connect, disconnect } = usePersona();
  const [faucet, setFaucet] = useState<string>();
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-ink">◆</span>
          StakePort
        </Link>
        <nav className="flex gap-1 text-sm">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-1.5 ${path === l.href ? "bg-white/10 text-fg" : "text-muted hover:text-fg"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="hidden text-muted sm:inline">Acting as</span>
          <div className="flex rounded-xl border border-line p-0.5">
            {(["seller", "buyer"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`rounded-lg px-3 py-1 capitalize ${role === r ? "bg-accent text-ink" : "text-muted"}`}
              >
                {r}
              </button>
            ))}
          </div>
          <span className="font-mono text-xs text-muted">{address ? short(address, 4) : error ? "offline" : "…"}</span>
          {wallet ? (
            <>
              {IS_FORK && (
                <>
                <button
                  onClick={async () => {
                    try {
                      await testClient.setBalance({ address: wallet, value: parseEther("100") });
                      const bal = await publicClient.getBalance({ address: wallet });
                      setFaucet(`${Number(formatEther(bal)).toFixed(2)} ETH on the fork`);
                    } catch (e) {
                      setFaucet(`failed: ${errorMessage(e)}`);
                    }
                  }}
                  title="Fork only: give the connected wallet 100 test ETH"
                  className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-fg"
                >
                  +100 ETH
                </button>
                {faucet && <span className="text-xs text-muted">{faucet}</span>}
                </>
              )}
              <button onClick={disconnect} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-fg">
                Disconnect
              </button>
            </>
          ) : (
            <button onClick={() => connect().catch(() => {})} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-fg">
              Connect wallet
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
