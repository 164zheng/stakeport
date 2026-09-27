"use client";

import { CredentialRequest, IDKitRequestWidget, any, identityCheck, setDebug, type RpContext } from "@worldcoin/idkit";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { Badge, Button, Card } from "@/components/ui";
import { errorMessage } from "@/lib/chain";
import { IDENTITY_CHECK, eligibility, rpContext, signalFor, verifyAndAttest, worldConfig, type WorldConfig } from "@/lib/world";

/**
 * Verified Market gate. The listing's seller only accepts counterparties outside sanctioned
 * jurisdictions: a World ID NFC document (passport or My Number Card), or Identity Check locally (see README).
 */
export function WorldGate({
  buyer,
  policy,
  kind,
  onEligible,
}: {
  buyer: Address;
  /** the listing's eligibility policy contract */
  policy: Address;
  /** the requirement the seller picked for this listing */
  kind: "document" | "identity";
  onEligible: (eligible: boolean) => void;
}) {
  const [config, setConfig] = useState<WorldConfig>();
  const [status, setStatus] = useState<{ eligible: boolean; until: bigint }>();
  const [ctx, setCtx] = useState<RpContext>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string }>();
  const [country, setCountry] = useState("JPN");
  const useIdentity = IDENTITY_CHECK && kind === "identity";

  const refresh = useCallback(async () => {
    const [c, e] = await Promise.all([worldConfig(), eligibility(buyer, policy)]);
    setConfig(c);
    setStatus(e);
    onEligible(e.eligible);
  }, [buyer, policy, onEligible]);

  useEffect(() => {
    // fetch-on-mount: state is set after the async reads resolve
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((e) => setNote({ kind: "bad", text: errorMessage(e) }));
  }, [refresh]);

  const report = (kind: string, payload: unknown) =>
    fetch("/api/world/debug", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, payload }) }).catch(() => {});

  async function start() {
    setDebug(true);
    setBusy(true);
    setNote(undefined);
    try {
      setCtx(await rpContext(useIdentity ? "identity" : undefined));
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
          {useIdentity ? "World ID Identity Check" : "World ID NFC document"} verified for this account until{" "}
          {new Date(Number(status.until) * 1000).toLocaleDateString()}.
        </span>
      </Card>
    );
  }

  return (
    <Card className="space-y-3 border-warn/40">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-warn/15 px-2.5 py-0.5 text-xs font-medium text-warn">Verified Market</span>
        <h2 className="font-semibold">
          {useIdentity ? "This seller requires World ID Identity Check" : "This seller requires a World ID NFC document"}
        </h2>
      </div>
      {useIdentity ? (
        <>
          <p className="text-sm text-muted">
            The seller only trades with counterparties outside sanctioned jurisdictions. <b>World ID Identity Check</b>{" "}
            (preview) has World App attest that your NFC document (passport or My Number Card) was issued by the country
            you state, without revealing the document. Documents issued by a sanctioned jurisdiction are rejected. It is not
            a KYC check.
          </p>
          <label className="block text-sm">
            Issuing country of your document
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="mt-1 block w-72 rounded-xl border border-line bg-bg px-3 py-2"
            >
              {COUNTRIES.map(([code, name, sanctioned]) => (
                <option key={code} value={code}>
                  {name} ({code}){sanctioned ? " - sanctioned" : ""}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
      <p className="text-sm text-muted">
        The seller only trades with counterparties outside sanctioned jurisdictions. The credential that proves this
        (World ID Identity Check with a nationality attribute) is in preview, so this listing requires the closest one
        available today: an <b>NFC document credential</b> (passport or My Number Card). It shows a real government
        document holder, one account per document, without revealing who you are. It is not a KYC or sanctions check.
      </p>
      )}
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
          {useIdentity ? `Verify with World ID Identity Check (${country})` : "Verify with World ID (Passport / My Number Card)"}
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
          action={useIdentity ? `${config.action}-idcheck` : config.action}
          rp_context={ctx}
          environment={config.environment}
          // World ID 4.0 only: the legacy fallback accepts any level >= document (e.g. Orb)
          allow_legacy_proofs={false}
          {...(useIdentity
            ? {
                // the preset requests any(passport, mnc); legacy_signal becomes the request signal (buyer binding)
                preset: identityCheck({
                  attributes: [{ type: "issuing_country", value: country }],
                  legacy_signal: signalFor(buyer),
                }),
              }
            : {
                // one NFC government document: a passport or a Japanese My Number Card (same NFC credential)
                constraints: any(
                  CredentialRequest("passport", { signal: signalFor(buyer) }),
                  CredentialRequest("mnc", { signal: signalFor(buyer) }),
                ),
              })}
          handleVerify={async (result) => {
            try {
              await verifyAndAttest(buyer, result, useIdentity ? country : undefined);
            } catch (e) {
              void report("result_rejected", {
                protocol_version: result.protocol_version,
                environment: result.environment,
                identifiers: result.responses.map((r) => r.identifier),
              });
              const msg = errorMessage(e);
              setNote({
                kind: "bad",
                text: msg.startsWith("sanctioned_jurisdiction")
                  ? `Rejected: this seller does not accept documents issued by ${country} (sanctioned jurisdiction). Nothing was recorded.`
                  : `Rejected: ${msg}`,
              });
              throw e;
            }
          }}
          onSuccess={async () => {
            setNote({ kind: "ok", text: "Document verified: you can buy in the Verified Market." });
            await refresh();
          }}
          onError={(code, debugReport) => {
            void report(`error:${code}`, debugReport);
            const text =
              code === "identity_attributes_not_matched"
                ? `Your document's issuing country does not match ${country}. Nothing was recorded; the purchase is not allowed.`
                : code === "credential_unavailable"
                ? "No passport / My Number Card credential in your World ID. Verified Market listings stay locked; open listings are still available."
                : code === "user_rejected" || code === "cancelled"
                  ? "Verification cancelled. Nothing was recorded; the purchase is not allowed."
                  : code === "failed_by_host_app"
                    ? undefined
                    : code === "world_id_4_not_available"
                      ? "Your World ID has no NFC document credential yet. Add your passport or My Number Card in World App and retry."
                      : `Verification failed (${code}). The purchase is not allowed.`;
            // failed_by_host_app: our backend's reason is already shown by handleVerify
            if (text) setNote({ kind: "bad", text });
          }}
        />
      )}
    </Card>
  );
}

/** Issuing countries offered in Identity Check mode (ISO 3166-1 alpha-3); sanctioned ones are listed to show the rejection. */
const COUNTRIES: readonly (readonly [string, string, boolean])[] = [
  ["JPN", "Japan", false],
  ["USA", "United States", false],
  ["GBR", "United Kingdom", false],
  ["DEU", "Germany", false],
  ["FRA", "France", false],
  ["KOR", "South Korea", false],
  ["SGP", "Singapore", false],
  ["TWN", "Taiwan", false],
  ["CAN", "Canada", false],
  ["AUS", "Australia", false],
  ["IND", "India", false],
  ["BRA", "Brazil", false],
  ["CUB", "Cuba", true],
  ["IRN", "Iran", true],
  ["PRK", "North Korea", true],
  ["SYR", "Syria", true],
  ["RUS", "Russia", true],
  ["BLR", "Belarus", true],
];
