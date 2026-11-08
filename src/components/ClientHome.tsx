import { useCallback, useEffect, useState } from 'react';
import { api, downloadJson, ApiError } from '../api';
import type { FormField } from '../types';
import { formatDate, formatDateTime } from '../types';
import { AnswerList, FieldAnswers } from './FieldForm';
import {
  Card,
  EmptyState,
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SharedMarker,
  SkeletonRows,
} from './ui';

/**
 * The client home (privacy model §2). A SEPARATE component family from the
 * coach record — fed only by /api/me/home, which never queries session logs,
 * wins, tags or flags. Nothing coach-only exists in this file's data.
 */
interface HomeData {
  client: { display_name: string; status: string; started_at: string; program_week: number; deletion_requested: boolean };
  coach: { display_name: string };
  goals: { id: string; title: string; description: string; target: string; status: string; progress_note: string; progress_updated_at: string }[];
  action_items: { id: string; text: string; due_date: string | null; done_at: string | null }[];
  intake: { response_id: string; title: string; fields: FormField[]; consent_text: string } | null;
  submitted_intake: { form_title: string; form_fields: FormField[]; answers: Record<string, unknown>; submitted_at: string }[];
  checkin: { checkin_id: string; period_start: string; due_at: string; questions: FormField[] } | null;
  past_checkins: { period_start: string; submitted_at: string; answers: Record<string, unknown>; questions: FormField[] }[];
  timeline: { type: string; summary: string; occurred_at: string }[];
}

