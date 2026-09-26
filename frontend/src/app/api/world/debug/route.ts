import { NextResponse } from "next/server";

/** Local diagnostics: IDKit debug reports are written to the server log (never contains our secrets). */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  console.warn("[world] idkit debug report", JSON.stringify(body, null, 2));
  return NextResponse.json({ ok: true });
}
