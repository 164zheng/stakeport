import { formatEther, formatUnits } from "viem";

export const short = (s: string, n = 6) => (s.length > 2 * n + 2 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);
export const eth = (wei: bigint, digits = 4) =>
  Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: digits });
export const gweiToEth = (gwei: number | bigint, digits = 4) =>
  Number(formatUnits(BigInt(gwei), 9)).toLocaleString("en-US", { maximumFractionDigits: digits });
export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const pct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)}%`;
export function duration(seconds: number) {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
