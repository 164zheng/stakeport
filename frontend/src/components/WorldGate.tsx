"use client";

import { IDKitRequestWidget, passport, type RpContext } from "@worldcoin/idkit";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { Badge, Button, Card } from "@/components/ui";
import { errorMessage } from "@/lib/chain";
import { eligibility, rpContext, signalFor, verifyAndAttest, worldConfig, type WorldConfig } from "@/lib/world";

/**
 * Verified Market gate. The listing's seller only accepts counterparties outside sanctioned
 * jurisdictions; the closest credential available today is a World ID Passport (see README).
 */
export function WorldGate({ buyer, onEligible }: { buyer: Address; onEligible: (eligible: boolean) => void }) {
  const [config, setConfig] = useState<WorldConfig>();
  const [status, setStatus] = useState<{ eligible: boolean; until: bigint }>();
  const [ctx, setCtx] = useState<RpContext>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string }>();

  const refresh = useCallback(async () => {
    const [c, e] = await Promise.all([worldConfig(), eligibility(buyer)]);
    setConfig(c);
    setStatus(e);
    onEligible(e.eligible);
  }, [buyer, onEligible]);

  useEffect(() => {
    // fetch-on-mount: state is set after the async reads resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((e) => setNote({ kind: "bad", text: errorMessage(e) }));
  }, [refresh]);

  async function start() {
    setBusy(true);
    setNote(undefined);
    try {
      setCtx(await rpContext());
      setOpen(true);
    } catch (e) {
      setNote({ kind: "bad", text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  if (status?.eligible) {
    return (
      <Card className="flex items-center gap-3">
        <Badge value="active" />
        <span className="text-sm">
          World ID Passport verified for this account until{" "}
          {new Date(Number(status.until) * 1000).toLocaleDateString()}.
        </span>
      </Card>
    );
  }

  return (
    <Card className="space-y-3 border-warn/40">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-warn/15 px-2.5 py-0.5 text-xs font-medium text-warn">Verified Market</span>
        <h2 className="font-semibold">This seller requires a World ID Passport</h2>
      </div>
      <p className="text-sm text-muted">
        The seller only trades with counterparties outside sanctioned jurisdictions. The credential that proves this
        (World ID Identity Check with a nationality attribute) is in preview, so this listing requires the closest one
        available today: a <b>Passport (NFC)</b> credential. It shows a real government document holder, one account per
        passport, without revealing who you are. It is not a KYC or sanctions check.
      </p>
      <p className="text-xs text-muted">
        The proof is bound to your address, verified by our backend with the World Developer Portal, and recorded
        onchain as an eligibility attestation. The market enforces it at fill time, for every payment route.
      </p>
      {config && !config.configured ? (
        <p className="rounded-xl bg-bg px-3 py-2 text-sm text-warn">
          World ID is not configured on this server (set NEXT_PUBLIC_WORLD_APP_ID, WORLD_RP_ID, WORLD_RP_SIGNING_KEY).
        </p>
      ) : (
        <Button onClick={start} loading={busy} disabled={!config}>
          Verify with World ID (Passport)
        </Button>
      )}
      {config?.environment === "staging" && (
        <p className="text-xs text-muted">
          Staging: scan the QR code with the{" "}
          <a className="underline" href="https://simulator.worldcoin.org" target="_blank" rel="noreferrer">
            World ID simulator
          </a>
          .
        </p>
      )}
      {note && <p className={`text-sm ${note.kind === "ok" ? "text-good" : "text-bad"}`}>{note.text}</p>}

      {config?.configured && ctx && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={config.appId!}
          action={config.action}
          rp_context={ctx}
          environment={config.environment}
          allow_legacy_proofs={true}
          preset={passport({ signal: signalFor(buyer) })}
          handleVerify={async (result) => {
            await verifyAndAttest(buyer, result);
          }}
          onSuccess={async () => {
            setNote({ kind: "ok", text: "Passport verified: you can buy in the Verified Market." });
            await refresh();
          }}
          onError={(code) => {
            const text =
              code === "credential_unavailable"
                ? "No Passport credential in your World ID. Verified Market listings stay locked; open listings are still available."
                : code === "user_rejected" || code === "cancelled"
                  ? "Verification cancelled. Nothing was recorded; the purchase is not allowed."
                  : code === "failed_by_host_app"
                    ? "Our backend rejected the proof (wrong credential, signal or failed Developer Portal check). The purchase is not allowed."
                    : `Verification failed (${code}). The purchase is not allowed.`;
            setNote({ kind: "bad", text });
          }}
        />
      )}
    </Card>
  );
}
