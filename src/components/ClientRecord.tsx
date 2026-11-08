import { useCallback, useEffect, useState } from 'react';
import { api, downloadJson } from '../api';
import type { ActionItem, ClientEvent, Goal, SessionLog } from '../types';
import { formatDate, formatDateTime } from '../types';
import { AnswerList } from './FieldForm';
import {
  Avatar,
  Card,
  EmptyState,
  ErrorBanner,
  GhostButton,
  LockLabel,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SharedMarker,
  SkeletonRows,
  StatusBadge,
  inputClass,
  labelClass,
} from './ui';

interface RecordData {
  client: any;
  membership_links: any[];
  intake: { response: any; form: any }[];
  goals: Goal[];
  session_logs: SessionLog[];
  action_items: ActionItem[];
  checkins: any[];
  flags: any[];
  timeline: ClientEvent[];
}

export default function ClientRecord({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const [data, setData] = useState<RecordData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogSheet, setShowLogSheet] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<RecordData>(`/api/coach/clients/${clientId}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load this record.'));
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div>
        <BackRow onBack={onBack} />
        <ErrorBanner message={`Couldn't load this record. ${error}`} />
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <BackRow onBack={onBack} />
        <SkeletonRows rows={6} />
      </div>
    );
  }

  const c = data.client;
  const primaryLink = data.membership_links[0];
  const memberStatus = primaryLink?.status || (c.status === 'archived' ? 'ended' : 'active');
  const archived = c.status === 'archived';

  return (
    <div className="flex flex-col gap-4">
      <BackRow onBack={onBack} />
      {notice && <div className="rounded-[10px] border-l-[3px] border-success bg-success/10 px-3 py-2 text-sm">{notice}</div>}

      {/* Header (§6.1) */}
      <header className="rounded-[14px] border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <Avatar name={c.display_name} size={40} />
          <div className="min-w-0 flex-1">
            <h1 className={`text-xl font-semibold ${archived ? 'text-secondary' : ''}`}>{c.display_name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge status={archived ? 'archived' : memberStatus} />
              {c.email && <span className="text-sm text-secondary">{c.email}</span>}
            </div>
            <p className="mt-1 text-xs text-muted">
              Started {formatDate(c.started_at)} · Week {c.program_week}
              {primaryLink?.whop_membership_id && (
                <span className="font-mono"> · {primaryLink.whop_membership_id}</span>
              )}
            </p>
          </div>
        </div>
        {memberStatus === 'past_due' && !archived && (
          <p className="mt-3 rounded-[10px] border border-warning/50 px-3 py-2 text-sm">
            Payment failed — Whop is retrying. Access status is Whop's call.
          </p>
        )}
        {archived && (
          <p className="mt-3 rounded-[10px] border border-strong px-3 py-2 text-sm text-secondary">
            Archived {formatDate(c.archived_at)} — read-only. History is kept per your retention setting.
          </p>
        )}
        {c.deletion_requested_at && (
          <p className="mt-3 rounded-[10px] border border-warning/50 px-3 py-2 text-sm">
            This client asked for their CoachDesk record to be deleted. Deleting removes the record's content for
            good — it does not delete anything in Whop. Use "Delete this record" below when you're ready.
          </p>
        )}
        <TagsEditor client={c} onSaved={load} />
        {!archived && (
          <div className="mt-3">
            <PrimaryButton onClick={() => setShowLogSheet(true)}>Log session</PrimaryButton>
          </div>
        )}
      </header>

      {/* ---------- SHARED ZONE (always above coach-only, §6.2) ---------- */}
      <div className="rounded-[14px] border border-bright/30 bg-bright/5 p-3">
        <p className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-bright">Shared with client</p>
        <div className="flex flex-col gap-4">
          <GoalsSection clientId={clientId} goals={data.goals} onChanged={load} archived={archived} />
          <ActionItemsSection clientId={clientId} items={data.action_items} onChanged={load} archived={archived} />
        </div>
      </div>

      {/* ---------- COACH-ONLY ZONE ---------- */}
      <div className="flex flex-col gap-4">
        <Card>
          <SectionTitle marker={<LockLabel />}>Intake</SectionTitle>
          {data.intake.length === 0 ? (
            <EmptyState>No intake form is attached to this client's product yet. Build one in Settings.</EmptyState>
          ) : (
            data.intake.map(({ response, form }) => (
              <div key={response.id} className="mb-3 last:mb-0">
                <p className="mb-1 text-sm font-medium">
                  {form?.title || 'Intake'} ·{' '}
                  <span className={response.status === 'submitted' ? 'text-success' : 'text-muted'}>
                    {response.status === 'submitted' ? `Submitted ${formatDateTime(response.submitted_at)}` : 'Not answered yet'}
                  </span>
                </p>
                {response.status === 'submitted' && form ? (
                  <AnswerList fields={form.fields} answers={response.answers} />
                ) : (
                  <p className="text-sm text-muted">It was sent when {c.display_name.split(' ')[0]} joined.</p>
                )}
              </div>
            ))
          )}
        </Card>

        <Card>
          <SectionTitle marker={<LockLabel />}>Session notes</SectionTitle>
          {data.session_logs.length === 0 ? (
            <EmptyState
              action={!archived ? <PrimaryButton onClick={() => setShowLogSheet(true)}>Log a session</PrimaryButton> : undefined}
            >
              No sessions logged yet.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.session_logs.map((log) => (
                <li key={log.id} className="rounded-[10px] border border-strong bg-raised p-3">
                  <p className="mb-1 text-xs text-muted">{formatDateTime(log.session_at)}</p>
                  {log.notes && <p className="whitespace-pre-wrap text-[15px] leading-6">{log.notes}</p>}
                  {log.wins && (
                    <p className="mt-2 text-sm text-secondary">
                      <span className="font-medium text-primary">Wins: </span>
                      {log.wins}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle marker={<LockLabel />}>Check-ins</SectionTitle>
          {data.checkins.length === 0 ? (
            <EmptyState>No check-ins yet. Set up a template in Settings and check-ins start each week.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.checkins.slice(0, 8).map((ci) => (
                <li key={ci.id} className="rounded-[10px] border border-strong bg-raised p-3">
                  <p className="mb-1 text-sm font-medium">
                    Week of {formatDate(ci.period_start)} ·{' '}
                    <span
                      className={
                        ci.status === 'submitted' ? 'text-success' : ci.status === 'missed' ? 'text-warning' : 'text-muted'
                      }
                    >
                      {ci.status === 'submitted' ? `Submitted ${formatDateTime(ci.submitted_at)}` : ci.status}
                    </span>
                  </p>
                  {ci.status === 'submitted' && ci.template && (
                    <AnswerList fields={ci.template.questions} answers={ci.answers} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle>Timeline</SectionTitle>
          {data.timeline.length === 0 ? (
            <EmptyState>Nothing here yet — history starts with the first session or check-in.</EmptyState>
          ) : (
            <ol className="relative ml-2 flex flex-col gap-4 border-l-2 border-strong pl-5">
              {data.timeline.map((e, i) => (
                <li key={e.id || i} className="relative">
                  <span aria-hidden className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full bg-bright" />
                  <p className="text-sm text-secondary">{e.summary}</p>
                  <p className="text-xs text-muted">
                    {formatDateTime(e.occurred_at)}
                    {e.visibility === 'shared' ? ' · Shared' : ' · Only you'}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card>
          <SectionTitle>Record actions</SectionTitle>
          <div className="flex flex-col gap-2">
            <SecondaryButton
              onClick={() =>
                downloadJson(`/api/coach/clients/${clientId}/export`, `coachdesk-client-${clientId}.json`).catch(
                  () => setError('Export failed. Try again.')
                )
              }
            >
              Export this record (JSON)
            </SecondaryButton>
            {!confirmDelete ? (
              <GhostButton danger onClick={() => setConfirmDelete(true)}>
                Delete this record
              </GhostButton>
            ) : (
              <div className="rounded-[10px] border border-danger/50 p-3">
                <p className="mb-2 text-sm">
                  This permanently deletes this record's content — notes, answers, goals, check-ins. It cannot be
                  undone. It does not delete anything in Whop (the client's Whop account and payments stay in Whop).
                </p>
                <div className="flex gap-2">
                  <button
                    className="min-h-[44px] rounded-[10px] bg-danger-fill px-4 text-sm font-semibold text-white"
                    onClick={async () => {
                      await api.post(`/api/coach/clients/${clientId}/delete`, { confirm: true });
                      setNotice('Record deleted.');
                      onBack();
                    }}
                  >
                    Delete this record
                  </button>
                  <SecondaryButton onClick={() => setConfirmDelete(false)}>Keep record</SecondaryButton>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {showLogSheet && (
        <SessionLogSheet
          clientId={clientId}
          clientName={c.display_name}
          onClose={() => setShowLogSheet(false)}
          onSaved={() => {
            setShowLogSheet(false);
            setNotice('Session logged');
            load();
          }}
        />
      )}
    </div>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="min-h-[40px] text-sm font-medium text-bright">
      ← Back
    </button>
  );
}

function TagsEditor({ client, onSaved }: { client: any; onSaved: () => void }) {
  const [draft, setDraft] = useState('');
  const tags: string[] = client.tags || [];
  const save = async (next: string[]) => {
    await api.patch(`/api/coach/clients/${client.id}`, { tags: next });
    onSaved();
  };
  return (
    <div className="mt-3">
      <p className={labelClass}>Tags · Only you</p>
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-raised px-2.5 py-1 text-xs text-secondary">
            {t}
            <button aria-label={`Remove tag ${t}`} className="text-muted" onClick={() => save(tags.filter((x) => x !== t))}>
              ✕
            </button>
          </span>
        ))}
        <input
          aria-label="Add a tag"
          className="w-28 rounded-full border border-strong bg-raised px-2.5 py-1 text-xs"
          placeholder="+ tag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              save([...tags, draft.trim()]);
              setDraft('');
            }
          }}
        />
      </div>
    </div>
  );
}

function GoalsSection({
  clientId,
  goals,
  onChanged,
  archived,
}: {
  clientId: string;
  goals: Goal[];
  onChanged: () => void;
  archived: boolean;
}) {
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [visibility, setVisibility] = useState<'shared' | 'coach_only'>('shared');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const add = async () => {
    if (!title.trim()) return;
    await api.post(`/api/coach/clients/${clientId}/goals`, { title, target, visibility });
    setTitle('');
    setTarget('');
    onChanged();
  };

  return (
    <Card>
      <SectionTitle marker={<SharedMarker compact />}>Goals</SectionTitle>
      {goals.length === 0 ? (
        <EmptyState>No goals yet. Add the first one below.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {goals.map((g) => (
            <li key={g.id} className="rounded-[10px] border border-strong bg-raised p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[15px] font-semibold">{g.title}</p>
                {g.visibility === 'shared' ? <SharedMarker compact /> : <span className="text-xs text-muted">Only you</span>}
                <span className="ml-auto text-xs text-muted">{g.status}</span>
              </div>
              {g.target && <p className="mt-0.5 text-sm text-secondary">Target: {g.target}</p>}
              {g.description && <p className="mt-0.5 text-sm text-secondary">{g.description}</p>}
              <label className={`${labelClass} mt-2`}>Progress note{g.visibility === 'shared' ? ' (shared)' : ''}</label>
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  defaultValue={g.progress_note}
                  value={notes[g.id] ?? undefined}
                  onChange={(e) => setNotes((n) => ({ ...n, [g.id]: e.target.value }))}
                  placeholder="Latest progress…"
                />
                <SecondaryButton
                  onClick={async () => {
                    await api.patch(`/api/coach/goals/${g.id}`, { progress_note: notes[g.id] ?? g.progress_note });
                    onChanged();
                  }}
                >
                  Save
                </SecondaryButton>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <GhostButton
                  onClick={async () => {
                    await api.patch(`/api/coach/goals/${g.id}`, {
                      visibility: g.visibility === 'shared' ? 'coach_only' : 'shared',
                    });
                    onChanged();
                  }}
                >
                  {g.visibility === 'shared' ? 'Make coach-only' : 'Share with client'}
                </GhostButton>
                {g.status === 'active' && (
                  <GhostButton
                    onClick={async () => {
                      await api.patch(`/api/coach/goals/${g.id}`, { status: 'achieved' });
                      onChanged();
                    }}
                  >
                    Mark achieved
                  </GhostButton>
                )}
                {g.status !== 'archived' && (
                  <GhostButton
                    onClick={async () => {
                      await api.patch(`/api/coach/goals/${g.id}`, { status: 'archived' });
                      onChanged();
                    }}
                  >
                    Archive
                  </GhostButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!archived && (
        <div className="mt-3 flex flex-col gap-2">
          <input className={inputClass} placeholder="New goal title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New goal title" />
          <input className={inputClass} placeholder="Target (optional, free text)" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Goal target" />
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={visibility === 'shared'}
              onChange={(e) => setVisibility(e.target.checked ? 'shared' : 'coach_only')}
              className="h-4 w-4 accent-[#2563eb]"
            />
            Shared with client (visible in their client home)
          </label>
          <PrimaryButton onClick={add} disabled={!title.trim()}>
            Add goal
          </PrimaryButton>
        </div>
      )}
    </Card>
  );
}

function ActionItemsSection({
  clientId,
  items,
  onChanged,
  archived,
}: {
  clientId: string;
  items: ActionItem[];
  onChanged: () => void;
  archived: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <Card>
      <SectionTitle marker={<SharedMarker compact />}>Action items</SectionTitle>
      {items.length === 0 ? (
        <EmptyState>No action items yet.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex min-h-[44px] items-center gap-3 rounded-[10px] border border-strong bg-raised px-3 py-2">
              <input
                type="checkbox"
                aria-label={`Mark done: ${item.text}`}
                checked={Boolean(item.done_at)}
                onChange={async (e) => {
                  await api.patch(`/api/coach/action-items/${item.id}`, { done: e.target.checked });
                  onChanged();
                }}
                className="h-5 w-5 accent-[#2563eb]"
              />
              <span className={`flex-1 text-sm ${item.done_at ? 'text-muted line-through' : ''}`}>{item.text}</span>
              {item.due_date && <span className="text-xs text-muted">Due {formatDate(item.due_date)}</span>}
              <button
                aria-label={`Delete action item: ${item.text}`}
                className="text-danger"
                onClick={async () => {
                  await api.del(`/api/coach/action-items/${item.id}`);
                  onChanged();
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {!archived && (
        <div className="mt-3 flex gap-2">
          <input
            className={inputClass}
            placeholder="New action item — the client sees this in their home"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="New action item"
          />
          <PrimaryButton
            disabled={!text.trim()}
            onClick={async () => {
              await api.post(`/api/coach/clients/${clientId}/action-items`, { text });
              setText('');
              onChanged();
            }}
          >
            Add
          </PrimaryButton>
        </div>
      )}
    </Card>
  );
}

/** The sixty-second session log (layout §5.3): three blocks, nothing else. */
function SessionLogSheet({
  clientId,
  clientName,
  onClose,
  onSaved,
}: {
  clientId: string;
  clientName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [wins, setWins] = useState('');
  const [items, setItems] = useState<{ text: string; due_date: string }[]>([]);
  const [when, setWhen] = useState<'now' | 'earlier' | 'yesterday'>('now');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const sessionAt = new Date();
    if (when === 'earlier') sessionAt.setHours(sessionAt.getHours() - 3);
    if (when === 'yesterday') sessionAt.setDate(sessionAt.getDate() - 1);
    try {
      await api.post(`/api/coach/clients/${clientId}/session-logs`, {
        notes,
        wins,
        session_at: sessionAt.toISOString(),
        action_items: items.filter((i) => i.text.trim()),
      });
      onSaved();
    } catch (e: any) {
      // The draft stays in state — losing a note is this app's worst failure.
      setError(e.message || "Couldn't save. Your text is still here — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-app/70 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Log session — ${clientName}`}>
      <div className="max-h-[92vh] w-full max-w-[560px] overflow-y-auto rounded-t-[14px] bg-surface p-4 sm:rounded-[14px]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Log session — {clientName}</h2>
          <button aria-label="Close" className="min-h-[40px] px-2 text-muted" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && (
          <div className="mb-3">
            <ErrorBanner message={error} />
          </div>
        )}
        <div className="mb-3 flex gap-2" role="group" aria-label="When was the session">
          {(
            [
              ['now', 'Today'],
              ['earlier', 'Earlier today'],
              ['yesterday', 'Yesterday'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setWhen(v)}
              aria-pressed={when === v}
              className={`min-h-[40px] rounded-full px-3 text-sm ${when === v ? 'bg-bright/10 text-bright' : 'bg-raised text-secondary'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className={labelClass} htmlFor="sl-notes">Notes · Only you</label>
        <textarea
          id="sl-notes"
          autoFocus
          className={`${inputClass} min-h-[110px] text-[15px] leading-6`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What happened, what matters, what to remember…"
        />
        <label className={`${labelClass} mt-3`} htmlFor="sl-wins">Wins (optional) · Only you</label>
        <input id="sl-wins" className={inputClass} value={wins} onChange={(e) => setWins(e.target.value)} />
        <label className={`${labelClass} mt-3`}>Action items for {clientName.split(' ')[0]}</label>
        <p className="mb-2 text-[13px] text-muted">{clientName.split(' ')[0]} sees these in their client home.</p>
        <div className="flex flex-col gap-2">
          {items.map((item, i) => (
            <div key={i} className="flex gap-2">
              <input
                className={inputClass}
                placeholder="Action item"
                value={item.text}
                aria-label={`Action item ${i + 1}`}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              />
              <input
                type="date"
                aria-label={`Action item ${i + 1} due date`}
                className="w-36 rounded-[10px] border border-strong bg-raised px-2 text-sm"
                value={item.due_date}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))}
              />
            </div>
          ))}
          <button
            className="min-h-[40px] text-left text-sm font-medium text-bright"
            onClick={() => setItems([...items, { text: '', due_date: '' }])}
          >
            + Add item
          </button>
        </div>
        <div className="sticky bottom-0 mt-4 bg-surface pb-[env(safe-area-inset-bottom)] pt-2">
          <PrimaryButton onClick={save} disabled={saving || (!notes.trim() && !wins.trim())}>
            {saving ? 'Saving…' : 'Save session log'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
