// CoachDesk guardrail + flow test suite.
// Covers the brief's required guardrails: bad webhook signature -> 401;
// activation creates client + pending intake; reactivation reuses the record;
// archive only when the LAST live link ends; payment.failed -> past_due flag;
// client token cannot read another client's record; session notes are never
// returned by client endpoints; coach A cannot read coach B's clients.
// Runs against a temp JSON store so the dev store stays clean.

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
const SECRET = 'test_webhook_secret_value';
process.env.WHOP_WEBHOOK_SECRET = SECRET;
process.env.WHOP_COMPANY_ID = 'biz_test_company';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachdesk-test-'));
process.env.COACHDESK_STORE_PATH = path.join(tmpDir, 'store.json');
delete process.env.DATABASE_URL;

const { app } = await import('../server.ts');
const { db } = await import('../server/db.ts');

const server = app.listen(0);
const port = (server.address() as any).port;
const BASE = `http://127.0.0.1:${port}`;

let passed = 0;
function pass(name: string) {
  passed++;
  console.log(`✓ PASS ${passed}: ${name}`);
}

async function req(method: string, url: string, opts: { headers?: Record<string, string>; body?: any } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

const coachA = { 'x-whop-dev-user-id': 'coach_user_a' };
const coachB = { 'x-whop-dev-user-id': 'coach_user_b', 'x-whop-dev-company-id': 'biz_other_company' };
const asClientA = { 'x-whop-dev-user-id': 'client_user_a' };
const asClientB = { 'x-whop-dev-user-id': 'client_user_b' };

function signHeaders(body: string, eventId: string, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', secret).update(`${eventId}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': eventId, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

async function sendWebhook(eventId: string, action: string, data: any, secret = SECRET) {
  const body = JSON.stringify({ id: eventId, action, data });
  const res = await fetch(`${BASE}/api/webhooks/whop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signHeaders(body, eventId, secret) },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function run() {
  console.log('================================================================================');
  console.log('COACHDESK — GUARDRAIL & FLOW TEST SUITE');
  console.log('================================================================================\n');

  // 1. Health endpoint
  const health = await req('GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.json.database.ok, true);
  pass('Health endpoint reports database ok');

  // 2. No identity -> 401 fail-closed
  const noAuth = await req('GET', '/api/coach/roster');
  assert.strictEqual(noAuth.status, 401);
  pass('Request without a Whop token or dev identity is rejected 401');

  // 3. Coach context binds the tenant owner
  const ctx = await req('GET', '/api/me/context', { headers: coachA });
  assert.strictEqual(ctx.status, 200);
  assert.strictEqual(ctx.json.role, 'coach');
  pass('Coach identity resolves to the coach role for the tenant');

  // 4. Coach builds an intake form + a check-in template
  const formRes = await req('POST', '/api/coach/intake-forms', {
    headers: coachA,
    body: {
      whop_product_id: 'prod_coaching_1',
      title: 'Coaching — Start Here',
      fields: [
        { id: 'q_goal', label: 'What is your main goal?', type: 'long_text', required: true },
        { id: 'q_exp', label: 'Experience level', type: 'short_text', required: false },
      ],
      is_active: true,
    },
  });
  assert.strictEqual(formRes.status, 201, JSON.stringify(formRes.json));
  assert.ok(formRes.json.intake_form.consent_text.length > 20, 'Default consent template must be applied');
  pass('Intake form created with the shipped consent template');
  const tplRes = await req('POST', '/api/coach/checkin-templates', {
    headers: coachA,
    body: { questions: [{ id: 'q_week', label: 'How was your week?', type: 'short_text', required: true }], is_active: true },
  });
  assert.strictEqual(tplRes.status, 201);
  pass('Check-in template created');

  // 5. Bad webhook signature -> 401
  const bad = await sendWebhook('evt_bad_sig', 'membership.activated', { id: 'mem_x', user_id: 'nobody' }, 'wrong_secret');
  assert.strictEqual(bad.status, 401);
  pass('Webhook with a bad signature is rejected 401');

  // 6. Activation creates the client record + pending intake (Flow A)
  const act1 = await sendWebhook('evt_act_a1', 'membership.activated', {
    id: 'mem_a1',
    user_id: 'client_user_a',
    product_id: 'prod_coaching_1',
    plan_id: 'plan_monthly',
    user_name: 'Client A',
    email: 'a@example.com',
  });
  assert.strictEqual(act1.status, 200, JSON.stringify(act1));
  assert.strictEqual(act1.json.status, 'processed');
  const roster1 = await req('GET', '/api/coach/roster', { headers: coachA });
  assert.strictEqual(roster1.json.total, 1);
  const clientAId = roster1.json.clients[0].id;
  const recordA1 = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(recordA1.json.client.status, 'active');
  assert.strictEqual(recordA1.json.intake.length, 1);
  assert.strictEqual(recordA1.json.intake[0].response.status, 'pending');
  const responseAId = recordA1.json.intake[0].response.id;
  pass('membership.activated created the client record with a pending intake');

  // 7. Duplicate delivery of the same event id writes nothing twice
  const dup = await sendWebhook('evt_act_a1', 'membership.activated', {
    id: 'mem_a1',
    user_id: 'client_user_a',
    product_id: 'prod_coaching_1',
    plan_id: 'plan_monthly',
  });
  assert.strictEqual(dup.json.status, 'duplicate');
  const rosterDup = await req('GET', '/api/coach/roster', { headers: coachA });
  assert.strictEqual(rosterDup.json.total, 1);
  const recordDup = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(recordDup.json.intake.length, 1);
  pass('Duplicate webhook event is deduped before writes (no second record, no second intake)');

  // 8. Archive only when the LAST live link ends (Flow C)
  await sendWebhook('evt_act_a2', 'membership.activated', {
    id: 'mem_a2',
    user_id: 'client_user_a',
    product_id: 'prod_coaching_2',
    plan_id: 'plan_monthly',
  });
  await sendWebhook('evt_end_a1', 'membership.deactivated', { id: 'mem_a1', user_id: 'client_user_a' });
  let rec = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(rec.json.client.status, 'active', 'One live link remains — record must stay active');
  await sendWebhook('evt_end_a2', 'membership.deactivated', { id: 'mem_a2', user_id: 'client_user_a' });
  rec = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(rec.json.client.status, 'archived');
  pass('Record archives only when the last live membership link ends — and is archived, not deleted');

  // 9. Reactivation reuses the SAME record (Flow A)
  await sendWebhook('evt_act_a3', 'membership.activated', {
    id: 'mem_a3',
    user_id: 'client_user_a',
    product_id: 'prod_coaching_1',
    plan_id: 'plan_monthly',
  });
  rec = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(rec.json.client.id, clientAId);
  assert.strictEqual(rec.json.client.status, 'active');
  assert.ok(rec.json.timeline.some((e: any) => e.type === 'reactivated'), 'Timeline must show the reactivation');
  pass('Reactivation reuses the same record with history intact');

  // 10. payment.failed -> link past_due + membership_past_due flag (Flow B)
  await sendWebhook('evt_pay_fail', 'payment.failed', {
    id: 'pay_1',
    membership_id: 'mem_a3',
    user_id: 'client_user_a',
  });
  rec = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(rec.json.membership_links.find((l: any) => l.whop_membership_id === 'mem_a3').status, 'past_due');
  const inbox1 = await req('GET', '/api/coach/inbox', { headers: coachA });
  assert.ok(
    inbox1.json.open.some((f: any) => f.client_id === clientAId && f.type === 'membership_past_due'),
    'Inbox must carry an open membership_past_due flag'
  );
  pass('payment.failed marks the link past_due and opens a membership_past_due flag');

  // 11. payment.succeeded resolves the past-due state (Flow B)
  await sendWebhook('evt_pay_ok', 'payment.succeeded', {
    id: 'pay_2',
    membership_id: 'mem_a3',
    user_id: 'client_user_a',
  });
  rec = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.strictEqual(rec.json.membership_links.find((l: any) => l.whop_membership_id === 'mem_a3').status, 'active');
  const inbox2 = await req('GET', '/api/coach/inbox', { headers: coachA });
  assert.ok(!inbox2.json.open.some((f: any) => f.client_id === clientAId && f.type === 'membership_past_due'));
  pass('payment.succeeded restores the link to active and resolves the past-due flag');

  // 12. Session notes NEVER reach client endpoints; action items do
  const NOTE = 'SECRET_NOTE_XYZ_private_coaching_note';
  const logRes = await req('POST', `/api/coach/clients/${clientAId}/session-logs`, {
    headers: coachA,
    body: { notes: NOTE, wins: 'SECRET_WIN_XYZ', action_items: [{ text: 'PUBLIC_ACTION_XYZ send the pricing page' }] },
  });
  assert.strictEqual(logRes.status, 201, JSON.stringify(logRes.json));
  const coachRecheck = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.ok(JSON.stringify(coachRecheck.json).includes(NOTE), 'Coach record must contain the note (sanity)');
  const homeA = await req('GET', '/api/me/home', { headers: asClientA });
  assert.strictEqual(homeA.status, 200);
  assert.ok(!homeA.text.includes(NOTE), 'Client home must NOT contain session notes');
  assert.ok(!homeA.text.includes('SECRET_WIN_XYZ'), 'Client home must NOT contain wins');
  assert.ok(homeA.text.includes('PUBLIC_ACTION_XYZ'), 'Client home MUST contain the shared action item');
  const exportA = await req('GET', '/api/me/export', { headers: asClientA });
  assert.ok(!exportA.text.includes(NOTE), 'Client export must NOT contain session notes');
  pass('Session notes and wins are impossible to reach from client endpoints; shared action items arrive');

  // 13. Client submits intake (required validation first)
  const emptySubmit = await req('POST', `/api/me/intake/${responseAId}/submit`, { headers: asClientA, body: { answers: {} } });
  assert.strictEqual(emptySubmit.status, 400);
  const submit = await req('POST', `/api/me/intake/${responseAId}/submit`, {
    headers: asClientA,
    body: { answers: { q_goal: 'First 10k month', q_exp: '2 years' } },
  });
  assert.strictEqual(submit.status, 200, JSON.stringify(submit.json));
  assert.strictEqual(submit.json.intake_response.status, 'submitted');
  pass('Client intake submit validates required fields and lands on the record');

  // 14. Client check-in flow
  const homeA2 = await req('GET', '/api/me/home', { headers: asClientA });
  assert.ok(homeA2.json.checkin?.checkin_id, 'A pending weekly check-in must be waiting in the client home');
  const ciSubmit = await req('POST', `/api/me/checkins/${homeA2.json.checkin.checkin_id}/submit`, {
    headers: asClientA,
    body: { answers: { q_week: 'Solid week' } },
  });
  assert.strictEqual(ciSubmit.status, 200);
  rec = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachA });
  assert.ok(rec.json.checkins.some((c: any) => c.status === 'submitted'));
  pass('Client check-in submits and appends to the coach record');

  // 15. Client isolation: client B cannot touch client A's intake; no coach routes for clients
  await sendWebhook('evt_act_b1', 'membership.activated', {
    id: 'mem_b1',
    user_id: 'client_user_b',
    product_id: 'prod_coaching_1',
    plan_id: 'plan_monthly',
    user_name: 'Client B',
    email: 'b@example.com',
  });
  const roster2 = await req('GET', '/api/coach/roster', { headers: coachA });
  const clientBId = roster2.json.clients.find((c: any) => c.id !== clientAId).id;
  const homeB = await req('GET', '/api/me/home', { headers: asClientB });
  assert.strictEqual(homeB.status, 200);
  assert.ok(homeB.text.includes('Client B') || homeB.json.client.display_name === 'Client B');
  assert.ok(!homeB.text.includes('First 10k month'), "Client B's home must not contain client A's intake answers");
  const crossSubmit = await req('POST', `/api/me/intake/${responseAId}/submit`, {
    headers: asClientB,
    body: { answers: { q_goal: 'intrusion attempt' } },
  });
  assert.strictEqual(crossSubmit.status, 404, 'Client B submitting against client A\u2019s intake must 404');
  const clientCoachRoute = await req('GET', `/api/coach/clients/${clientAId}`, { headers: asClientB });
  assert.strictEqual(clientCoachRoute.status, 403, 'A client token must never reach coach routes');
  pass('Client isolation: B sees only B\u2019s record; cross-client writes 404; coach routes 403 for clients');

  // 16. Derived flags from dates only: intake_missing after 48h grace; goal_stale after 14d
  const recB = await req('GET', `/api/coach/clients/${clientBId}`, { headers: coachA });
  const responseBId = recB.json.intake[0].response.id;
  await db.update('intake_responses', responseBId, { created_at: new Date(Date.now() - 3 * 86400000).toISOString() });
  const goalRes = await req('POST', `/api/coach/clients/${clientAId}/goals`, {
    headers: coachA,
    body: { title: 'Stale goal probe', target: 'Consistency' },
  });
  assert.strictEqual(goalRes.status, 201);
  await db.update('goals', goalRes.json.goal.id, { progress_updated_at: new Date(Date.now() - 20 * 86400000).toISOString() });
  const inbox3 = await req('GET', '/api/coach/inbox', { headers: coachA });
  assert.ok(inbox3.json.open.some((f: any) => f.client_id === clientBId && f.type === 'intake_missing'), 'intake_missing flag expected');
  assert.ok(inbox3.json.open.some((f: any) => f.client_id === clientAId && f.type === 'goal_stale'), 'goal_stale flag expected');
  pass('Flags derive from dates/statuses: intake_missing (48h) and goal_stale (14d) open without reading content');

  // 17. Tenant scoping: coach B (different whop) cannot read coach A's clients
  const ctxB = await req('GET', '/api/me/context', { headers: coachB });
  assert.strictEqual(ctxB.json.role, 'coach');
  const rosterB = await req('GET', '/api/coach/roster', { headers: coachB });
  assert.strictEqual(rosterB.json.total, 0);
  const crossCoach = await req('GET', `/api/coach/clients/${clientAId}`, { headers: coachB });
  assert.strictEqual(crossCoach.status, 404);
  pass('Tenant scoping: coach B sees an empty roster and gets 404 on coach A\u2019s client');

  // 18. Deletion flow: client requests -> coach confirms -> content gone
  const delReq = await req('POST', '/api/me/request-deletion', { headers: asClientB });
  assert.strictEqual(delReq.status, 200);
  const recB2 = await req('GET', `/api/coach/clients/${clientBId}`, { headers: coachA });
  assert.ok(recB2.json.client.deletion_requested_at, 'Coach must see the deletion request on the record');
  const noConfirm = await req('POST', `/api/coach/clients/${clientBId}/delete`, { headers: coachA, body: {} });
  assert.strictEqual(noConfirm.status, 400);
  const del = await req('POST', `/api/coach/clients/${clientBId}/delete`, { headers: coachA, body: { confirm: true } });
  assert.strictEqual(del.status, 200);
  const gone = await req('GET', `/api/coach/clients/${clientBId}`, { headers: coachA });
  assert.strictEqual(gone.status, 404);
  const audit = await db.getAll<any>('audit_log');
  assert.ok(audit.some((a: any) => a.action === 'record_deleted' && a.client_id === clientBId));
  pass('Deletion flow works end to end and leaves an audit tombstone, not content');

  console.log(`\n================================================================================`);
  console.log(`ALL ${passed} TESTS PASSED`);
  console.log(`================================================================================`);
}

run()
  .then(() => {
    server.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n✗ TEST FAILURE:', err);
    server.close();
    process.exit(1);
  });
