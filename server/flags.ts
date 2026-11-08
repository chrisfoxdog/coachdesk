import {
  newId,
  type IDatabase,
  type Coach,
  type Client,
  type Checkin,
  type CheckinTemplate,
  type Goal,
  type IntakeResponse,
  type MembershipLink,
  type NeedsAttentionFlag,
} from './db.js';
import { currentPeriodStart, periodDueAt, nowIso, daysBetween, programWeek } from './constants.js';

/**
 * The needs-attention engine. Flags are DERIVED STATE: computed from counts,
 * dates and statuses only — never from reading note or answer content
 * (privacy model §3). They can be regenerated at any time; they are not
 * source data. Runs on every roster / inbox / record / home read.
 */

const INTAKE_GRACE_HOURS = 48;

function applicableTemplate(
  templates: CheckinTemplate[],
  coachId: string,
  productId: string | undefined
): CheckinTemplate | undefined {
  const active = templates.filter((t) => t.coach_id === coachId && t.is_active);
  return (
    active.find((t) => productId && t.whop_product_id === productId) ||
    active.find((t) => !t.whop_product_id) ||
    undefined
  );
}

async function openFlag(
  database: IDatabase,
  coach: Coach,
  client: Client,
  type: NeedsAttentionFlag['type'],
  severity: NeedsAttentionFlag['severity'],
  dedupeKey: string,
  detail: string,
  existing: NeedsAttentionFlag[]
): Promise<void> {
  if (existing.some((f) => f.dedupe_key === dedupeKey && f.status !== 'resolved')) return;
  // A previously resolved flag with the same key may re-open as a fresh row
  // only when its period changed — the dedupe key carries the period, so a
  // matching open/dismissed row is enough to stay quiet.
  if (existing.some((f) => f.dedupe_key === dedupeKey)) return;
  const now = nowIso();
  await database.insert('needs_attention_flags', {
    id: newId('flag'),
    coach_id: coach.id,
    client_id: client.id,
    type,
    severity,
    status: 'open',
    dedupe_key: dedupeKey,
    detail,
    created_at: now,
    updated_at: now,
  });
}

async function resolveFlags(
  database: IDatabase,
  clientId: string,
  type: NeedsAttentionFlag['type'],
  flags: NeedsAttentionFlag[]
): Promise<void> {
  const now = nowIso();
  for (const f of flags.filter((x) => x.client_id === clientId && x.type === type && x.status === 'open')) {
    await database.update('needs_attention_flags', f.id, { status: 'resolved', resolved_at: now });
  }
}

