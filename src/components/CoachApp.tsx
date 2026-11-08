import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { RosterClient } from '../types';
import { formatDate } from '../types';
import { Avatar, Card, EmptyState, ErrorBanner, GhostButton, SkeletonRows, StatusDot, inputClass } from './ui';
import ClientRecord from './ClientRecord';
import Inbox from './Inbox';
import Settings from './Settings';

type View = { name: 'roster' } | { name: 'inbox' } | { name: 'settings' } | { name: 'record'; id: string; from: 'roster' | 'inbox' };

export default function CoachApp({ coachName }: { coachName: string }) {
  const [view, setView] = useState<View>({ name: 'roster' });
  const [openCount, setOpenCount] = useState(0);

  const refreshBadge = useCallback(() => {
    api
      .get<{ open_count: number }>('/api/coach/inbox')
      .then((r) => setOpenCount(r.open_count))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshBadge();
  }, [refreshBadge, view]);

  const openRecord = (id: string, from: 'roster' | 'inbox') => setView({ name: 'record', id, from });

  const navItems: { name: View['name']; label: string; badge?: number }[] = [
    { name: 'roster', label: 'Roster' },
    { name: 'inbox', label: 'Inbox', badge: openCount },
    { name: 'settings', label: 'Settings' },
  ];
  const isActive = (n: string) => view.name === n || (n === 'roster' && view.name === 'record');

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1120px] md:flex-row">
      {/* Left rail (md+) */}
      <nav aria-label="Coach" className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-line p-4 md:flex">
        <div className="mb-6">
          <p className="text-base font-semibold">CoachDesk</p>
          <p className="text-xs text-muted">by Elite Software Studio</p>
        </div>
        <ul className="flex flex-col gap-1">
          {navItems.map((item) => (
            <li key={item.name}>
              <button
                aria-current={isActive(item.name) ? 'page' : undefined}
                onClick={() => setView({ name: item.name } as View)}
                className={`flex min-h-[44px] w-full items-center gap-2 rounded-[10px] px-3 text-sm font-medium ${
                  isActive(item.name)
                    ? 'border-l-2 border-bright bg-bright/10 text-primary'
                    : 'text-secondary hover:bg-raised'
                }`}
              >
                {item.label}
                {item.badge ? (
                  <span className="ml-auto rounded-full bg-warning px-2 py-0.5 text-[11px] font-semibold text-app">
                    {item.badge}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-auto text-xs text-muted">{coachName}</p>
      </nav>

      <main className="min-w-0 flex-1 px-4 pb-24 pt-4 md:pb-10 md:pt-6">
        {view.name === 'roster' && <Roster onOpen={(id) => openRecord(id, 'roster')} />}
        {view.name === 'inbox' && <Inbox onOpen={(id) => openRecord(id, 'inbox')} />}
        {view.name === 'settings' && <Settings />}
        {view.name === 'record' && (
          <ClientRecord clientId={view.id} onBack={() => setView(view.from === 'inbox' ? { name: 'inbox' } : { name: 'roster' })} />
        )}
      </main>

      {/* Bottom tab bar (base) */}
      <nav
        aria-label="Coach"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-strong bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="flex">
          {navItems.map((item) => (
            <li key={item.name} className="flex-1">
              <button
                aria-current={isActive(item.name) ? 'page' : undefined}
                onClick={() => setView({ name: item.name } as View)}
                className={`relative flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                  isActive(item.name) ? 'text-bright' : 'text-muted'
                }`}
              >
                {item.name === 'roster' ? '☰' : item.name === 'inbox' ? '⚑' : '⚙'}
                {item.label}
                {item.badge ? (
                  <span className="absolute right-[22%] top-1.5 rounded-full bg-warning px-1.5 py-px text-[10px] font-semibold text-app">
                    {item.badge}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Roster({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [clients, setClients] = useState<RosterClient[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    const q = new URLSearchParams({ status: tab, search, limit: '50' });
    api
      .get<{ clients: RosterClient[]; total: number }>(`/api/coach/roster?${q}`)
      .then((r) => {
        setClients(r.clients);
        setTotal(r.total);
      })
      .catch((e) => setError(e.message || 'Could not load your roster.'));
  }, [tab, search]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-[22px] font-semibold">Roster</h1>
        <GhostButton onClick={load}>Refresh</GhostButton>
      </div>
      <p className="mb-4 text-xs text-muted">
        {total} {tab} client{total === 1 ? '' : 's'}
      </p>

      <input
        aria-label="Search name or tag"
        className={`${inputClass} mb-3`}
        placeholder="Search name or tag"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Client status">
        {(['active', 'archived'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-[40px] rounded-full px-4 text-sm font-medium ${
              tab === t ? 'bg-bright/10 text-bright' : 'bg-raised text-secondary'
            }`}
          >
            {t === 'active' ? 'Active' : 'Archived'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3">
          <ErrorBanner message={`Couldn't load your roster. ${error}`} />
        </div>
      )}

      {clients === null ? (
        <SkeletonRows rows={5} />
      ) : clients.length === 0 ? (
        <Card>
          <EmptyState>
            {search
              ? `No clients match "${search}".`
              : tab === 'archived'
                ? 'No archived clients.'
                : 'No clients yet. Your roster builds itself — when someone buys a coaching product, their record appears here.'}
          </EmptyState>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {clients.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => onOpen(c.id)}
                className="flex min-h-[56px] w-full items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2 text-left"
              >
                <StatusDot status={c.membership_status} />
                <Avatar name={c.display_name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{c.display_name}</span>
                  <span className="block text-xs text-muted">
                    Week {c.program_week} · Started {formatDate(c.started_at)}
                    {c.membership_status === 'past_due' && <span className="text-warning"> · Past due</span>}
                    {c.deletion_requested && <span className="text-warning"> · Deletion requested</span>}
                  </span>
                </span>
                {c.open_flags > 0 && (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
                    ⚑ {c.open_flags}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-muted">
        Someone just joined? Records appear within a few seconds of purchase.
      </p>
    </div>
  );
}
