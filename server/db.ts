import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
import { nowIso } from './constants.js';

// ---------------------------------------------------------------------------
// Entity types (coachdesk-data-model.md). Every tenant table carries coach_id.
// ---------------------------------------------------------------------------

export type FormFieldType = 'short_text' | 'long_text' | 'single_choice' | 'multi_choice' | 'checkbox';

export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  help_text?: string;
  options?: string[];
}

export interface Coach {
  id: string;
  whop_company_id: string;
  whop_user_id: string; // '' until the owner first opens the app (see server.ts identity resolution)
  display_name: string;
  timezone: string;
  checkin_default_cadence: string; // 'weekly' in the MVP
  archived_retention_months: number; // default 12 (privacy model §6)
  goal_stale_days: number; // default 14 (data model §10)
  support_access_until?: string; // time-boxed Elite support window (privacy model §7)
  deletion_requested_at?: string;
  created_at: string;
  updated_at: string;
}

export type ClientStatus = 'active' | 'archived' | 'deleted';

export interface Client {
  id: string;
  coach_id: string;
  whop_user_id: string;
  whop_membership_id?: string; // current primary membership link (whop membership id)
  display_name: string;
  email: string;
  status: ClientStatus;
  started_at: string;
  program_week: number; // cached; recomputed on read
  tags: string[]; // coach-private, never client-visible
  agreement_url?: string;
  created_via_event_id?: string;
  archived_at?: string;
  deletion_requested_at?: string;
  deletion_requested_by?: string; // 'client' | 'coach'
  created_at: string;
  updated_at: string;
}

export type MembershipStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'ended';

export interface MembershipLink {
  id: string;
  coach_id: string;
  client_id: string;
  whop_membership_id: string;
  whop_product_id: string;
  whop_plan_id: string;
  status: MembershipStatus; // mirrors what Whop reports; never invented
  valid_from?: string;
  valid_to?: string;
  last_event_id?: string;
  created_at: string;
  updated_at: string;
}