export default function ClientHome() {
  const [home, setHome] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const load = useCallback(() => {
    api
      .get<HomeData>('/api/me/home')
      .then(setHome)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'MEMBERSHIP_ENDED') setEnded(true);
        else setError(e.message || 'Could not load your home.');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (ended) {
    return (
      <main className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col justify-center gap-3 px-4 py-10">
        <h1 className="text-[22px] font-semibold">Membership ended</h1>
        <p className="text-sm text-secondary">
          Your coaching membership has ended, so this page is closed. To request a copy of your record, email your
          coach.
        </p>
      </main>
    );
  }

  if (!home) {
    return (
      <main className="mx-auto w-full max-w-[640px] px-4 py-6">
        <h1 className="mb-4 text-[22px] font-semibold">Your coaching home</h1>
        {error ? <ErrorBanner message={error} /> : <SkeletonRows rows={5} />}
      </main>
    );
  }

  const firstName = home.client.display_name.split(' ')[0];

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 py-5">
      <header>
        <h1 className="text-[22px] font-semibold">{firstName}'s coaching home</h1>
        <p className="text-xs text-muted">
          Week {home.client.program_week} · with {home.coach.display_name} · Started {formatDate(home.client.started_at)}
        </p>
      </header>
      {error && <ErrorBanner message={error} />}

      {/* Check-in — what they owe comes first (layout §5.6) */}
      {home.checkin ? (
        <CheckinCard checkin={home.checkin} onSubmitted={load} />
      ) : (
        home.past_checkins.length > 0 && (
          <Card>
            <SectionTitle>Check-in</SectionTitle>
            <p className="text-sm text-secondary">
              Last submitted {formatDateTime(home.past_checkins[0].submitted_at)}. Your next check-in opens with the
              new week.
            </p>
          </Card>
        )
      )}

      {/* Intake waiting */}
      {home.intake && <IntakeCard intake={home.intake} onSubmitted={load} />}

      <Card>
        <SectionTitle marker={<SharedMarker compact />}>Your action items</SectionTitle>
        {home.action_items.length === 0 ? (
          <EmptyState>Nothing here yet — action items from your sessions will land here.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {home.action_items.map((item) => (
              <ActionRow key={item.id} item={item} onChanged={load} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionTitle marker={<SharedMarker compact />}>Your goals</SectionTitle>
        {home.goals.length === 0 ? (
          <EmptyState>Your coach hasn't shared any goals yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {home.goals.map((g) => (
              <li key={g.id} className="rounded-[10px] border border-strong bg-raised p-3">
                <div className="flex items-center gap-2">
                  <p className="text-[15px] font-semibold">{g.title}</p>
                  {g.status === 'achieved' && <span className="text-xs font-semibold text-success">Achieved</span>}
                </div>
                {g.target && <p className="mt-0.5 text-sm text-secondary">Target: {g.target}</p>}
                {g.description && <p className="mt-0.5 text-sm text-secondary">{g.description}</p>}
                {g.progress_note && (
                  <p className="mt-1 text-sm text-secondary">
                    <span className="text-primary">Progress: </span>
                    {g.progress_note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(home.submitted_intake.length > 0 || home.past_checkins.length > 0) && (
        <Card>
          <SectionTitle>Your answers</SectionTitle>
          <div className="flex flex-col gap-4">
            {home.submitted_intake.map((s, i) => (
              <div key={i}>
                <p className="mb-1 text-sm font-medium">
                  {s.form_title} · Submitted {formatDate(s.submitted_at)}
                </p>
                <AnswerList fields={s.form_fields} answers={s.answers} />
              </div>
            ))}
            {home.past_checkins.map((c, i) => (
              <div key={i}>
                <p className="mb-1 text-sm font-medium">
                  Check-in · Week of {formatDate(c.period_start)}
                </p>
                <AnswerList fields={c.questions} answers={c.answers} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {home.timeline.length > 0 && (
        <Card>
          <SectionTitle>History</SectionTitle>
          <ol className="relative ml-2 flex flex-col gap-4 border-l-2 border-strong pl-5">
            {home.timeline.map((e, i) => (
              <li key={i} className="relative">
                <span aria-hidden className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full bg-bright" />
                <p className="text-sm text-secondary">{e.summary}</p>
                <p className="text-xs text-muted">{formatDateTime(e.occurred_at)}</p>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <RecordRequests deletionRequested={home.client.deletion_requested} onChanged={load} />
    </main>
  );
}

function ActionRow({
  item,
  onChanged,
}: {
  item: { id: string; text: string; due_date: string | null; done_at: string | null };
  onChanged: () => void;
}) {
  const [done, setDone] = useState(Boolean(item.done_at));
  const overdue = !item.done_at && item.due_date && new Date(item.due_date).getTime() < Date.now();
  const toggle = async (checked: boolean) => {
    setDone(checked); // optimistic — checkbox-class action (design §8.2)
    try {
      await api.post(`/api/me/action-items/${item.id}/done`, { done: checked });
      onChanged();
    } catch {
      setDone(!checked);
    }
  };
  return (
    <li className="flex min-h-[44px] items-center gap-3 rounded-[10px] border border-strong bg-raised px-3 py-2">
      <input
        type="checkbox"
        aria-label={`Mark done: ${item.text}`}
        checked={done}
        onChange={(e) => toggle(e.target.checked)}
        className="h-5 w-5 accent-[#2563eb]"
      />
      <span className={`flex-1 text-sm ${done ? 'text-muted line-through' : ''}`}>{item.text}</span>
      {item.due_date && (
        <span className={`text-xs ${overdue ? 'text-warning' : 'text-muted'}`}>
          {overdue ? 'Overdue · ' : ''}Due {formatDate(item.due_date)}
        </span>
      )}
    </li>
  );
}

function IntakeCard({
  intake,
  onSubmitted,
}: {
  intake: NonNullable<HomeData['intake']>;
  onSubmitted: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/me/intake/${intake.response_id}/submit`, { answers });
      onSubmitted();
    } catch (e: any) {
      setError(e.message || 'Could not submit. Your answers are still here — try again.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <SectionTitle>{intake.title}</SectionTitle>
      <p className="mb-3 text-[13px] text-muted">
        Question {Object.keys(answers).length > 0 ? 'in progress' : '1'} of {intake.fields.length} — your coach is
        waiting on this one.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      <FieldAnswers fields={intake.fields} values={answers} onChange={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))} />
      <div className="mt-4 rounded-[10px] border border-strong bg-raised p-3">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Before you answer</p>
        <p className="whitespace-pre-wrap text-[13px] text-secondary">{intake.consent_text}</p>
      </div>
      <div className="mt-3">
        <PrimaryButton onClick={submit} disabled={saving}>
          {saving ? 'Submitting…' : 'Submit intake'}
        </PrimaryButton>
      </div>
    </Card>
  );
}

function CheckinCard({
  checkin,
  onSubmitted,
}: {
  checkin: NonNullable<HomeData['checkin']>;
  onSubmitted: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/me/checkins/${checkin.checkin_id}/submit`, { answers });
      onSubmitted();
    } catch (e: any) {
      setError(e.message || 'Could not submit. Your answers are still here — try again.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <SectionTitle marker={<SharedMarker compact />}>Check-in — due {formatDate(checkin.due_at)}</SectionTitle>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      <FieldAnswers fields={checkin.questions} values={answers} onChange={(id, v) => setAnswers((a) => ({ ...a, [id]: v }))} />
      <div className="mt-3">
        <PrimaryButton onClick={submit} disabled={saving}>
          {saving ? 'Submitting…' : 'Submit check-in'}
        </PrimaryButton>
      </div>
    </Card>
  );
}

function RecordRequests({
  deletionRequested,
  onChanged,
}: {
  deletionRequested: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <SectionTitle>Your record</SectionTitle>
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <SecondaryButton
          onClick={() =>
            downloadJson('/api/me/export', 'coachdesk-my-record.json').catch(() => setError('Export failed. Try again.'))
          }
        >
          Export my record
        </SecondaryButton>
        {deletionRequested ? (
          <p className="text-sm text-secondary">
            You've asked your coach to delete your CoachDesk record. They'll confirm it in the app; content is
            deleted within 30 days.
          </p>
        ) : !confirming ? (
          <SecondaryButton onClick={() => setConfirming(true)}>Ask my coach to delete my record</SecondaryButton>
        ) : (
          <div className="rounded-[10px] border border-strong p-3">
            <p className="mb-2 text-sm text-secondary">
              This asks your coach to delete what CoachDesk holds about you: your answers, shared goals and action
              items on your record. It does not delete your Whop account, membership or payments — those live in
              Whop, not CoachDesk.
            </p>
            <div className="flex gap-2">
              <button
                className="min-h-[44px] rounded-[10px] bg-danger-fill px-4 text-sm font-semibold text-white"
                onClick={async () => {
                  try {
                    await api.post('/api/me/request-deletion');
                    setConfirming(false);
                    onChanged();
                  } catch (e: any) {
                    setError(e.message || 'Request failed. Try again.');
                  }
                }}
              >
                Ask my coach to delete it
              </button>
              <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
