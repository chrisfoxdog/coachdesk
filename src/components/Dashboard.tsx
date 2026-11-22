import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { DashboardData } from '../types';
import { formatDate, formatDateTime } from '../types';
import { Avatar, Card, EmptyState, ErrorBanner, PrimaryButton, SecondaryButton, SectionTitle, SkeletonRows } from './ui';

export type DashboardNavTarget = 'roster' | 'inbox' | 'settings' | 'help';

/** The coach's home screen: headline counts and recent activity computed
 *  from the coach's own records via /api/coach/dashboard. Every number on
 *  this page is real data from that endpoint — nothing is sampled or
 *  estimated. */
export default function Dashboard({
  coachName,
  onOpenClient,
  onNavigate,
  onShowTour,
}: {
  coachName: string;
  onOpenClient: (id: string) => void;
  onNavigate: (view: DashboardNavTarget) => void;
  onShowTour: () => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<DashboardData>('/api/coach/dashboard')
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load your dashboard.'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div>
        <h1 className="mb-4 text-[22px] font-semibold">Dashboard</h1>
        <div className="mb-3">
          <ErrorBanner message={`Couldn't load your dashboard. ${error}`} />
        </div>
        <SecondaryButton onClick={load}>Try again</SecondaryButton>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <h1 className="mb-4 text-[22px] font-semibold">Dashboard</h1>
        <SkeletonRows rows={5} />
      </div>
    );
  }

  const c = data.counts;
  const noClientsYet = c.active_clients === 0 && c.archived_clients === 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-semibold">Dashboard</h1>
        <p className="text-xs text-muted">
          Welcome back, {coachName}. Everything below is counted from your own records.
        </p>
      </div>

      {noClientsYet && (
        <Card className="border-bright/30 bg-bright/5">
          <SectionTitle>Your roster builds itself</SectionTitle>
          <p className="max-w-lg text-sm leading-6 text-secondary">
            You have no client records yet — and you don't need to create any. The moment someone buys or joins one
            of your coaching products on Whop, their record appears here automatically, with an intake form ready
            for them. Take the two-minute walkthrough to see how the rest works.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryButton onClick={onShowTour}>Take the walkthrough</PrimaryButton>
            <SecondaryButton onClick={() => onNavigate('help')}>Read how it works</SecondaryButton>
          </div>
        </Card>
      )}

      {/* Headline counts */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active clients"
          value={c.active_clients}
          caption={
            c.new_clients_7d > 0
              ? `${c.new_clients_7d} joined in the last 7 days`
              : 'No new joins in the last 7 days'
          }
          onClick={() => onNavigate('roster')}
        />
        <StatCard
          label="Needs attention"
          value={c.open_flags}
          caption={c.open_flags > 0 ? 'Open flags in your Inbox' : 'All clear — nothing flagged'}
          accent={c.open_flags > 0}
          onClick={() => onNavigate('inbox')}
        />
        <StatCard
          label="Check-ins awaiting"
          value={c.checkins_awaiting}
          caption={`${c.checkins_submitted_7d} submitted in the last 7 days`}
          onClick={() => onNavigate('roster')}
        />
        <StatCard
          label="Check-ins missed"
          value={c.checkins_missed}
          caption={c.checkins_missed > 0 ? 'Missed check-ins show in the Inbox' : 'No missed check-ins'}
          accent={c.checkins_missed > 0}
          onClick={() => onNavigate('inbox')}
        />
      </div>

      <Card>
        <SectionTitle>This week</SectionTitle>
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-secondary">
          <span>
            <span className="font-semibold text-primary">{c.new_clients_7d}</span> new client
            {c.new_clients_7d === 1 ? '' : 's'}
          </span>
          <span>
            <span className="font-semibold text-primary">{c.sessions_logged_7d}</span> session
            {c.sessions_logged_7d === 1 ? '' : 's'} logged
          </span>
          <span>
            <span className="font-semibold text-primary">{c.checkins_submitted_7d}</span> check-in
            {c.checkins_submitted_7d === 1 ? '' : 's'} submitted
          </span>
          {c.archived_clients > 0 && (
            <span>
              <span className="font-semibold text-primary">{c.archived_clients}</span> archived record
              {c.archived_clients === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </Card>

      {/* Quick actions — the app's real actions only */}
      <div>
        <SectionTitle>Quick actions</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ActionCard
            title="View clients"
            body="Open your roster and any client's full record."
            cta="Go to Roster"
            onClick={() => onNavigate('roster')}
          />
          <ActionCard
            title="Log a session note"
            body="Pick a client on the roster, open their record, and tap Log session. Notes are only visible to you."
            cta="Choose a client"
            onClick={() => onNavigate('roster')}
          />
          <ActionCard
            title="Review check-ins"
            body="Missed check-ins and other flags collect in your Inbox; submitted answers sit on each client's record."
            cta="Open the Inbox"
            onClick={() => onNavigate('inbox')}
          />
          <ActionCard
            title="How to use CoachDesk"
            body="The five-step walkthrough: automatic records, notes, goals, check-ins, and the timeline."
            cta="Open the guide"
            onClick={() => onNavigate('help')}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Newest clients</SectionTitle>
          {data.recent_clients.length === 0 ? (
            <EmptyState>No active clients yet. Records appear within seconds of a purchase on Whop.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.recent_clients.map((cl) => (
                <li key={cl.id}>
                  <button
                    onClick={() => onOpenClient(cl.id)}
                    className="flex min-h-[52px] w-full items-center gap-3 rounded-[10px] border border-line bg-raised px-3 py-2 text-left"
                  >
                    <Avatar name={cl.display_name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">{cl.display_name}</span>
                      <span className="block text-xs text-muted">
                        Joined {formatDate(cl.started_at)} · Week {cl.program_week}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle>Recent activity</SectionTitle>
          {data.recent_activity.length === 0 ? (
            <EmptyState>Nothing yet — activity starts with the first client, session, or check-in.</EmptyState>
          ) : (
            <ol className="relative ml-2 flex flex-col gap-4 border-l-2 border-strong pl-5">
              {data.recent_activity.map((e) => (
                <li key={e.id} className="relative">
                  <span aria-hidden className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full bg-bright" />
                  <button onClick={() => onOpenClient(e.client_id)} className="text-left">
                    <span className="block text-sm text-secondary">{e.summary}</span>
                    <span className="block text-xs text-muted">
                      {e.client_name} · {formatDateTime(e.occurred_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  caption,
  accent = false,
  onClick,
}: {
  label: string;
  value: number;
  caption: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-[14px] border bg-surface p-4 text-left transition-colors hover:border-bright ${
        accent ? 'border-warning/50' : 'border-line'
      }`}
    >
      <span className="block text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className={`mt-1 block text-3xl font-semibold ${accent && value > 0 ? 'text-warning' : 'text-primary'}`}>
        {value}
      </span>
      <span className="mt-1 block text-xs text-muted">{caption}</span>
    </button>
  );
}

function ActionCard({
  title,
  body,
  cta,
  onClick,
}: {
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col rounded-[14px] border border-line bg-surface p-4 text-left transition-colors hover:border-bright"
    >
      <span className="text-[15px] font-semibold">{title}</span>
      <span className="mt-1 flex-1 text-sm leading-5 text-secondary">{body}</span>
      <span className="mt-3 text-sm font-medium text-bright">{cta} →</span>
    </button>
  );
}
