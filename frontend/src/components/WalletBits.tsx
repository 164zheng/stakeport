"use client";

import { useState } from "react";
import { createWalletClient, http, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Button, Card, Mono } from "@/components/ui";
import { myValidatorIndices, setMyValidatorIndices } from "@/lib/api";
import { chain, errorMessage, publicClient } from "@/lib/chain";
import { RPC_URL, getDeployment } from "@/lib/config";
import { short } from "@/lib/format";

/** Registers the connected wallet's validators by index (stored in this browser). */
export function MyValidators({ address, onChange }: { address: Address; onChange: () => void }) {
  const [input, setInput] = useState("");
  const [indices, setIndices] = useState<number[]>(() => myValidatorIndices(address));
  const update = (next: number[]) => {
    setMyValidatorIndices(address, next);
    setIndices(next);
    onChange();
  };
  return (
    <Card className="space-y-2">
      <div className="text-sm font-semibold">Your validators</div>
      <p className="text-xs text-muted">
        Add the indices of validators whose withdrawal address is <Mono>{short(address, 4)}</Mono> (or your 0x02 targets).
      </p>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="validator index"
          className="w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm"
        />
        <Button
          variant="ghost"
          onClick={() => {
            const n = Number(input);
            if (Number.isInteger(n) && n >= 0) update([...indices, n]);
            setInput("");
          }}
        >
          Add
        </Button>
      </div>
      {indices.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {indices.map((i) => (
            <button key={i} onClick={() => update(indices.filter((x) => x !== i))} className="rounded-full border border-line px-2 py-0.5 hover:border-bad">
              #{i} ✕
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * EIP-7702 delegation on a real network. Browser wallets only delegate to their own contracts today,
 * so the withdrawal EOA's key signs the authorization here. The key is used once, in memory, and never
 * leaves the page. Testnet use only.
 */
export function Delegate7702({ seller, onDone }: { seller: Address; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();

  async function delegate() {
    setBusy(true);
    setNote(undefined);
    try {
      if (!isHex(key) || key.length !== 66) throw new Error("expected a 32-byte hex private key");
      const account = privateKeyToAccount(key as Hex);
      if (account.address.toLowerCase() !== seller.toLowerCase()) {
        throw new Error(`key is for ${short(account.address, 4)}, not the connected withdrawal address`);
      }
      const d = await getDeployment();
      const client = createWalletClient({ account, chain, transport: http(RPC_URL) });
      const authorization = await client.signAuthorization({ contractAddress: d.delegate, executor: "self" });
      // type-4 transaction from the EOA itself carrying the authorization
      const hash = await client.sendTransaction({ to: account.address, data: "0x", authorizationList: [authorization] });
      await publicClient.waitForTransactionReceipt({ hash });
      setNote(`Delegated (tx ${short(hash, 6)})`);
      onDone();
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setKey("");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value.trim())}
        placeholder="withdrawal address private key (testnet only)"
        className="w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm"
      />
      <Button onClick={delegate} loading={busy} disabled={!key}>
        Sign EIP-7702 authorization
      </Button>
      <p className="text-xs text-muted">
        Wallets do not yet let dapps request a 7702 delegation to arbitrary contracts. The key signs one authorization in
        this page and is discarded. Use a testnet key only.
      </p>
      {note && <p className="text-xs">{note}</p>}
    </div>
  );
}
