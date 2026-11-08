// Shared constants for CoachDesk. No secrets, no pricing, no AI configuration
// exists anywhere in this codebase — by design (privacy model hard rules).

/**
 * The default intake consent template (privacy model §8.4). It ships with the
 * product: a coach may edit the wording of their form's consent text but the
 * consent block itself cannot be removed from a form.
 */
export const DEFAULT_CONSENT_TEXT = [
  'What is collected: your answers to the questions on this form.',
  'Who sees it: only your coach sees your private answers. You can review your own answers any time in your client home.',
  'What you will see in your client home: the goals your coach shares with you, your action items, your check-ins, and your own answers.',
  'How it is processed: your answers are stored as you wrote them. They are never processed by AI.',
  'Your choices: you can ask your coach for a copy of your record (export) or ask for your CoachDesk record to be deleted, from your client home or by email.',
  'Please do not enter medical details — CoachDesk is a coaching record, not a medical record.',
].join('\n');

/** Membership link statuses that keep a client record active. */
export const LIVE_LINK_STATUSES = ['active', 'trialing', 'past_due'] as const;

export const MEMBERSHIP_STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'ended'] as const;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Program week: 1-based weeks since the client first started. */
export function programWeek(startedAt: string | undefined, now = new Date()): number {
  if (!startedAt) return 1;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return 1;
  const weeks = Math.floor((now.getTime() - start) / (7 * 24 * 60 * 60 * 1000));
  return Math.max(1, weeks + 1);
}

/** Start (Monday 00:00 UTC) of the current weekly check-in period. */
export function currentPeriodStart(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** End of the weekly period: the following Sunday 23:59:59 UTC. */
export function periodDueAt(periodStart: Date): Date {
  const due = new Date(periodStart);
  due.setUTCDate(due.getUTCDate() + 6);
  due.setUTCHours(23, 59, 59, 999);
  return due;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}
