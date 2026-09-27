"use client";

import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";

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

/** Modal error dialog for rejected transactions: a clear title, what happened, and the next step. */
export function ErrorDialog({
  title,
  body,
  detail,
  action,
  onClose,
}: {
  title: string;
  body: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4" onClick={onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="error-dialog-title"
        className="w-full max-w-md rounded-2xl border border-bad/50 bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bad/15 font-bold text-bad">!</span>
          <div className="space-y-2">
            <h2 id="error-dialog-title" className="font-semibold text-fg">
              {title}
            </h2>
            <p className="text-sm text-muted">{body}</p>
            {detail && <p className="break-all font-mono text-xs text-bad">{detail}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {action && <Button onClick={action.onClick}>{action.label}</Button>}
        </div>
      </div>
    </div>
  );
}