export async function deriveCoachState(database: IDatabase, coach: Coach): Promise<void> {
  const now = new Date();
  const nowS = now.toISOString();

  const [clients, links, responses, templates, checkins, goals, flags] = await Promise.all([
    database.getAll<Client>('clients'),
    database.getAll<MembershipLink>('membership_links'),
    database.getAll<IntakeResponse>('intake_responses'),
    database.getAll<CheckinTemplate>('checkin_templates'),
    database.getAll<Checkin>('checkins'),
    database.getAll<Goal>('goals'),
    database.getAll<NeedsAttentionFlag>('needs_attention_flags'),
  ]);

  const myFlags = flags.filter((f) => f.coach_id === coach.id);
  const periodStart = currentPeriodStart(now);
  const periodStartS = periodStart.toISOString();
  const dueS = periodDueAt(periodStart).toISOString();

  for (const client of clients.filter((c) => c.coach_id === coach.id)) {
    // Keep the cached program week honest.
    const pw = programWeek(client.started_at, now);
    if (client.program_week !== pw && client.status === 'active') {
      await database.update('clients', client.id, { program_week: pw });
      client.program_week = pw;
    }
    if (client.status !== 'active') continue;

    const clientLinks = links.filter((l) => l.client_id === client.id);
    const primaryLink = clientLinks.find((l) => l.whop_membership_id === client.whop_membership_id) || clientLinks[0];

    // --- membership_past_due (also opened inline by payment.failed) ---
    const pastDueLink = clientLinks.find((l) => l.status === 'past_due');
    if (pastDueLink) {
      await openFlag(
        database, coach, client, 'membership_past_due', 'urgent',
        `${client.id}:membership_past_due:${pastDueLink.id}`,
        'Payment failed — Whop is retrying',
        myFlags
      );
    } else {
      await resolveFlags(database, client.id, 'membership_past_due', myFlags);
    }

    // --- intake_missing (after the 48h grace) ---
    const pendingIntake = responses.find((r) => r.client_id === client.id && r.status === 'pending');
    if (pendingIntake) {
      const ageHours = (now.getTime() - new Date(pendingIntake.created_at).getTime()) / 3600000;
      if (ageHours >= INTAKE_GRACE_HOURS) {
        await openFlag(
          database, coach, client, 'intake_missing', 'attention',
          `${client.id}:intake_missing:${pendingIntake.id}`,
          `Intake not answered yet (${Math.floor(ageHours / 24)}d since it was sent)`,
          myFlags
        );
      }
    } else {
      await resolveFlags(database, client.id, 'intake_missing', myFlags);
    }

    // --- check-in lifecycle: ensure current period, mark missed ---
    const template = applicableTemplate(templates, coach.id, primaryLink?.whop_product_id);
    if (template) {
      let current = checkins.find(
        (c) => c.client_id === client.id && c.template_id === template.id && c.period_start === periodStartS
      );
      if (!current) {
        const created: Checkin = {
          id: newId('checkin'),
          coach_id: coach.id,
          client_id: client.id,
          template_id: template.id,
          period_start: periodStartS,
          due_at: dueS,
          answers: {},
          status: 'pending',
          created_at: nowS,
          updated_at: nowS,
        };
        await database.insert('checkins', created);
        checkins.push(created);
        current = created;
      }
    }
    for (const c of checkins.filter((x) => x.client_id === client.id && x.status === 'pending')) {
      if (new Date(c.due_at).getTime() < now.getTime()) {
        await database.update('checkins', c.id, { status: 'missed' });
        c.status = 'missed';
      }
    }
    const clientCheckins = checkins
      .filter((x) => x.client_id === client.id)
      .sort((a, b) => b.period_start.localeCompare(a.period_start));
    let consecutiveMissed = 0;
    for (const c of clientCheckins) {
      if (c.status === 'missed') consecutiveMissed++;
      else if (c.status === 'submitted') break;
      // a still-pending current period doesn't break the streak either way
    }
    const latestMissed = clientCheckins.find((c) => c.status === 'missed');
    if (latestMissed && consecutiveMissed >= 1) {
      await openFlag(
        database, coach, client, 'checkin_missed',
        consecutiveMissed >= 2 ? 'attention' : 'notice',
        `${client.id}:checkin_missed:${latestMissed.id}`,
        consecutiveMissed >= 2
          ? `Missed ${consecutiveMissed} check-ins in a row`
          : 'Missed a check-in',
        myFlags
      );
    } else if (!latestMissed) {
      await resolveFlags(database, client.id, 'checkin_missed', myFlags);
    }

    // --- goal_stale (no progress update in coach-set days, default 14) ---
    const staleDays = coach.goal_stale_days || 14;
    const staleGoals = goals.filter(
      (g) =>
        g.client_id === client.id &&
        g.status === 'active' &&
        daysBetween(new Date(g.progress_updated_at), now) >= staleDays
    );
    if (staleGoals.length > 0) {
      const g = staleGoals[0];
      const days = daysBetween(new Date(g.progress_updated_at), now);
      await openFlag(
        database, coach, client, 'goal_stale', 'notice',
        `${client.id}:goal_stale:${g.id}:${g.progress_updated_at.slice(0, 10)}`,
        `No goal update in ${days} days`,
        myFlags
      );
    } else {
      await resolveFlags(database, client.id, 'goal_stale', myFlags);
    }
  }
}
