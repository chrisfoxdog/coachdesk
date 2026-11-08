import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Flag } from '../types';
import { Card, EmptyState, ErrorBanner, GhostButton, SkeletonRows } from './ui';

const SEVERITY_BAR: Record<string, string> = {
  urgent: 'border-urgent',
  attention: 'border-warning',
  notice: 'border-bright',
};
const SEVERITY_WORD: Record<string, string> = {
  urgent: 'Urgent',
  attention: 'Attention',
  notice: 'Notice',
};
const TYPE_WORD: Record<string, string> = {
  intake_missing: 'Intake',
  checkin_missed: 'Check-in',
  goal_stale: 'Stale goal',
  membership_past_due: 'Past due',
  session_upcoming: 'Session',
};

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours}h`;
  return 'now';
}

export default function Inbox({ onOpen }: { onOpen: (clientId: string) => void }) {
  const [open, setOpen] = useState<Flag[] | null>(null);
  const [resolved, setResolved] = useState<Flag[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ open: Flag[]; resolved: Flag[] }>('/api/coach/inbox')
      .then((r) => {
        setOpen(r.open);
        setResolved(r.resolved);
      })
      .catch((e) => setError(e.message || 'Could not load the inbox.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dismiss = async (id: string) => {
    setOpen((prev) => (prev || []).filter((f) => f.id !== id));
    try {
      await api.post(`/api/coach/flags/${id}/dismiss`);
      load();
    } catch {
      load();
    }
  };

  return (
    <div>
      <h1 className="mb-1 text-[22px] font-semibold">Needs attention</h1>
      <p className="mb-4 text-xs text-muted">
        {open ? `${open.length} open · sorted by urgency` : 'Loading…'} · Flags come from dates and statuses only —
        never from what anyone wrote.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {open === null ? (
        <SkeletonRows rows={4} />
      ) : open.length === 0 ? (
        <Card>
          <EmptyState>Nothing needs attention.</EmptyState>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {open.map((f) => (
            <li
              key={f.id}
              className={`rounded-[10px] border border-line border-l-[3px] ${SEVERITY_BAR[f.severity]} bg-surface p-3`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[15px] font-semibold">{f.client_name}</p>
                <span className="text-xs text-muted">{ageLabel(f.created_at)}</span>
              </div>
              <p className="mt-0.5 text-sm text-secondary">{f.detail}</p>
              <p className="mt-0.5 text-xs text-muted">
                {SEVERITY_WORD[f.severity]} · {TYPE_WORD[f.type] || f.type}
              </p>
              <div className="mt-1 flex gap-1">
                <GhostButton onClick={() => onOpen(f.client_id)}>Open record</GhostButton>
                <GhostButton onClick={() => dismiss(f.id)}>Dismiss</GhostButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <div className="mt-5">
          <GhostButton onClick={() => setShowResolved((s) => !s)}>
            {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
          </GhostButton>
          {showResolved && (
            <ul className="mt-2 flex flex-col gap-2">
              {resolved.map((f) => (
                <li key={f.id} className="rounded-[10px] border border-line bg-surface p-3 text-muted">
                  <p className="text-sm">
                    {f.client_name} — {f.detail} · Resolved
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
