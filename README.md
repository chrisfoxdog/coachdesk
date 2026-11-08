# CoachDesk — The Client Record for Whop Coaches

CoachDesk gives every coaching client a real record inside the coach's own Whop — intake, goals, session notes, check-ins, and full history — created automatically the moment they buy, and archived automatically when they leave.

**Your client notes stay your client notes.** CoachDesk has no AI features and no AI configuration: no part of any client record is ever sent to an AI service. Needs-attention flags are computed from counts, dates, and statuses only — never from reading what anyone wrote.

Built by Elite Software Studio. Stack follows the proven Elite pattern (AutoCash AI / Nexus Terminal): React 19 + Vite + Tailwind CSS v4, Express, Postgres in production / local JSON store in development, JWKS-verified Whop identity, HMAC-verified idempotent webhooks.

## How it works

- **A client record is born from a webhook, not a form.** `membership.activated` creates the record and opens the product's intake form as *pending* for the client. If the client cancels and later rejoins, the **same record reactivates** with its history intact.
- **Two roles, two scopes.** The coach's queries are scoped to their tenant (`coach_id`). A client's home resolves from their verified Whop token to exactly one record — their own. There is no client route that accepts a record ID.
- **Session notes are coach-private, hard-fixed.** Session logs carry `visibility: 'coach_only'` in the data model; client endpoints never query them, so notes and wins cannot leak to a client screen or export.
- **Cancellation archives; it never deletes.** A record archives only when the client's *last* live membership link ends. Deletion is a deliberate, confirmed, audit-logged act (per record, or whole account), and it never touches Whop-side data — CoachDesk stores no card or payment data, ever. Payment status is shown exactly as Whop reports it (`active` / `trialing` / `past_due` / `cancelled` / `ended`); no balances are computed.
- **Flags are derived state.** `intake_missing` (pending 48h+), `checkin_missed`, `goal_stale` (no progress update in 14 days by default, coach-set), and `membership_past_due` are computed on read from dates/statuses/counts and deduped per (client, type, period).

## Setup

```bash
npm install
cp .env.example .env   # fill in the values below
npm run dev            # API server on :3000 (tsx)
npx vite               # frontend dev server (proxies /api to :3000)
```

Local development identity: with `NODE_ENV` not set to `production`, the API accepts an `x-whop-dev-user-id` header (the frontend takes `?dev_user=<whop user id>` once and stores it in sessionStorage). **In production this fallback is disabled and identity comes only from the verified Whop token** — failures fail closed with 401, and a database failure returns `503 DATABASE_UNAVAILABLE` rather than crashing or serving placeholder data.

### Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon in production). **Required in production** — the server refuses to start without it. |
| `WHOP_API_KEY` | Whop app API key (developer dashboard). |
| `WHOP_WEBHOOK_SECRET` | Webhook signing secret (`whsec_…`), shown once when the webhook is created. |
| `WHOP_APP_ID` | The CoachDesk Whop app ID. |
| `WHOP_COMPANY_ID` | The whop (company) the app is installed into — resolves the coach tenant. |
| `APP_URL` | Public URL of this deployment (used to build the webhook URL). |
| `NODE_ENV` | `production` on the host. |
| `PORT` | Set by the host (Render); defaults to 3000. |

## Webhook setup

In the Whop developer dashboard, point the app's webhook at:

```
POST {APP_URL}/api/webhooks/whop
```

Subscribe to the membership and payment lifecycle events CoachDesk reacts to:

- `membership.activated` — create / reactivate the client record (Flow A)
- `membership.updated` — refresh the membership snapshot
- `membership.deactivated` — archive when the last live link ends (Flow C)
- `payment.succeeded` — link back to `active`, past-due flag resolved (Flow B)
- `payment.failed` — link `past_due` + `membership_past_due` flag (Flow B)
- `refund.created` — noted on the record timeline

Signatures are verified with HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}` (the `whsec_` secret is base64-decoded per the standard-webhooks format); timestamps older than 5 minutes are rejected, bad signatures get a 401, and every event is deduplicated on its Whop event ID **before** any writes.

## Production deploy (Render — mirrors AutoCash AI's shape)

- **Build command:** `npm install && npm run build` (Vite build + esbuild server bundle → `dist/`)
- **Start command:** `npm start` (`node dist/server.js`)
- **Environment:** set all variables from the table above in the Render dashboard. `DATABASE_URL` points at Neon (one database per app). Secrets are entered in the host's env form only — never in the repo.
- The server serves the built frontend from `dist/` and the API from the same process, so the app works at a single origin inside the Whop iframe.
- Free-tier hosts sleep when idle; the frontend shows an honest "waking the server" state on slow first loads.

## Tests

```bash
npm test
```

Node test suite (`tests/coachdesk.test.ts`) running against a throwaway JSON store: webhook signature rejection, Flows A/B/C (create, reactivate-same-record, archive-on-last-link, past-due flag + resolution), duplicate-event dedupe, client isolation, session-notes secrecy across every client endpoint, tenant scoping between two coaches, derived flags, and the deletion flow.

## Project layout

```
server.ts            Express app: health, webhook route, identity, coach + client APIs
server/db.ts         Entity types + store (Postgres JSONB tables / dev JSON file)
server/whop.ts       JWKS token verification, HMAC webhook verification, Flows A/B/C
server/flags.ts      Derived needs-attention engine + check-in lifecycle
server/constants.ts  Consent template, program-week / check-in period math
src/                 React frontend (coach app + separate client-home component family)
tests/               Guardrail + flow test suite
```