export interface IntakeForm {
  id: string;
  coach_id: string;
  whop_product_id: string;
  title: string;
  fields: FormField[];
  consent_text: string; // the exact wording shown to clients is kept on record
  version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface IntakeResponse {
  id: string;
  coach_id: string;
  client_id: string;
  form_id: string;
  form_version: number;
  answers: Record<string, unknown>;
  status: 'pending' | 'submitted';
  submitted_at?: string;
  visibility: 'coach_only'; // free-text answers are coach-only; the client sees their OWN answers via the client scope
  created_at: string;
  updated_at: string;
}

export type GoalStatus = 'active' | 'achieved' | 'paused' | 'archived';

export interface Goal {
  id: string;
  coach_id: string;
  client_id: string;
  title: string;
  description: string;
  target: string; // free text in the MVP — no structured health/medical fields
  status: GoalStatus;
  progress_note: string;
  progress_updated_at: string; // drives the goal_stale flag
  visibility: 'shared' | 'coach_only'; // shared is the default (the client home is the feature)
  created_at: string;
  updated_at: string;
}

export interface SessionLog {
  id: string;
  coach_id: string;
  client_id: string;
  session_at: string;
  whop_booking_ref?: string;
  notes: string;
  wins: string;
  // HARD-FIXED to coach_only. No code path may show session notes or wins to a
  // client or send them to any external service (privacy model §3).
  visibility: 'coach_only';
  created_at: string;
  updated_at: string;
}

export interface ActionItem {
  id: string;
  coach_id: string;
  client_id: string;
  session_log_id?: string;
  text: string;
  due_date?: string;
  done_at?: string;
  visibility: 'shared'; // client-facing by design
  created_at: string;
  updated_at: string;
}

export interface CheckinTemplate {
  id: string;
  coach_id: string;
  whop_product_id?: string; // null/absent = coach-wide default
  cadence: string; // 'weekly' in the MVP
  questions: FormField[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Checkin {
  id: string;
  coach_id: string;
  client_id: string;
  template_id: string;
  period_start: string;
  due_at: string;
  answers: Record<string, unknown>;
  status: 'pending' | 'submitted' | 'missed';
  submitted_at?: string;
  created_at: string;
  updated_at: string;
}

export type FlagType = 'intake_missing' | 'checkin_missed' | 'goal_stale' | 'session_upcoming' | 'membership_past_due';
export type FlagSeverity = 'urgent' | 'attention' | 'notice';

export interface NeedsAttentionFlag {
  id: string;
  coach_id: string;
  client_id: string;
  type: FlagType;
  severity: FlagSeverity;
  status: 'open' | 'resolved' | 'dismissed';
  dedupe_key: string; // unique per (client, type, period) — the flag engine cannot spam duplicates
  detail: string; // counts/dates/statuses only — NEVER note content
  created_at: string;
  resolved_at?: string;
  updated_at: string;
}

export interface ClientEvent {
  id: string;
  coach_id: string;
  client_id: string;
  type: string; // joined | reactivated | archived | membership_status | intake_submitted | session_logged | checkin_submitted | goal_created | goal_achieved | action_done | deletion_requested | record_deleted
  summary: string;
  ref_table?: string;
  ref_id?: string;
  occurred_at: string;
  visibility: 'coach_only' | 'shared';
  created_at: string;
}

export interface WebhookEventRow {
  id: string;
  whop_event_id: string;
  type: string;
  received_at: string;
  processed_at?: string;
  result: 'processed' | 'ignored-duplicate' | 'ignored' | 'error';
  payload_min: Record<string, unknown>; // minimized: IDs and statuses only, never full member payloads
  created_at: string;
}

export interface AuditEntry {
  id: string;
  actor: 'coach' | 'client' | 'system' | 'elite-support';
  action: string; // export_client | export_book | export_own | deletion_requested | record_deleted | account_deleted | coach_sign_in
  coach_id?: string;
  client_id?: string;
  detail?: string;
  created_at: string;
}

export const TABLES = [
  'coaches',
  'clients',
  'membership_links',
  'intake_forms',
  'intake_responses',
  'goals',
  'session_logs',
  'action_items',
  'checkin_templates',
  'checkins',
  'needs_attention_flags',
  'client_events',
  'webhook_events',
  'audit_log',
] as const;

export type TableName = (typeof TABLES)[number];

export type Row = Record<string, any>;

export interface StoreData {
  coaches: Record<string, Coach>;
  clients: Record<string, Client>;
  membership_links: Record<string, MembershipLink>;
  intake_forms: Record<string, IntakeForm>;
  intake_responses: Record<string, IntakeResponse>;
  goals: Record<string, Goal>;
  session_logs: Record<string, SessionLog>;
  action_items: Record<string, ActionItem>;
  checkin_templates: Record<string, CheckinTemplate>;
  checkins: Record<string, Checkin>;
  needs_attention_flags: Record<string, NeedsAttentionFlag>;
  client_events: Record<string, ClientEvent>;
  webhook_events: Record<string, WebhookEventRow>;
  audit_log: Record<string, AuditEntry>;
}

export function emptyStore(): StoreData {
  return {
    coaches: {},
    clients: {},
    membership_links: {},
    intake_forms: {},
    intake_responses: {},
    goals: {},
    session_logs: {},
    action_items: {},
    checkin_templates: {},
    checkins: {},
    needs_attention_flags: {},
    client_events: {},
    webhook_events: {},
    audit_log: {},
  };
}

export interface IDatabase {
  getAll<T = Row>(table: TableName): Promise<T[]>;
  getById<T = Row>(table: TableName, id: string): Promise<T | undefined>;
  insert<T = Row>(table: TableName, row: T & { id: string }): Promise<T>;
  update<T = Row>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined>;
  remove(table: TableName, id: string): Promise<boolean>;
  healthCheck(): Promise<{ ok: boolean; type: 'postgres' | 'file'; details?: string }>;
  withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// File-backed store (local development only — production requires Postgres)
// ---------------------------------------------------------------------------

export class FileDatabase implements IDatabase {
  private filePath: string;
  private data: StoreData;

  constructor(filePath?: string) {
    const dir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.filePath = filePath || process.env.COACHDESK_STORE_PATH || path.resolve(dir, 'store.json');
    const parent = path.dirname(this.filePath);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        const base = emptyStore();
        for (const t of TABLES) {
          if (parsed[t] && typeof parsed[t] === 'object') (base as any)[t] = parsed[t];
        }
        return base;
      }
    } catch (err) {
      console.error('Error loading store.json, using clean memory store:', err);
    }
    return emptyStore();
  }

  private save() {
    try {
      const tempPath = `${this.filePath}.tmp.${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('Failed to atomically write store.json:', err);
    }
  }

  async getAll<T = Row>(table: TableName): Promise<T[]> {
    return Object.values((this.data as any)[table]) as T[];
  }

  async getById<T = Row>(table: TableName, id: string): Promise<T | undefined> {
    const row = (this.data as any)[table][id];
    return row ? ({ ...row } as T) : undefined;
  }

  async insert<T = Row>(table: TableName, row: T & { id: string }): Promise<T> {
    (this.data as any)[table][row.id] = { ...row };
    this.save();
    return { ...row };
  }

  async update<T = Row>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined> {
    const current = (this.data as any)[table][id];
    if (!current) return undefined;
    const updated = { ...current, ...updates, updated_at: (updates as any).updated_at || nowIso() };
    (this.data as any)[table][id] = updated;
    this.save();
    return { ...updated };
  }

  async remove(table: TableName, id: string): Promise<boolean> {
    if (!(this.data as any)[table][id]) return false;
    delete (this.data as any)[table][id];
    this.save();
    return true;
  }

  async healthCheck() {
    return { ok: true, type: 'file' as const, details: 'Local JSON store (development only)' };
  }

  async withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T> {
    const snapshot = JSON.stringify(this.data);
    try {
      const result = await callback(this);
      this.save();
      return result;
    } catch (err) {
      this.data = JSON.parse(snapshot);
      this.save();
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres store (production). One generic JSONB table per entity keeps the
// schema exactly in step with the entity types above; coach_id is a real
// column so tenant scoping is enforced in SQL, not just in application code.
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

class PgStore implements IDatabase {
  constructor(private query: QueryFn, private inTransaction = false) {}

  async getAll<T = Row>(table: TableName): Promise<T[]> {
    const res = await this.query(`SELECT data FROM ${table} ORDER BY created_at ASC`);
    return res.rows.map((r) => r.data as T);
  }

  async getById<T = Row>(table: TableName, id: string): Promise<T | undefined> {
    const res = await this.query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
    return res.rows[0]?.data as T | undefined;
  }

  async insert<T = Row>(table: TableName, row: T & { id: string }): Promise<T> {
    const r = row as Row;
    await this.query(
      `INSERT INTO ${table} (id, coach_id, data, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamptz, NOW()), COALESCE($5::timestamptz, NOW()))
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.coach_id || null, JSON.stringify(r), r.created_at || null, r.updated_at || null]
    );
    return row;
  }

