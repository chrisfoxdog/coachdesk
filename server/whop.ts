import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  db,
  newId,
  type IDatabase,
  type Coach,
  type Client,
  type MembershipLink,
  type MembershipStatus,
} from './db.js';
import { LIVE_LINK_STATUSES, nowIso, programWeek } from './constants.js';

export interface WhopWebhookEvent {
  action?: string;
  type?: string;
  id?: string;
  data?: any;
  timestamp?: number | string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// User identity: the Whop iframe token, verified against Whop's JWKS.
// Identity is NEVER taken from a client-supplied user-ID field (data model §2).
// ---------------------------------------------------------------------------

const WHOP_JWKS_URL = 'https://api.whop.com/.well-known/jwks.json';
const remoteJWKSet = createRemoteJWKSet(new URL(WHOP_JWKS_URL));

export async function verifyWhopUserToken(token: string): Promise<{
  valid: boolean;
  userId?: string;
  error?: string;
}> {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Missing authentication token' };
  }
  const cleanToken = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (!cleanToken) return { valid: false, error: 'Empty token string' };

  try {
    const { payload } = await jwtVerify(cleanToken, remoteJWKSet);
    const userId = (payload.sub || (payload as any).user_id) as string | undefined;
    if (!userId) return { valid: false, error: 'Token missing user identity subject claim' };
    return { valid: true, userId };
  } catch (err: any) {
    return { valid: false, error: `Invalid or expired Whop user token: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification (HMAC-SHA256, fails closed).
// Supports Whop's current standard-webhooks format:
//   headers: webhook-id, webhook-timestamp, webhook-signature: "v1,<base64>"
//   signed content: "{webhook-id}.{webhook-timestamp}.{raw body}"
//   key: WHOP_WEBHOOK_SECRET, with the "whsec_" prefix base64-decoded when present
// and the legacy "t=<ts>,v1=<hex>" header style Elite's other apps accept.
// Timestamps older than 5 minutes are rejected (replay protection).
// ---------------------------------------------------------------------------

export interface VerificationResult {
  isValid: boolean;
  reason?: string;
}

export function verifyWhopWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  timestampHeader?: string | undefined,
  webhookIdHeader?: string | undefined
): VerificationResult {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    return { isValid: false, reason: 'WHOP_WEBHOOK_SECRET is not configured. Webhook rejected for security.' };
  }
  if (!signatureHeader) return { isValid: false, reason: 'Missing webhook signature header' };

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');

  // Replay protection
  if (timestampHeader) {
    const tsNumber = Number(timestampHeader);
    if (!Number.isNaN(tsNumber)) {
      const now = Math.floor(Date.now() / 1000);
      const eventTs = tsNumber > 1e11 ? Math.floor(tsNumber / 1000) : tsNumber;
      if (Math.abs(now - eventTs) > 300) {
        return { isValid: false, reason: 'Webhook timestamp expired (replay attack protection triggered)' };
      }
    }
  }

  const keyMaterial: Buffer = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf-8');

  const candidates: { signed: Buffer; encoding: 'base64' | 'hex' }[] = [];
  if (webhookIdHeader && timestampHeader) {
    candidates.push({
      signed: Buffer.concat([Buffer.from(`${webhookIdHeader}.${timestampHeader}.`, 'utf-8'), bodyBuffer]),
      encoding: 'base64',
    });
  }
  if (timestampHeader) {
    candidates.push({
      signed: Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf-8'), bodyBuffer]),
      encoding: 'hex',
    });
    candidates.push({
      signed: Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf-8'), bodyBuffer]),
      encoding: 'base64',
    });
  }
  candidates.push({ signed: bodyBuffer, encoding: 'hex' });
  candidates.push({ signed: bodyBuffer, encoding: 'base64' });

  // The header may carry one or more "v1,<sig>" entries (key rotation), or a
  // legacy "t=...,v1=..." pair.
  const provided: string[] = [];
  if (signatureHeader.includes('t=') || /^v1=/.test(signatureHeader)) {
    for (const part of signatureHeader.split(',')) {
      const [k, v] = part.split('=');
      if (k?.trim() === 'v1' && v) provided.push(v.trim());
    }
  } else {
    for (const part of signatureHeader.split(' ')) {
      const p = part.trim();
      if (p.startsWith('v1,')) provided.push(p.slice(3));
      else if (p) provided.push(p);
    }
  }
  if (provided.length === 0) return { isValid: false, reason: 'Unparseable webhook signature header' };

  for (const sig of provided) {
    for (const { signed, encoding } of candidates) {
      const expected = crypto.createHmac('sha256', keyMaterial).update(signed).digest(encoding);
      try {
        const sigBuf = Buffer.from(sig, encoding);
        const expBuf = Buffer.from(expected, encoding);
        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
          return { isValid: true };
        }
      } catch {
        // not this encoding — keep trying
      }
      if (sig === expected) return { isValid: true };
    }
  }
  return { isValid: false, reason: 'Signature mismatch' };
}

// ---------------------------------------------------------------------------
// Tenant resolution. One CoachDesk tenant per whop (data model §1), keyed by
// whop_company_id. The tenant row is created by the first webhook or the
// owner's first visit; whop_user_id is bound when the owner identity is known.
// ---------------------------------------------------------------------------

export async function getOrCreateTenant(database: IDatabase, companyId: string): Promise<Coach> {
  const coaches = await database.getAll<Coach>('coaches');
  const existing = coaches.find((c) => c.whop_company_id === companyId);
  if (existing) return existing;
  const now = nowIso();
  const coach: Coach = {
    id: newId('coach'),
    whop_company_id: companyId,
    whop_user_id: '',
    display_name: 'Coach',
    timezone: 'UTC',
    checkin_default_cadence: 'weekly',
    archived_retention_months: 12,
    goal_stale_days: 14,
    created_at: now,
    updated_at: now,
  };
  return database.insert('coaches', coach);
}

// ---------------------------------------------------------------------------
// Timeline + audit helpers shared with the API layer
// ---------------------------------------------------------------------------

export async function addClientEvent(
  database: IDatabase,
  coachId: string,
  clientId: string,
  type: string,
  summary: string,
  visibility: 'coach_only' | 'shared',
  refTable?: string,
  refId?: string
): Promise<void> {
  const now = nowIso();
  await database.insert('client_events', {
    id: newId('evt'),
    coach_id: coachId,
    client_id: clientId,
    type,
    summary,
    ref_table: refTable,
    ref_id: refId,
    occurred_at: now,
    visibility,
    created_at: now,
  });
}

export async function addAudit(
  database: IDatabase,
  actor: 'coach' | 'client' | 'system' | 'elite-support',
  action: string,
  coachId?: string,
  clientId?: string,
  detail?: string
): Promise<void> {
  await database.insert('audit_log', {
    id: newId('aud'),
    actor,
    action,
    coach_id: coachId,
    client_id: clientId,
    detail,
    created_at: nowIso(),
  });
}

/**
 * Create the pending intake response for a product's active form, if the
 * client doesn't already have one for that form (Flow A step 5).
 */
export async function ensurePendingIntake(
  database: IDatabase,
  coach: Coach,
  client: Client,
  productId: string
): Promise<void> {
  if (!productId) return;
  const forms = await database.getAll<any>('intake_forms');
  const form = forms.find((f) => f.coach_id === coach.id && f.whop_product_id === productId && f.is_active);
  if (!form) return;
  const responses = await database.getAll<any>('intake_responses');
  const has = responses.some((r) => r.client_id === client.id && r.form_id === form.id);
  if (has) return;
  const now = nowIso();
  await database.insert('intake_responses', {
    id: newId('intake'),
    coach_id: coach.id,
    client_id: client.id,
    form_id: form.id,
    form_version: form.version,
    answers: {},
    status: 'pending',
    visibility: 'coach_only',
    created_at: now,
    updated_at: now,
  });
}

/**
 * Archive check (Flow C step 2–3): the record archives only when its LAST live
 * link has ended. Nothing is ever deleted by a webhook (data model §6).
 */
export async function archiveIfNoLiveLinks(
  database: IDatabase,
  coach: Coach,
  client: Client
): Promise<Client> {
  if (client.status !== 'active') return client;
  const links = (await database.getAll<MembershipLink>('membership_links')).filter((l) => l.client_id === client.id);
  const hasLive = links.some((l) => (LIVE_LINK_STATUSES as readonly string[]).includes(l.status));
  if (hasLive) return client;
  const now = nowIso();
  const updated = await database.update<Client>('clients', client.id, {
    status: 'archived',
    archived_at: now,
  });
  // Open flags auto-resolve on archive (Flow C step 3).
  const flags = await database.getAll<any>('needs_attention_flags');
  for (const flag of flags.filter((f) => f.client_id === client.id && f.status === 'open')) {
    await database.update('needs_attention_flags', flag.id, { status: 'resolved', resolved_at: now });
  }
  await addClientEvent(database, coach.id, client.id, 'archived', 'Membership ended — record archived', 'coach_only');
  return updated || client;
}

function minimizedPayload(data: any, membershipId: string): Record<string, unknown> {
  return {
    membership_id: membershipId || undefined,
    user_id: data?.user_id || data?.userId || undefined,
    product_id: data?.product_id || undefined,
    plan_id: data?.plan_id || undefined,
    status: data?.status || undefined,
    company_id: data?.company_id || undefined,
  };
}

// ---------------------------------------------------------------------------
// Webhook processing — Flows A / B / C from the data model.
// Dedupe on the Whop event id happens BEFORE any writes.
// ---------------------------------------------------------------------------

export async function handleWhopEvent(
  payload: WhopWebhookEvent,
  database: IDatabase = db
): Promise<{ success: boolean; status: 'processed' | 'duplicate' | 'ignored' | 'error'; message: string }> {
  const eventId = payload.id;
  const eventType = payload.action || payload.type || 'unknown';
  if (!eventId) return { success: false, status: 'ignored', message: 'Missing event ID in payload' };

  const existing = await database.getAll<any>('webhook_events');
  if (existing.some((e) => e.whop_event_id === eventId)) {
    return { success: true, status: 'duplicate', message: 'Event already processed — safely ignored.' };
  }

  const data = payload.data || payload;
  const whopUserId: string | undefined = data.user_id || data.userId;
  const membershipId: string = data.membership_id || data.id || '';
  const productId: string = data.product_id || '';
  const planId: string = data.plan_id || '';
  const companyId: string =
    data.company_id || (payload as any).company_id || process.env.WHOP_COMPANY_ID || 'dev_company';

  try {
    return await database.withTransaction(async (tx) => {
      // Re-check dedupe inside the transaction (race-safe).
      const seen = await tx.getAll<any>('webhook_events');
      if (seen.some((e) => e.whop_event_id === eventId)) {
        return { success: true, status: 'duplicate' as const, message: 'Event already processed — safely ignored.' };
      }

      const coach = await getOrCreateTenant(tx, companyId);
      const now = nowIso();
      let message = `Event ${eventType} recorded and acknowledged.`;
      let result: 'processed' | 'ignored' = 'processed';

      const recordEvent = async (res: 'processed' | 'ignored' | 'error', note?: string) => {
        await tx.insert('webhook_events', {
          id: newId('wh'),
          whop_event_id: eventId,
          type: eventType,
          received_at: now,
          processed_at: nowIso(),
          result: res,
          payload_min: { ...minimizedPayload(data, membershipId), note },
          created_at: now,
        });
      };

      if (!whopUserId || !membershipId) {
        await recordEvent('ignored', 'Missing user or membership id');
        return { success: true, status: 'ignored' as const, message: 'Event carried no user/membership id — logged and ignored.' };
      }

      // Upsert the membership link on whop_membership_id.
      const links = await tx.getAll<MembershipLink>('membership_links');
      let link = links.find((l) => l.whop_membership_id === membershipId && l.coach_id === coach.id);

      const findClient = async (): Promise<Client | undefined> => {
        const clients = await tx.getAll<Client>('clients');
        return clients.find((c) => c.coach_id === coach.id && c.whop_user_id === whopUserId);
      };

      const upsertLink = async (
        clientId: string,
        status: MembershipStatus,
        validTo?: string
      ): Promise<MembershipLink> => {
        if (link) {
          const updated = await tx.update<MembershipLink>('membership_links', link.id, {
            status,
            whop_product_id: productId || link.whop_product_id,
            whop_plan_id: planId || link.whop_plan_id,
            valid_to: validTo ?? link.valid_to,
            last_event_id: eventId,
          });
          link = updated || link;
          return link;
        }
        const created: MembershipLink = {
          id: newId('link'),
          coach_id: coach.id,
          client_id: clientId,
          whop_membership_id: membershipId,
          whop_product_id: productId,
          whop_plan_id: planId,
          status,
          valid_from: now,
          valid_to: validTo,
          last_event_id: eventId,
          created_at: now,
          updated_at: now,
        };
        await tx.insert('membership_links', created);
        link = created;
        return created;
      };

      switch (eventType) {
        case 'membership.activated':
        case 'membership.went_valid':
        case 'membership.created': {
          // ---- Flow A: record created / reactivated ----
          let client = await findClient();
          const reportedStatus = (data.status as MembershipStatus) || 'active';
          const status: MembershipStatus = (['active', 'trialing'] as string[]).includes(reportedStatus)
            ? reportedStatus
            : 'active';

          if (!client) {
            const created: Client = {
              id: newId('client'),
              coach_id: coach.id,
              whop_user_id: whopUserId,
              whop_membership_id: membershipId,
              display_name: data.user_name || data.name || data.username || 'Client',
              email: data.email || '',
              status: 'active',
              started_at: now,
              program_week: 1,
              tags: [],
              created_via_event_id: eventId,
              created_at: now,
              updated_at: now,
            };
            await tx.insert('clients', created);
            client = created;
            await upsertLink(client.id, status, data.valid_to || data.expires_at);
            await addClientEvent(tx, coach.id, client.id, 'joined', 'Joined — client record created', 'shared', 'clients', client.id);
            message = `Client record created for user ${whopUserId}.`;
          } else if (client.status === 'archived') {
            const updated = await tx.update<Client>('clients', client.id, {
              status: 'active',
              archived_at: undefined,
              whop_membership_id: membershipId,
              display_name: data.user_name || data.name || client.display_name,
              email: data.email || client.email,
            });
            client = updated || client;
            await upsertLink(client.id, status, data.valid_to || data.expires_at);
            await addClientEvent(tx, coach.id, client.id, 'reactivated', 'Membership restarted — record reactivated with history intact', 'shared', 'clients', client.id);
            message = `Client record reactivated for user ${whopUserId} (same record, history preserved).`;
          } else {
            await tx.update<Client>('clients', client.id, {
              whop_membership_id: membershipId,
              display_name: data.user_name || data.name || client.display_name,
              email: data.email || client.email,
              program_week: programWeek(client.started_at),
            });
            await upsertLink(client.id, status, data.valid_to || data.expires_at);
            message = `Membership confirmed active for user ${whopUserId}.`;
          }

          if (client.status !== 'deleted') {
            await ensurePendingIntake(tx, coach, client, productId || link?.whop_product_id || '');
          }
          break;
        }

        case 'membership.updated': {
          const client = await findClient();
          if (!client) {
            result = 'ignored';
            message = 'membership.updated for an unknown client — logged and ignored.';
            break;
          }
          const reported = data.status as MembershipStatus | undefined;
          if (link && reported && (['active', 'trialing', 'past_due', 'cancelled', 'ended'] as string[]).includes(reported)) {
            await upsertLink(client.id, reported, data.valid_to || data.expires_at);
          } else if (!link) {
            await upsertLink(client.id, reported || 'active', data.valid_to || data.expires_at);
          }
          await tx.update<Client>('clients', client.id, {
            display_name: data.user_name || data.name || client.display_name,
            email: data.email || client.email,
          });
          const refreshed = (await tx.getById<Client>('clients', client.id)) || client;
          if (reported === 'ended' || reported === 'cancelled') {
            await archiveIfNoLiveLinks(tx, coach, refreshed);
          }
          message = `Membership snapshot updated for user ${whopUserId}.`;
          break;
        }

        case 'payment.succeeded': {
          // ---- Flow B (success): status reflected as Whop reports it ----
          const client = await findClient();
          if (!client || !link) {
            result = 'ignored';
            message = 'payment.succeeded without a known membership link — logged and ignored.';
            break;
          }
          await upsertLink(client.id, 'active', data.valid_to || data.expires_at);
          const flags = await tx.getAll<any>('needs_attention_flags');
          for (const flag of flags.filter(
            (f) => f.client_id === client.id && f.type === 'membership_past_due' && f.status === 'open'
          )) {
            await tx.update('needs_attention_flags', flag.id, { status: 'resolved', resolved_at: nowIso() });
          }
          await addClientEvent(tx, coach.id, client.id, 'membership_status', 'Payment succeeded — membership active', 'coach_only', 'membership_links', link.id);
          message = `Payment success reflected for user ${whopUserId}; past-due flag resolved.`;
          break;
        }

        case 'payment.failed': {
          // ---- Flow B (failure): past_due + flag. No balances are ever computed. ----
          const client = await findClient();
          if (!client || !link) {
            result = 'ignored';
            message = 'payment.failed without a known membership link — logged and ignored.';
            break;
          }
          await upsertLink(client.id, 'past_due');
          const flags = await tx.getAll<any>('needs_attention_flags');
          const dedupeKey = `${client.id}:membership_past_due:${link.id}`;
          if (!flags.some((f) => f.dedupe_key === dedupeKey && f.status === 'open')) {
            await tx.insert('needs_attention_flags', {
              id: newId('flag'),
              coach_id: coach.id,
              client_id: client.id,
              type: 'membership_past_due',
              severity: 'urgent',
              status: 'open',
              dedupe_key: dedupeKey,
              detail: 'Payment failed — Whop is retrying',
              created_at: nowIso(),
              updated_at: nowIso(),
            });
          }
          await addClientEvent(tx, coach.id, client.id, 'membership_status', 'Payment failed — Whop is retrying', 'coach_only', 'membership_links', link.id);
          message = `Payment failure reflected for user ${whopUserId}; membership_past_due flag opened.`;
          break;
        }

        case 'membership.deactivated':
        case 'membership.went_invalid':
        case 'membership.cancelled':
        case 'membership.terminated': {
          // ---- Flow C: archive only when the LAST live link ends. Never delete. ----
          const client = await findClient();
          if (!client) {
            result = 'ignored';
            message = 'Membership end event for an unknown client — logged and ignored.';
            break;
          }
          const endStatus: MembershipStatus =
            data.status === 'cancelled' || eventType === 'membership.cancelled' ? 'cancelled' : 'ended';
          if (link) {
            await upsertLink(client.id, endStatus, data.valid_to || data.expires_at || now);
          }
          const refreshed = (await tx.getById<Client>('clients', client.id)) || client;
          const after = await archiveIfNoLiveLinks(tx, coach, refreshed);
          message =
            after.status === 'archived'
              ? `Last live membership ended for user ${whopUserId}; record archived (never deleted by webhook).`
              : `One membership ended for user ${whopUserId}; another is still live, record stays active.`;
          break;
        }

        case 'refund.created': {
          const client = await findClient();
          if (client) {
            await addClientEvent(tx, coach.id, client.id, 'membership_status', 'Refund recorded in Whop', 'coach_only', 'membership_links', link?.id);
          }
          message = 'Refund event noted on the record. CoachDesk stores no payment data.';
          break;
        }

        default:
          result = 'ignored';
          message = `Event ${eventType} recorded and acknowledged.`;
          break;
      }

      await recordEvent(result);
      return { success: true, status: result === 'ignored' ? ('ignored' as const) : ('processed' as const), message };
    });
  } catch (err: any) {
    console.error(`[handleWhopEvent] Event ${eventId} failed:`, err);
    try {
      const now = nowIso();
      await database.insert('webhook_events', {
        id: newId('wh'),
        whop_event_id: eventId,
        type: eventType,
        received_at: now,
        processed_at: now,
        result: 'error',
        payload_min: minimizedPayload(data, membershipId),
        created_at: now,
      });
    } catch {
      // logging must never mask the original error path
    }
    return { success: false, status: 'error', message: `Processing failed: ${err.message}` };
  }
}
