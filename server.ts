import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  db,
  newId,
  type Coach,
  type Client,
  type Goal,
  type IntakeForm,
  type CheckinTemplate,
  type FormField,
} from './server/db.js';
import {
  verifyWhopUserToken,
  verifyWhopWebhookSignature,
  handleWhopEvent,
  getOrCreateTenant,
  addClientEvent,
  addAudit,
  ensurePendingIntake,
} from './server/whop.js';
import { deriveCoachState } from './server/flags.js';
import { DEFAULT_CONSENT_TEXT, nowIso, programWeek } from './server/constants.js';

export const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Health — public, same shape discipline as Elite's other apps (no AI fields:
// CoachDesk has no AI configuration to report).
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  const dbHealth = await db.healthCheck();
  return res.json({
    status: dbHealth.ok ? 'healthy' : 'degraded',
    timestamp: nowIso(),
    environment: process.env.NODE_ENV || 'development',
    database: dbHealth,
    whopConfigured: Boolean(process.env.WHOP_API_KEY && process.env.WHOP_WEBHOOK_SECRET),
    whopAppIdSet: Boolean(process.env.WHOP_APP_ID),
  });
});

// ---------------------------------------------------------------------------
// Webhooks — raw body first, HMAC verified, 401 on bad signature.
// ---------------------------------------------------------------------------
app.post('/api/webhooks/whop', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const rawBody = req.body as Buffer;
    const signature = (req.headers['webhook-signature'] || req.headers['x-whop-signature']) as string | undefined;
    const timestamp = (req.headers['webhook-timestamp'] || req.headers['x-whop-timestamp']) as string | undefined;
    const webhookId = req.headers['webhook-id'] as string | undefined;

    const verification = verifyWhopWebhookSignature(rawBody, signature, timestamp, webhookId);
    if (!verification.isValid) {
      console.warn(`[Whop Webhook] Rejected unauthorized webhook: ${verification.reason}`);
      return res.status(401).json({ error: 'Invalid webhook signature', details: verification.reason });
    }

    let payload: any;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : String(rawBody));
    } catch {
      return res.status(400).json({ error: 'Malformed JSON payload in webhook' });
    }

    const result = await handleWhopEvent(payload);
    return res.status(200).json({ received: true, status: result.status, message: result.message });
  } catch (err: any) {
    console.error('[Whop Webhook Error]', err);
    return res.status(500).json({ error: 'Webhook processing error', message: err.message });
  }
});

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Identity. The server derives who you are from the verified Whop token —
// never from a client-supplied user id (data model §2, privacy model §1).
//   coach scope  = the tenant resolved from WHOP_COMPANY_ID
//   client scope = the single clients row whose whop_user_id == token user id
// Production fails closed (401). Dev-header fallback only outside production.
// DB failure -> 503 DATABASE_UNAVAILABLE, never a crash, never fake data.
// ---------------------------------------------------------------------------

interface Identity {
  role: 'coach' | 'client' | 'ended';
  userId: string;
  coach: Coach;
  client?: Client;
}

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

async function resolveIdentity(req: Request): Promise<Identity | { error: number; body: any }> {
  const health = await db.healthCheck();
  if (!health.ok) return { error: 503, body: { error: 'DATABASE_UNAVAILABLE' } };

  let userId: string | undefined;
  let devCompany: string | undefined;

  const tokenHeader = (req.headers['x-whop-user-token'] || req.headers['authorization']) as string | undefined;
  if (tokenHeader) {
    const verification = await verifyWhopUserToken(tokenHeader);
    if (!verification.valid) {
      return { error: 401, body: { error: 'WHOP_USER_AUTH_REQUIRED', message: verification.error } };
    }
    userId = verification.userId;
  } else if (!IS_PROD) {
    const devHeader = (req.headers['x-whop-dev-user-id'] || req.headers['x-mock-user-id']) as string | undefined;
    if (devHeader && devHeader.trim()) {
      userId = devHeader.trim();
      devCompany = (req.headers['x-whop-dev-company-id'] as string | undefined)?.trim();
    }
  }

  if (!userId) {
    return {
      error: 401,
      body: {
        error: 'WHOP_USER_AUTH_REQUIRED',
        message: 'Open CoachDesk from inside your Whop to sign in.',
      },
    };
  }

  const companyId = devCompany || process.env.WHOP_COMPANY_ID || (IS_PROD ? '' : 'dev_company');
  if (!companyId) {
    return { error: 401, body: { error: 'WHOP_USER_AUTH_REQUIRED', message: 'WHOP_COMPANY_ID is not configured.' } };
  }

  const tenant = await getOrCreateTenant(db, companyId);
  const clients = await db.getAll<Client>('clients');
  const ownRecord = clients.find((c) => c.coach_id === tenant.id && c.whop_user_id === userId && c.status !== 'deleted');

  if (tenant.whop_user_id && tenant.whop_user_id === userId) {
    return { role: 'coach', userId, coach: tenant };
  }
  if (!tenant.whop_user_id && !ownRecord) {
    // First verified non-client identity on a fresh install binds as the owner
    // (the person who installed the app into the whop). See SMOKE.md.
    const bound = await db.update<Coach>('coaches', tenant.id, { whop_user_id: userId });
    await addAudit(db, 'coach', 'coach_sign_in', tenant.id, undefined, 'Owner identity bound on first open');
    return { role: 'coach', userId, coach: bound || tenant };
  }
  if (ownRecord) {
    if (ownRecord.status === 'archived') return { role: 'ended', userId, coach: tenant, client: ownRecord };
    return { role: 'client', userId, coach: tenant, client: ownRecord };
  }
  return { error: 403, body: { error: 'NO_ACCESS', message: 'This Whop account has no CoachDesk access.' } };
}

