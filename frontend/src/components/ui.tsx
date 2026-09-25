"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-panel p-5 ${className}`}>{children}</div>;
}

export function Button({
  children,
  variant = "primary",
  loading,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger"; loading?: boolean }) {
  const styles = {
    primary: "bg-accent text-ink hover:brightness-110",
    ghost: "border border-line text-fg hover:bg-white/5",
    danger: "border border-bad/50 text-bad hover:bg-bad/10",
  }[variant];
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {loading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

const badgeColors: Record<string, string> = {
  active: "bg-good/15 text-good",
  open: "bg-good/15 text-good",
  Delivered: "bg-good/15 text-good",
  exiting: "bg-warn/15 text-warn",
  trading: "bg-warn/15 text-warn",
  RequestSubmitted: "bg-info/15 text-info",
  Accepted: "bg-info/15 text-info",
  withdrawable: "bg-muted/20 text-muted",
  filled: "bg-muted/20 text-muted",
  expired: "bg-muted/20 text-muted",
  cancelled: "bg-muted/20 text-muted",
  Failed: "bg-bad/15 text-bad",
  slashed: "bg-bad/15 text-bad",
  simulated: "bg-warn/15 text-warn",
  real: "bg-good/15 text-good",
};

const badgeLabels: Record<string, string> = {
  RequestSubmitted: "Consolidation requested",
  Accepted: "Consolidating",
};

export function Badge({ value }: { value: string }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeColors[value] ?? "bg-white/10 text-fg"}`}>
      {badgeLabels[value] ?? value}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-muted">{children}</span>;
}

export function ErrorBox({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{error}</div>;
}