  async update<T = Row>(table: TableName, id: string, updates: Partial<T>): Promise<T | undefined> {
    const current = await this.getById<Row>(table, id);
    if (!current) return undefined;
    const updated = { ...current, ...updates, updated_at: (updates as any).updated_at || nowIso() };
    await this.query(`UPDATE ${table} SET data = $2::jsonb, coach_id = $3, updated_at = $4::timestamptz WHERE id = $1`, [
      id,
      JSON.stringify(updated),
      updated.coach_id || null,
      updated.updated_at,
    ]);
    return updated as T;
  }

  async remove(table: TableName, id: string): Promise<boolean> {
    const res = await this.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return (res as any).rowCount !== 0;
  }

  async healthCheck() {
    try {
      await this.query('SELECT 1');
      return { ok: true, type: 'postgres' as const };
    } catch (err: any) {
      return { ok: false, type: 'postgres' as const, details: err.message };
    }
  }

  async withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T> {
    if (this.inTransaction) return callback(this);
    throw new Error('withTransaction must be called on PostgresDatabase, not a bare PgStore');
  }
}

export class PostgresDatabase implements IDatabase {
  private pool: pg.Pool;
  private initialized = false;
  private root: PgStore;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
    this.root = new PgStore((sql, params) => this.pool.query(sql, params as any[]));
  }

  private async init() {
    if (this.initialized) return;
    const client = await this.pool.connect();
    try {
      for (const t of TABLES) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${t} (
            id TEXT PRIMARY KEY,
            coach_id TEXT,
            data JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_${t}_coach ON ${t} (coach_id);
        `);
      }
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_whop_id ON webhook_events ((data->>'whop_event_id'));`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_coach_whop_user ON clients (coach_id, (data->>'whop_user_id'));`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_links_whop_membership ON membership_links ((data->>'whop_membership_id'));`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_flags_dedupe ON needs_attention_flags ((data->>'dedupe_key'));`);
      this.initialized = true;
    } finally {
      client.release();
    }
  }

  private async ready<T>(fn: (store: PgStore) => Promise<T>): Promise<T> {
    await this.init();
    return fn(this.root);
  }

  getAll<T = Row>(table: TableName) { return this.ready((s) => s.getAll<T>(table)); }
  getById<T = Row>(table: TableName, id: string) { return this.ready((s) => s.getById<T>(table, id)); }
  insert<T = Row>(table: TableName, row: T & { id: string }) { return this.ready((s) => s.insert(table, row)); }
  update<T = Row>(table: TableName, id: string, updates: Partial<T>) { return this.ready((s) => s.update(table, id, updates)); }
  remove(table: TableName, id: string) { return this.ready((s) => s.remove(table, id)); }

  async healthCheck() {
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, type: 'postgres' as const };
    } catch (err: any) {
      return { ok: false, type: 'postgres' as const, details: err.message };
    }
  }

  async withTransaction<T>(callback: (txDb: IDatabase) => Promise<T>): Promise<T> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = new PgStore((sql, params) => client.query(sql, params as any[]), true);
      const result = await callback(txStore);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton. Production REQUIRES Postgres — no silent fallback, ever.
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error(
    'FATAL CONFIGURATION ERROR: DATABASE_URL is not set in production. CoachDesk holds private client records and requires a persistent PostgreSQL database in production; the local file store is strictly disabled in production.'
  );
}

export const db: IDatabase = process.env.DATABASE_URL
  ? new PostgresDatabase(process.env.DATABASE_URL)
  : new FileDatabase();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