async function requireIdentity(req: Request, res: Response, next: NextFunction) {
  try {
    const resolved = await resolveIdentity(req);
    if ('error' in resolved) return res.status(resolved.error).json(resolved.body);
    req.identity = resolved;
    return next();
  } catch (err: any) {
    console.error('[Identity Error]', err);
    return res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
  }
}

function requireCoach(req: Request, res: Response, next: NextFunction) {
  if (req.identity?.role !== 'coach') {
    return res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'This area is for the coach only.' });
  }
  return next();
}

function requireClient(req: Request, res: Response, next: NextFunction) {
  if (req.identity?.role === 'ended') {
    return res.status(403).json({
      error: 'MEMBERSHIP_ENDED',
      message: 'Your coaching membership has ended, so this page is closed. To request a copy of your record, email your coach.',
    });
  }
  if (req.identity?.role !== 'client' || !req.identity.client) {
    return res.status(403).json({ error: 'FORBIDDEN_ROLE', message: 'This area is for clients only.' });
  }
  return next();
}

/** Load a client that belongs to the signed-in coach — tenant scoping on every read. */
async function coachClientOr404(req: Request, res: Response, clientId: string): Promise<Client | null> {
  const coach = req.identity!.coach;
  const client = await db.getById<Client>('clients', clientId);
  if (!client || client.coach_id !== coach.id || client.status === 'deleted') {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Client record not found.' });
    return null;
  }
  return client;
}

const FIELD_TYPES = ['short_text', 'long_text', 'single_choice', 'multi_choice', 'checkbox'];

function sanitizeFields(raw: any): FormField[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FormField[] = [];
  for (const f of raw) {
    if (!f || typeof f.label !== 'string' || !f.label.trim() || !FIELD_TYPES.includes(f.type)) return null;
    out.push({
      id: typeof f.id === 'string' && f.id ? f.id : newId('field'),
      label: f.label.trim(),
      type: f.type,
      required: Boolean(f.required),
      help_text: typeof f.help_text === 'string' ? f.help_text : undefined,
      options: Array.isArray(f.options) ? f.options.filter((o: any) => typeof o === 'string') : undefined,
    });
  }
  return out;
}

