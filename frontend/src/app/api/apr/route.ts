import { NextResponse } from "next/server";

const LIDO_APR = "https://eth-api.lido.fi/v1/protocol/steth/apr/sma";
/** Lido takes 10% of staking rewards; dividing it back out approximates a native validator's yield. */
const LIDO_FEE = 0.1;
const FALLBACK_APR = 0.029;

/** Consensus staking APR estimate: Lido stETH 7-day SMA APR, grossed up for Lido's fee. Cached 1 hour. */
export async function GET() {
  try {
    const res = await fetch(LIDO_APR, { next: { revalidate: 3600 } });
    const json = await res.json();
    const steth = Number(json.data.smaApr) / 100;
    if (!(steth > 0 && steth < 0.2)) throw new Error("unexpected APR");
    return NextResponse.json({ apr: steth / (1 - LIDO_FEE), stethApr: steth, source: "Lido stETH 7-day APR / 0.9" });
  } catch {
    return NextResponse.json({ apr: FALLBACK_APR, stethApr: null, source: "fallback estimate" });
  }
}
