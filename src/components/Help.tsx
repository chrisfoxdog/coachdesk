import { useState } from 'react';
import { Card, GhostButton, PrimaryButton, SecondaryButton, SectionTitle } from './ui';

export type HelpNavTarget = 'roster' | 'inbox' | 'settings';

export interface HelpStep {
  title: string;
  body: string;
  action?: { label: string; view: HelpNavTarget };
}

/** The one source of truth for how CoachDesk works — used by both the
 *  first-run walkthrough and the permanent How to use page. Copy stays
 *  honest: records are automatic, notes are coach-only, and CoachDesk
 *  has no AI features — nothing here claims otherwise. */
export const HELP_STEPS: HelpStep[] = [
  {
    title: 'Clients appear on their own',
    body: 'When someone buys or joins one of your coaching products on Whop, CoachDesk creates their record automatically — their name, start date, and an intake form to answer. There is nothing to add by hand, and new records show up on your Roster within seconds of purchase.',
    action: { label: 'See the Roster', view: 'roster' },
  },
  {
    title: 'Open a client record',
    body: 'Your Roster lists every active client. Tap a name to open the full record: intake answers, goals, session notes, check-ins, and the complete history timeline — everything about that client in one place.',
    action: { label: 'Open the Roster', view: 'roster' },
  },
  {
    title: 'Log sessions, set goals',
    body: 'After a call, tap "Log session" on the client\'s record to save your notes and their wins. Session notes are only ever visible to you. Goals and action items are different: you choose per goal whether it is shared with the client or kept coach-only.',
    action: { label: 'Pick a client to try it', view: 'roster' },
  },
  {
    title: 'Check-ins run themselves',
    body: 'Set up a check-in template in Settings once, and every client gets a check-in to answer each week. Their answers land on their record, under Check-ins. You never have to chase anyone for the form itself — missed check-ins surface in your Inbox on their own.',
    action: { label: 'Open Settings', view: 'settings' },
  },
  {
    title: 'Watch the Inbox, read the timeline',
    body: 'The Inbox flags what needs attention — a missed check-in, an intake not answered after 48 hours, a goal with no update, a failed payment. Flags come from dates and statuses only, never from reading what anyone wrote. And each client\'s Timeline shows their whole story in order, so you are caught up before every session.',
    action: { label: 'Open the Inbox', view: 'inbox' },
  },
];

export function HelpView({
  onNavigate,
  onReplayTour,
}: {
  onNavigate: (view: HelpNavTarget) => void;
  onReplayTour: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-[22px] font-semibold">How to use CoachDesk</h1>
        <GhostButton onClick={onReplayTour}>Replay the walkthrough</GhostButton>
      </div>
      <p className="mb-4 text-xs text-muted">
        Five steps cover the whole app. CoachDesk is a record, not a robot: it never reads or processes what you or
        your clients write — flags and reminders come from dates and statuses only.
      </p>
      <div className="flex flex-col gap-3">
        {HELP_STEPS.map((step, i) => (
          <Card key={step.title}>
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bright/10 text-sm font-semibold text-bright"
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <SectionTitle>{step.title}</SectionTitle>
                <p className="text-sm leading-6 text-secondary">{step.body}</p>
                {step.action && (
                  <div className="mt-2">
                    <GhostButton onClick={() => onNavigate(step.action!.view)}>{step.action.label} →</GhostButton>
                  </div>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Card className="mt-3">
        <SectionTitle>Who sees what</SectionTitle>
        <ul className="flex flex-col gap-1.5 text-sm leading-6 text-secondary">
          <li>
            <span className="font-medium text-primary">Only you:</span> session notes, wins, tags, intake answers,
            check-in answers, and this Inbox. They are marked "Only you" wherever they appear.
          </li>
          <li>
            <span className="font-medium text-primary">Shared with the client:</span> only the goals and action
            items you mark Shared. Clients see those in their own client home — nothing else from their record.
          </li>
          <li>
            <span className="font-medium text-primary">In Whop:</span> memberships, payments, and access stay in
            Whop. CoachDesk reads membership status from Whop; it never changes it.
          </li>
        </ul>
      </Card>
    </div>
  );
}

/** First-run guided walkthrough. Dismissal is remembered per browser by the
 *  caller (localStorage seen-flag); it can always be replayed from
 *  How to use. */
export function Walkthrough({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (view: HelpNavTarget) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = HELP_STEPS[index];
  const isLast = index === HELP_STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-app/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to CoachDesk — a quick walkthrough"
    >
      <div className="max-h-[92vh] w-full max-w-[560px] overflow-y-auto rounded-t-[14px] bg-surface p-4 sm:rounded-[14px]">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {index === 0 ? 'Welcome to CoachDesk' : 'How CoachDesk works'} · Step {index + 1} of {HELP_STEPS.length}
          </p>
          <button aria-label="Skip the walkthrough" className="min-h-[40px] px-2 text-muted" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="mb-4 flex gap-1.5" aria-hidden>
          {HELP_STEPS.map((s, i) => (
            <span key={s.title} className={`h-1.5 flex-1 rounded-full ${i <= index ? 'bg-bright' : 'bg-raised'}`} />
          ))}
        </div>

        <h2 className="mb-2 text-lg font-semibold">{step.title}</h2>
        <p className="text-[15px] leading-6 text-secondary">{step.body}</p>

        {step.action && (
          <div className="mt-3">
            <GhostButton
              onClick={() => {
                onNavigate(step.action!.view);
                onClose();
              }}
            >
              {step.action.label} →
            </GhostButton>
          </div>
        )}

        <div className="sticky bottom-0 mt-5 flex items-center gap-2 bg-surface pb-[env(safe-area-inset-bottom)] pt-2">
          {index > 0 ? (
            <SecondaryButton onClick={() => setIndex(index - 1)}>Back</SecondaryButton>
          ) : (
            <SecondaryButton onClick={onClose}>Skip tour</SecondaryButton>
          )}
          {isLast ? (
            <PrimaryButton onClick={onClose}>Done — go to my Dashboard</PrimaryButton>
          ) : (
            <PrimaryButton onClick={() => setIndex(index + 1)}>Next</PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}