function validateAnswers(fields: FormField[], answers: Record<string, unknown>): string | null {
  for (const f of fields) {
    if (!f.required) continue;
    const v = answers[f.id];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || v === false) {
      return `Required — "${f.label}" needs an answer.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context — how the frontend learns which role it is rendering.
// ---------------------------------------------------------------------------
app.get('/api/me/context', requireIdentity, async (req, res) => {
  const idn = req.identity!;
  if (idn.role === 'coach') {
    return res.json({ role: 'coach', coach: { id: idn.coach.id, display_name: idn.coach.display_name } });
  }
  if (idn.role === 'ended') {
    return res.json({ role: 'ended', coach: { display_name: idn.coach.display_name } });
  }
  return res.json({
    role: 'client',
    coach: { display_name: idn.coach.display_name },
    client: { display_name: idn.client!.display_name, program_week: programWeek(idn.client!.started_at) },
  });
});

// ===========================================================================
// COACH API
// ===========================================================================

app.get('/api/coach/roster', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  await deriveCoachState(db, coach);
  const status = (req.query.status as string) === 'archived' ? 'archived' : 'active';
  const search = ((req.query.search as string) || '').toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const [clients, links, flags] = await Promise.all([
    db.getAll<Client>('clients'),
    db.getAll<any>('membership_links'),
    db.getAll<any>('needs_attention_flags'),
  ]);

  let rows = clients
    .filter((c) => c.coach_id === coach.id && c.status === status)
    .filter(
      (c) =>
        !search ||
        c.display_name.toLowerCase().includes(search) ||
        c.tags.some((t) => t.toLowerCase().includes(search))
    )
    .map((c) => {
      const clientLinks = links.filter((l) => l.client_id === c.id);
      const primary =
        clientLinks.find((l) => l.whop_membership_id === c.whop_membership_id) || clientLinks[clientLinks.length - 1];
      return {
        id: c.id,
        display_name: c.display_name,
        status: c.status,
        started_at: c.started_at,
        program_week: programWeek(c.started_at),
        membership_status: primary?.status || null,
        whop_product_id: primary?.whop_product_id || null,
        open_flags: flags.filter((f) => f.client_id === c.id && f.status === 'open').length,
        deletion_requested: Boolean(c.deletion_requested_at),
      };
    })
    .sort((a, b) => b.open_flags - a.open_flags || a.display_name.localeCompare(b.display_name));

  const total = rows.length;
  rows = rows.slice(offset, offset + limit);
  return res.json({ clients: rows, total, limit, offset });
});

app.get('/api/coach/clients/:id', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  await deriveCoachState(db, coach);

  const [links, forms, responses, goals, logs, items, templates, checkins, flags, events] = await Promise.all([
    db.getAll<any>('membership_links'),
    db.getAll<IntakeForm>('intake_forms'),
    db.getAll<any>('intake_responses'),
    db.getAll<Goal>('goals'),
    db.getAll<any>('session_logs'),
    db.getAll<any>('action_items'),
    db.getAll<CheckinTemplate>('checkin_templates'),
    db.getAll<any>('checkins'),
    db.getAll<any>('needs_attention_flags'),
    db.getAll<any>('client_events'),
  ]);
  const mine = <T extends { client_id: string }>(rows: T[]) => rows.filter((r) => r.client_id === client.id);
  const timelineLimit = Math.min(30, Math.max(1, Number(req.query.timeline_limit) || 30));
  const timelineOffset = Math.max(0, Number(req.query.timeline_offset) || 0);
  const timeline = mine(events)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(timelineOffset, timelineOffset + timelineLimit);

  return res.json({
    client: {
      ...client,
      program_week: programWeek(client.started_at),
    },
    membership_links: mine(links).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    intake: mine(responses).map((r) => ({
      response: r,
      form: forms.find((f) => f.id === r.form_id) || null,
    })),
    goals: mine(goals).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    session_logs: mine(logs).sort((a, b) => b.session_at.localeCompare(a.session_at)),
    action_items: mine(items).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    checkins: mine(checkins)
      .sort((a, b) => b.period_start.localeCompare(a.period_start))
      .map((c) => ({ ...c, template: templates.find((t) => t.id === c.template_id) || null })),
    flags: mine(flags).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    timeline,
  });
});

app.patch('/api/coach/clients/:id', requireIdentity, requireCoach, async (req, res) => {
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  const updates: Partial<Client> = {};
  if (Array.isArray(req.body?.tags)) {
    updates.tags = req.body.tags.filter((t: any) => typeof t === 'string').map((t: string) => t.trim()).filter(Boolean);
  }
  if (typeof req.body?.agreement_url === 'string') updates.agreement_url = req.body.agreement_url.trim() || undefined;
  if (typeof req.body?.display_name === 'string' && req.body.display_name.trim()) {
    updates.display_name = req.body.display_name.trim();
  }
  const updated = await db.update<Client>('clients', client.id, updates);
  return res.json({ client: updated });
});

// ---- Goals ----------------------------------------------------------------

app.post('/api/coach/clients/:id/goals', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'VALIDATION', message: 'Required — a goal needs a title.' });
  const now = nowIso();
  const visibility = req.body?.visibility === 'coach_only' ? 'coach_only' : 'shared';
  const goal: Goal = {
    id: newId('goal'),
    coach_id: coach.id,
    client_id: client.id,
    title,
    description: (req.body?.description || '').trim(),
    target: (req.body?.target || '').trim(),
    status: 'active',
    progress_note: '',
    progress_updated_at: now,
    visibility,
    created_at: now,
    updated_at: now,
  };
  await db.insert('goals', goal);
  await addClientEvent(db, coach.id, client.id, 'goal_created', `Goal added: ${title}`, visibility, 'goals', goal.id);
  return res.status(201).json({ goal });
});

app.patch('/api/coach/goals/:goalId', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const goal = await db.getById<Goal>('goals', req.params.goalId);
  if (!goal || goal.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const updates: Partial<Goal> = {};
  if (typeof req.body?.title === 'string' && req.body.title.trim()) updates.title = req.body.title.trim();
  if (typeof req.body?.description === 'string') updates.description = req.body.description;
  if (typeof req.body?.target === 'string') updates.target = req.body.target;
  if (['active', 'achieved', 'paused', 'archived'].includes(req.body?.status)) updates.status = req.body.status;
  if (req.body?.visibility === 'shared' || req.body?.visibility === 'coach_only') updates.visibility = req.body.visibility;
  if (typeof req.body?.progress_note === 'string') {
    updates.progress_note = req.body.progress_note;
    updates.progress_updated_at = nowIso(); // a progress note resets the stale-goal clock
  }
  const updated = await db.update<Goal>('goals', goal.id, updates);
  if (updates.status === 'achieved' && goal.status !== 'achieved') {
    await addClientEvent(db, coach.id, goal.client_id, 'goal_achieved', `Goal achieved: ${goal.title}`, goal.visibility, 'goals', goal.id);
  }
  return res.json({ goal: updated });
});

// ---- Session logs (coach-only, hard-fixed) --------------------------------

app.post('/api/coach/clients/:id/session-logs', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  const notes = (req.body?.notes || '').trim();
  const wins = (req.body?.wins || '').trim();
  if (!notes && !wins) {
    return res.status(400).json({ error: 'VALIDATION', message: 'Required — add a note or a win, or delete the entry.' });
  }
  const now = nowIso();
  const log = {
    id: newId('session'),
    coach_id: coach.id,
    client_id: client.id,
    session_at: typeof req.body?.session_at === 'string' && req.body.session_at ? req.body.session_at : now,
    whop_booking_ref: typeof req.body?.whop_booking_ref === 'string' ? req.body.whop_booking_ref : undefined,
    notes,
    wins,
    visibility: 'coach_only' as const,
    created_at: now,
    updated_at: now,
  };
  await db.insert('session_logs', log);

  const createdItems: any[] = [];
  if (Array.isArray(req.body?.action_items)) {
    for (const raw of req.body.action_items) {
      const text = (raw?.text || '').trim();
      if (!text) continue;
      const item = {
        id: newId('action'),
        coach_id: coach.id,
        client_id: client.id,
        session_log_id: log.id,
        text,
        due_date: typeof raw?.due_date === 'string' && raw.due_date ? raw.due_date : undefined,
        visibility: 'shared' as const,
        created_at: now,
        updated_at: now,
      };
      await db.insert('action_items', item);
      createdItems.push(item);
    }
  }
  // The timeline entry is coach-only: session notes never surface to clients.
  await addClientEvent(db, coach.id, client.id, 'session_logged', 'Session logged', 'coach_only', 'session_logs', log.id);
  return res.status(201).json({ session_log: log, action_items: createdItems });
});

app.patch('/api/coach/session-logs/:logId', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const log = await db.getById<any>('session_logs', req.params.logId);
  if (!log || log.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  // Notes lock 7 days after the session — a record tool's history is not
  // silently rewriteable (design system §6.4). After that, add a new entry.
  const ageMs = Date.now() - new Date(log.created_at).getTime();
  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    return res.status(409).json({
      error: 'SESSION_LOG_LOCKED',
      message: 'This entry is more than 7 days old and is locked. Add a new session log as a correction instead.',
    });
  }
  const updates: Record<string, unknown> = {};
  if (typeof req.body?.notes === 'string') updates.notes = req.body.notes;
  if (typeof req.body?.wins === 'string') updates.wins = req.body.wins;
  const updated = await db.update('session_logs', log.id, updates);
  return res.json({ session_log: updated });
});

// ---- Action items -----------------------------------------------------------

app.post('/api/coach/clients/:id/action-items', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'VALIDATION', message: 'Required — an action item needs text.' });
  const now = nowIso();
  const item = {
    id: newId('action'),
    coach_id: coach.id,
    client_id: client.id,
    text,
    due_date: typeof req.body?.due_date === 'string' && req.body.due_date ? req.body.due_date : undefined,
    visibility: 'shared' as const,
    created_at: now,
    updated_at: now,
  };
  await db.insert('action_items', item);
  return res.status(201).json({ action_item: item });
});

app.patch('/api/coach/action-items/:itemId', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const item = await db.getById<any>('action_items', req.params.itemId);
  if (!item || item.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const updates: Record<string, unknown> = {};
  if (typeof req.body?.text === 'string' && req.body.text.trim()) updates.text = req.body.text.trim();
  if (typeof req.body?.due_date === 'string') updates.due_date = req.body.due_date || undefined;
  if (typeof req.body?.done === 'boolean') updates.done_at = req.body.done ? nowIso() : undefined;
  const updated = await db.update('action_items', item.id, updates);
  return res.json({ action_item: updated });
});

app.delete('/api/coach/action-items/:itemId', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const item = await db.getById<any>('action_items', req.params.itemId);
  if (!item || item.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  await db.remove('action_items', item.id);
  return res.json({ deleted: true });
});

// ---- Intake forms -----------------------------------------------------------

app.get('/api/coach/consent-template', requireIdentity, requireCoach, (_req, res) => {
  return res.json({ consent_text: DEFAULT_CONSENT_TEXT });
});

app.get('/api/coach/intake-forms', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const forms = (await db.getAll<IntakeForm>('intake_forms')).filter((f) => f.coach_id === coach.id);
  return res.json({ intake_forms: forms });
});

app.post('/api/coach/intake-forms', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const fields = sanitizeFields(req.body?.fields || []);
  if (!fields || fields.length === 0) {
    return res.status(400).json({ error: 'VALIDATION', message: 'Required — a form needs at least one valid question.' });
  }
  const productId = (req.body?.whop_product_id || '').trim();
  if (!productId) return res.status(400).json({ error: 'VALIDATION', message: 'Required — choose the product this form belongs to.' });
  const now = nowIso();
  // The consent block ships with the product and cannot be removed — an empty
  // value falls back to the default template (privacy model §8.4).
  const consent = typeof req.body?.consent_text === 'string' && req.body.consent_text.trim()
    ? req.body.consent_text
    : DEFAULT_CONSENT_TEXT;
  if (req.body?.is_active !== false) {
    const forms = await db.getAll<IntakeForm>('intake_forms');
    for (const f of forms.filter((x) => x.coach_id === coach.id && x.whop_product_id === productId && x.is_active)) {
      await db.update('intake_forms', f.id, { is_active: false });
    }
  }
  const form: IntakeForm = {
    id: newId('form'),
    coach_id: coach.id,
    whop_product_id: productId,
    title: (req.body?.title || 'Intake form').trim(),
    fields,
    consent_text: consent,
    version: 1,
    is_active: req.body?.is_active !== false,
    created_at: now,
    updated_at: now,
  };
  await db.insert('intake_forms', form);
  if (form.is_active) {
    const clients = (await db.getAll<Client>('clients')).filter((c) => c.coach_id === coach.id && c.status === 'active');
    for (const c of clients) await ensurePendingIntake(db, coach, c, productId);
  }
  return res.status(201).json({ intake_form: form });
});

app.patch('/api/coach/intake-forms/:formId', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const form = await db.getById<IntakeForm>('intake_forms', req.params.formId);
  if (!form || form.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const updates: Partial<IntakeForm> = {};
  let versionBump = false;
  if (req.body?.fields !== undefined) {
    const fields = sanitizeFields(req.body.fields);
    if (!fields || fields.length === 0) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Required — a form needs at least one valid question.' });
    }
    if (JSON.stringify(fields) !== JSON.stringify(form.fields)) versionBump = true;
    updates.fields = fields;
  }
  if (typeof req.body?.consent_text === 'string') {
    const consent = req.body.consent_text.trim() ? req.body.consent_text : DEFAULT_CONSENT_TEXT;
    if (consent !== form.consent_text) versionBump = true;
    updates.consent_text = consent;
  }
  if (typeof req.body?.title === 'string' && req.body.title.trim()) updates.title = req.body.title.trim();
  if (typeof req.body?.is_active === 'boolean') {
    updates.is_active = req.body.is_active;
    if (req.body.is_active) {
      const forms = await db.getAll<IntakeForm>('intake_forms');
      for (const f of forms.filter((x) => x.coach_id === coach.id && x.whop_product_id === form.whop_product_id && x.is_active && x.id !== form.id)) {
        await db.update('intake_forms', f.id, { is_active: false });
      }
    }
  }
  if (versionBump) updates.version = form.version + 1;
  const updated = await db.update<IntakeForm>('intake_forms', form.id, updates);
  if (updated?.is_active) {
    const clients = (await db.getAll<Client>('clients')).filter((c) => c.coach_id === coach.id && c.status === 'active');
    for (const c of clients) await ensurePendingIntake(db, coach, c, updated.whop_product_id);
  }
  return res.json({ intake_form: updated });
});

// ---- Check-in templates -----------------------------------------------------

app.get('/api/coach/checkin-templates', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const templates = (await db.getAll<CheckinTemplate>('checkin_templates')).filter((t) => t.coach_id === coach.id);
  return res.json({ checkin_templates: templates });
});

app.post('/api/coach/checkin-templates', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const questions = sanitizeFields(req.body?.questions || []);
  if (!questions || questions.length === 0) {
    return res.status(400).json({ error: 'VALIDATION', message: 'Required — a check-in needs at least one question.' });
  }
  const now = nowIso();
  const template: CheckinTemplate = {
    id: newId('ctpl'),
    coach_id: coach.id,
    whop_product_id: typeof req.body?.whop_product_id === 'string' && req.body.whop_product_id.trim()
      ? req.body.whop_product_id.trim()
      : undefined,
    cadence: 'weekly',
    questions,
    is_active: req.body?.is_active !== false,
    created_at: now,
    updated_at: now,
  };
  await db.insert('checkin_templates', template);
  return res.status(201).json({ checkin_template: template });
});

app.patch('/api/coach/checkin-templates/:tplId', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const tpl = await db.getById<CheckinTemplate>('checkin_templates', req.params.tplId);
  if (!tpl || tpl.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const updates: Partial<CheckinTemplate> = {};
  if (req.body?.questions !== undefined) {
    const questions = sanitizeFields(req.body.questions);
    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: 'VALIDATION', message: 'Required — a check-in needs at least one question.' });
    }
    updates.questions = questions;
  }
  if (typeof req.body?.is_active === 'boolean') updates.is_active = req.body.is_active;
  if (typeof req.body?.whop_product_id === 'string') updates.whop_product_id = req.body.whop_product_id.trim() || undefined;
  const updated = await db.update<CheckinTemplate>('checkin_templates', tpl.id, updates);
  return res.json({ checkin_template: updated });
});

// ---- Inbox ------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { urgent: 0, attention: 1, notice: 2 };

app.get('/api/coach/inbox', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  await deriveCoachState(db, coach);
  const [flags, clients] = await Promise.all([
    db.getAll<any>('needs_attention_flags'),
    db.getAll<Client>('clients'),
  ]);
  const nameOf = (id: string) => clients.find((c) => c.id === id)?.display_name || 'Client';
  const mine = flags.filter((f) => f.coach_id === coach.id);
  const open = mine
    .filter((f) => f.status === 'open')
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.created_at.localeCompare(b.created_at))
    .map((f) => ({ ...f, client_name: nameOf(f.client_id) }));
  const resolved = mine
    .filter((f) => f.status !== 'open')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20)
    .map((f) => ({ ...f, client_name: nameOf(f.client_id) }));
  return res.json({ open, resolved, open_count: open.length });
});

app.post('/api/coach/flags/:flagId/dismiss', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const flag = await db.getById<any>('needs_attention_flags', req.params.flagId);
  if (!flag || flag.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const updated = await db.update('needs_attention_flags', flag.id, { status: 'dismissed', resolved_at: nowIso() });
  return res.json({ flag: updated });
});

app.post('/api/coach/flags/:flagId/resolve', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const flag = await db.getById<any>('needs_attention_flags', req.params.flagId);
  if (!flag || flag.coach_id !== coach.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const updated = await db.update('needs_attention_flags', flag.id, { status: 'resolved', resolved_at: nowIso() });
  return res.json({ flag: updated });
});

// ---- Settings ---------------------------------------------------------------

app.get('/api/coach/settings', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  return res.json({
    settings: {
      display_name: coach.display_name,
      timezone: coach.timezone,
      checkin_default_cadence: coach.checkin_default_cadence,
      archived_retention_months: coach.archived_retention_months,
      goal_stale_days: coach.goal_stale_days,
      support_access_until: coach.support_access_until || null,
      whop_company_id: coach.whop_company_id,
    },
  });
});

app.patch('/api/coach/settings', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const updates: Partial<Coach> = {};
  if (typeof req.body?.display_name === 'string' && req.body.display_name.trim()) updates.display_name = req.body.display_name.trim();
  if (typeof req.body?.timezone === 'string' && req.body.timezone.trim()) updates.timezone = req.body.timezone.trim();
  if ([3, 6, 12, 24].includes(req.body?.archived_retention_months)) {
    updates.archived_retention_months = req.body.archived_retention_months;
  }
  if (Number.isInteger(req.body?.goal_stale_days) && req.body.goal_stale_days >= 1 && req.body.goal_stale_days <= 90) {
    updates.goal_stale_days = req.body.goal_stale_days;
  }
  const updated = await db.update<Coach>('coaches', coach.id, updates);
  return res.json({ settings: updated });
});

app.post('/api/coach/settings/support-access', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  // Coach-initiated, time-boxed (24h) Elite support window (privacy model §7).
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.update<Coach>('coaches', coach.id, { support_access_until: until });
  await addAudit(db, 'coach', 'support_access_granted', coach.id, undefined, `Support window open until ${until}`);
  return res.json({ support_access_until: until });
});

// ---- Export + deletion --------------------------------------------------------

async function buildClientExport(coach: Coach, client: Client) {
  const [links, responses, forms, goals, logs, items, checkins, templates, events] = await Promise.all([
    db.getAll<any>('membership_links'),
    db.getAll<any>('intake_responses'),
    db.getAll<IntakeForm>('intake_forms'),
    db.getAll<any>('goals'),
    db.getAll<any>('session_logs'),
    db.getAll<any>('action_items'),
    db.getAll<any>('checkins'),
    db.getAll<CheckinTemplate>('checkin_templates'),
    db.getAll<any>('client_events'),
  ]);
  const mine = <T extends { client_id: string }>(rows: T[]) => rows.filter((r) => r.client_id === client.id);
  return {
    exported_at: nowIso(),
    exported_by: 'CoachDesk',
    client: {
      id: client.id,
      display_name: client.display_name,
      email: client.email,
      status: client.status,
      started_at: client.started_at,
      tags: client.tags,
    },
    membership_links: mine(links),
    intake: mine(responses).map((r) => ({ response: r, form: forms.find((f) => f.id === r.form_id) || null })),
    goals: mine(goals),
    session_logs: mine(logs),
    action_items: mine(items),
    checkins: mine(checkins).map((c) => ({ ...c, template: templates.find((t) => t.id === c.template_id) || null })),
    timeline: mine(events).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)),
  };
}

app.get('/api/coach/clients/:id/export', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  const data = await buildClientExport(coach, client);
  await addAudit(db, 'coach', 'export_client', coach.id, client.id, `Per-client export for ${client.display_name}`);
  res.setHeader('Content-Disposition', `attachment; filename="coachdesk-client-${client.id}.json"`);
  return res.json(data);
});

app.get('/api/coach/export', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const clients = (await db.getAll<Client>('clients')).filter((c) => c.coach_id === coach.id && c.status !== 'deleted');
  const records = [];
  for (const c of clients) records.push(await buildClientExport(coach, c));
  await addAudit(db, 'coach', 'export_book', coach.id, undefined, `Whole-book export (${clients.length} records)`);
  res.setHeader('Content-Disposition', 'attachment; filename="coachdesk-whole-book.json"');
  return res.json({ exported_at: nowIso(), coach: coach.display_name, records });
});

/**
 * Hard-delete a client record's content (privacy model §5). Content rows are
 * removed; a content-free tombstone remains so the audit trail can prove the
 * deletion happened. Whop-side data is never touched — CoachDesk never held it.
 */
async function hardDeleteClientRecord(coach: Coach, client: Client, actor: 'coach' | 'client' | 'system') {
  const contentTables = [
    'goals',
    'session_logs',
    'action_items',
    'checkins',
    'intake_responses',
    'client_events',
    'needs_attention_flags',
    'membership_links',
  ] as const;
  for (const table of contentTables) {
    const rows = await db.getAll<any>(table);
    for (const row of rows.filter((r) => r.client_id === client.id)) {
      await db.remove(table, row.id);
    }
  }
  await db.update<Client>('clients', client.id, {
    status: 'deleted',
    display_name: 'Deleted record',
    email: '',
    tags: [],
    agreement_url: undefined,
    whop_membership_id: undefined,
  });
  await addAudit(db, actor, 'record_deleted', coach.id, client.id, 'Record content hard-deleted; tombstone retained with no content');
}

app.post('/api/coach/clients/:id/delete', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  const client = await coachClientOr404(req, res, req.params.id);
  if (!client) return;
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: 'CONFIRMATION_REQUIRED',
      message: 'Deleting removes this record\u2019s content (notes, answers, goals, check-ins) for good. It does not delete anything in Whop. Send confirm: true to proceed.',
    });
  }
  await hardDeleteClientRecord(coach, client, 'coach');
  return res.json({ deleted: true, client_id: client.id });
});

app.post('/api/coach/account/delete', requireIdentity, requireCoach, async (req, res) => {
  const coach = req.identity!.coach;
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: 'CONFIRMATION_REQUIRED',
      message: 'Deleting your CoachDesk account hard-deletes every client record. Export your book first. Send confirm: true to proceed.',
    });
  }
  const clients = (await db.getAll<Client>('clients')).filter((c) => c.coach_id === coach.id && c.status !== 'deleted');
  for (const c of clients) await hardDeleteClientRecord(coach, c, 'coach');
  await db.update<Coach>('coaches', coach.id, { deletion_requested_at: nowIso() });
  await addAudit(db, 'coach', 'account_deleted', coach.id, undefined, `Account deletion: ${clients.length} records hard-deleted`);
  return res.json({ deleted: true, records_deleted: clients.length });
});

// ===========================================================================
// CLIENT API — the client scope is exactly one record: the token's own.
// There is NO route here that accepts a client id. Session logs, wins, tags
// and flags are never queried by these handlers, so they cannot leak.
// ===========================================================================

app.get('/api/me/home', requireIdentity, requireClient, async (req, res) => {
  const { coach, client } = req.identity! as Identity & { client: Client };
  await deriveCoachState(db, coach);

  const [goals, items, responses, forms, checkins, templates, events] = await Promise.all([
    db.getAll<Goal>('goals'),
    db.getAll<any>('action_items'),
    db.getAll<any>('intake_responses'),
    db.getAll<IntakeForm>('intake_forms'),
    db.getAll<any>('checkins'),
    db.getAll<CheckinTemplate>('checkin_templates'),
    db.getAll<any>('client_events'),
  ]);
  const mine = <T extends { client_id: string }>(rows: T[]) => rows.filter((r) => r.client_id === client!.id);

  const myResponses = mine(responses);
  const pendingIntake = myResponses.find((r) => r.status === 'pending');
  const pendingForm = pendingIntake ? forms.find((f) => f.id === pendingIntake.form_id) : undefined;
  const myCheckins = mine(checkins).sort((a, b) => b.period_start.localeCompare(a.period_start));
  const pendingCheckin = myCheckins.find((c) => c.status === 'pending');
  const pendingTemplate = pendingCheckin ? templates.find((t) => t.id === pendingCheckin.template_id) : undefined;

  return res.json({
    client: {
      display_name: client.display_name,
      status: client.status,
      started_at: client.started_at,
      program_week: programWeek(client.started_at),
      deletion_requested: Boolean(client.deletion_requested_at),
    },
    coach: { display_name: coach.display_name },
    goals: mine(goals)
      .filter((g) => g.visibility === 'shared' && g.status !== 'archived')
      .map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        target: g.target,
        status: g.status,
        progress_note: g.progress_note,
        progress_updated_at: g.progress_updated_at,
      })),
    action_items: mine(items).map((i) => ({
      id: i.id,
      text: i.text,
      due_date: i.due_date || null,
      done_at: i.done_at || null,
    })),
    intake: pendingIntake && pendingForm
      ? {
          response_id: pendingIntake.id,
          title: pendingForm.title,
          fields: pendingForm.fields,
          consent_text: pendingForm.consent_text,
        }
      : null,
    submitted_intake: myResponses
      .filter((r) => r.status === 'submitted')
      .map((r) => ({
        form_title: forms.find((f) => f.id === r.form_id)?.title || 'Intake',
        form_fields: forms.find((f) => f.id === r.form_id)?.fields || [],
        answers: r.answers,
        submitted_at: r.submitted_at,
      })),
    checkin: pendingCheckin && pendingTemplate
      ? {
          checkin_id: pendingCheckin.id,
          period_start: pendingCheckin.period_start,
          due_at: pendingCheckin.due_at,
          questions: pendingTemplate.questions,
        }
      : null,
    past_checkins: myCheckins
      .filter((c) => c.status === 'submitted')
      .map((c) => ({
        period_start: c.period_start,
        submitted_at: c.submitted_at,
        answers: c.answers,
        questions: templates.find((t) => t.id === c.template_id)?.questions || [],
      })),
    timeline: mine(events)
      .filter((e) => e.visibility === 'shared')
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, 30)
      .map((e) => ({ type: e.type, summary: e.summary, occurred_at: e.occurred_at })),
  });
});

app.post('/api/me/intake/:responseId/submit', requireIdentity, requireClient, async (req, res) => {
  const { coach, client } = req.identity!;
  const response = await db.getById<any>('intake_responses', req.params.responseId);
  if (!response || response.client_id !== client!.id) return res.status(404).json({ error: 'NOT_FOUND' });
  if (response.status === 'submitted') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
  const form = await db.getById<IntakeForm>('intake_forms', response.form_id);
  if (!form) return res.status(404).json({ error: 'NOT_FOUND' });
  const answers = (req.body?.answers || {}) as Record<string, unknown>;
  const problem = validateAnswers(form.fields, answers);
  if (problem) return res.status(400).json({ error: 'VALIDATION', message: problem });
  const now = nowIso();
  const updated = await db.update('intake_responses', response.id, { answers, status: 'submitted', submitted_at: now });
  await addClientEvent(db, coach.id, client!.id, 'intake_submitted', 'You submitted your intake form', 'shared', 'intake_responses', response.id);
  return res.json({ intake_response: updated });
});

app.post('/api/me/checkins/:checkinId/submit', requireIdentity, requireClient, async (req, res) => {
  const { coach, client } = req.identity!;
  const checkin = await db.getById<any>('checkins', req.params.checkinId);
  if (!checkin || checkin.client_id !== client!.id) return res.status(404).json({ error: 'NOT_FOUND' });
  if (checkin.status === 'submitted') return res.status(409).json({ error: 'ALREADY_SUBMITTED' });
  const template = await db.getById<CheckinTemplate>('checkin_templates', checkin.template_id);
  if (!template) return res.status(404).json({ error: 'NOT_FOUND' });
  const answers = (req.body?.answers || {}) as Record<string, unknown>;
  const problem = validateAnswers(template.questions, answers);
  if (problem) return res.status(400).json({ error: 'VALIDATION', message: problem });
  const now = nowIso();
  const updated = await db.update('checkins', checkin.id, { answers, status: 'submitted', submitted_at: now });
  await addClientEvent(db, coach.id, client!.id, 'checkin_submitted', 'You submitted your check-in', 'shared', 'checkins', checkin.id);
  return res.json({ checkin: updated });
});

app.post('/api/me/action-items/:itemId/done', requireIdentity, requireClient, async (req, res) => {
  const { coach, client } = req.identity!;
  const item = await db.getById<any>('action_items', req.params.itemId);
  if (!item || item.client_id !== client!.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const done = req.body?.done !== false;
  const updated = await db.update('action_items', item.id, { done_at: done ? nowIso() : undefined });
  if (done) {
    await addClientEvent(db, coach.id, client!.id, 'action_done', `Action done: ${item.text}`, 'shared', 'action_items', item.id);
  }
  return res.json({ action_item: updated });
});

app.get('/api/me/export', requireIdentity, requireClient, async (req, res) => {
  const { coach, client } = req.identity! as Identity & { client: Client };
  const [goals, items, responses, forms, checkins, templates] = await Promise.all([
    db.getAll<Goal>('goals'),
    db.getAll<any>('action_items'),
    db.getAll<any>('intake_responses'),
    db.getAll<IntakeForm>('intake_forms'),
    db.getAll<any>('checkins'),
    db.getAll<CheckinTemplate>('checkin_templates'),
  ]);
  const mine = <T extends { client_id: string }>(rows: T[]) => rows.filter((r) => r.client_id === client!.id);
  const data = {
    exported_at: nowIso(),
    about: 'Your CoachDesk record — the parts of it that are yours: your answers, your shared goals, your action items. Coach-private session notes are not part of this export because they are not shown to clients in CoachDesk.',
    client: { display_name: client.display_name, started_at: client.started_at },
    intake_answers: mine(responses).map((r) => ({
      form_title: forms.find((f) => f.id === r.form_id)?.title || 'Intake',
      status: r.status,
      answers: r.answers,
      submitted_at: r.submitted_at || null,
    })),
    checkin_answers: mine(checkins)
      .filter((c) => c.status === 'submitted')
      .map((c) => ({
        period_start: c.period_start,
        questions: templates.find((t) => t.id === c.template_id)?.questions || [],
        answers: c.answers,
        submitted_at: c.submitted_at,
      })),
    shared_goals: mine(goals)
      .filter((g) => g.visibility === 'shared')
      .map((g) => ({ title: g.title, description: g.description, target: g.target, status: g.status, progress_note: g.progress_note })),
    action_items: mine(items).map((i) => ({ text: i.text, due_date: i.due_date || null, done_at: i.done_at || null })),
  };
  await addAudit(db, 'client', 'export_own', coach.id, client.id, 'Client exported their own record');
  res.setHeader('Content-Disposition', 'attachment; filename="coachdesk-my-record.json"');
  return res.json(data);
});

app.post('/api/me/request-deletion', requireIdentity, requireClient, async (req, res) => {
  const { coach, client } = req.identity! as Identity & { client: Client };
  if (client.deletion_requested_at) return res.json({ requested: true, already: true });
  await db.update<Client>('clients', client.id, {
    deletion_requested_at: nowIso(),
    deletion_requested_by: 'client',
  });
  await addAudit(db, 'client', 'deletion_requested', coach.id, client.id, 'Client asked their coach to delete their CoachDesk record');
  await addClientEvent(db, coach.id, client.id, 'deletion_requested', 'Client asked for their CoachDesk record to be deleted', 'coach_only', 'clients', client.id);
  return res.json({ requested: true });
});

// ---------------------------------------------------------------------------
// Static frontend (production build) + SPA fallback.
// ---------------------------------------------------------------------------
const distDir = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

export function startServer() {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`CoachDesk server listening on port ${port} (${process.env.NODE_ENV || 'development'})`);
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) startServer();
