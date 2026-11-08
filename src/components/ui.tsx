import type { ReactNode } from 'react';
import { initials } from '../types';

// Shared atoms (design system §5). Token classes only.

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full border border-strong bg-raised font-semibold text-secondary"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials(name)}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-success text-app',
  trialing: 'bg-sky text-app',
  past_due: 'bg-warning text-app',
  cancelled: 'bg-orange text-app',
  ended: 'bg-muted text-app',
  archived: 'bg-muted text-app',
};

export function StatusBadge({ status }: { status: string }) {
  const label = status === 'past_due' ? 'Past due' : status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLES[status] || 'bg-muted text-app'}`}
    >
      {label}
    </span>
  );
}

export function StatusDot({ status }: { status: string | null }) {
  const color =
    status === 'active'
      ? 'bg-success'
      : status === 'trialing'
        ? 'bg-sky'
        : status === 'past_due'
          ? 'bg-warning'
          : status === 'cancelled'
            ? 'bg-orange'
            : 'bg-muted';
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/** The Shared marker (design system §5.4) — rendered from visibility data. */
export function SharedMarker({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-block rounded-full bg-bright/10 px-2 py-0.5 text-[11px] font-semibold text-bright">
      {compact ? 'Shared' : 'Shared with client'}
    </span>
  );
}

export function LockLabel() {
  return <span className="text-xs font-medium uppercase tracking-wide text-muted">🔒 Only you</span>;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[44px] items-center justify-center rounded-[10px] bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-[44px] items-center justify-center rounded-[10px] border border-strong bg-raised px-4 text-sm font-medium text-primary transition-colors hover:border-bright disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-[40px] items-center justify-center rounded-[10px] px-3 text-sm font-medium ${danger ? 'text-danger' : 'text-bright'}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[14px] border border-line bg-surface p-4 ${className}`}>{children}</section>;
}

export function SectionTitle({ children, marker }: { children: ReactNode; marker?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold text-primary">{children}</h2>
      {marker}
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="max-w-sm text-sm text-secondary">{children}</p>
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-pulse h-14 rounded-[10px] bg-raised" />
      ))}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-[10px] border-l-[3px] border-danger bg-danger/10 px-3 py-2 text-sm text-primary">
      {message}
    </div>
  );
}

export const inputClass =
  'w-full rounded-[10px] border border-strong bg-raised px-3 py-2.5 text-sm text-primary placeholder:text-muted focus:border-bright';
export const labelClass = 'mb-1 block text-xs font-medium uppercase tracking-wide text-muted';
