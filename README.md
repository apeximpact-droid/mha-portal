# My Health Angel — Partner & Compliance CRM

This is a standalone, white-labeled fork of the CRM Admin Portal + Partner Portal from Apex Digital Consulting Group's Medicare marketing compliance tool, rebranded for My Health Angel (MHA). It is **not connected to any live backend** — every credential has been stripped and replaced with a `REPLACE_WITH_…` placeholder. A developer needs to stand up a new Supabase project and Cloudflare Worker (or equivalent) before anything in here will run.

## What's in this package

```
admin/
  index.html        — the CRM Admin Portal (single-page app, no build step)
  daybook.html      — the Day Book: the planner + team task list that IS the admin portal's Tasks tab
  worker.js         — the backend Cloudflare Worker both admin pages talk to
  mha-logo.png      — the MyHealthAngel logo (also used by the login card and the Day Book)
  favicon.png       — browser-tab icon (the wings)
partner-client/
  index.html        — the partner-facing portal (partner organizations log in here)
  allegations.html  — a standalone public form (no login) for submitting an allegation/audit request
  mha-logo.png      — same logo file, referenced by both partner pages
  favicon.png
supabase/
  migrations/       — 60 SQL files defining the full database schema, run in filename order
data-export/        — empty (MHA starts with no imported data; kept for parity with the other packages)
```

## What's in the admin portal

- **CRM Admin Portal** — organizations, carriers, marketing materials (with carrier opt-ins, internal status, batch IDs, admin-only updates and files), allegations/audit requests (with audio, SMID documents and email notifications), discussions, operational logins, audit log.
- **Video Submissions** — the Video Submission Builder (scene screenshots, on-screen-text OCR via Claude, Whisper voiceover transcripts, export).
- **Tasks / Day Book** — the Tasks tab is a full planner: day, week and month pages, the team task table (filters, search, paging, "My Tasks / Everyone's Tasks"), a task editor with assignee, dates, status, organization, carrier, links, email thread and file attachments, journal and sticky notes. Task descriptions auto-link URLs. Assignees are emailed when a task is created.
- **1:1 Comparison** — side-by-side document/URL diff with an AI narrative summary.
- **Dark mode by default**, with a sun/moon toggle in the header. The palette comes from the MyHealthAngel logo: gold accents on gray/charcoal.

## What was intentionally removed, and why

Compared with the Apex original, these were removed at MHA's request — both the UI and the backend routes behind them: **Finances** (Apex's internal expense tracker), **Ask Claude** (chat), **Feedback Bot**, and **Precedent Library** (including its rules/scan history). Also removed, as in every white-label fork: the **"Direct Apex Client"** system, which gave some of Apex's *other* clients read-only access to a shared organization's data — an Apex-specific concept with no meaning for MHA running this as its own system.

One pre-existing quirk carried over as-is: there's a "Compliance Workflow" board-sync feature (`renderWorkflowView`, `/monday/*` Worker routes) that's fully built but was already unreachable from the UI in Apex's production app. Safe to ignore, or wire up / delete later.

## Logo

The MyHealthAngel logo (gold wings, gray wordmark) is included as `mha-logo.png` in both folders and referenced by file name from all four pages, with a wings-only `favicon.png` beside it. Keep the PNGs next to the HTML files when hosting. If you'd rather have the pages self-contained, replace `logoDataUri: 'mha-logo.png'` in `admin/index.html`, the `src="mha-logo.png"` in `admin/daybook.html`, and the two `src="mha-logo.png"` in each partner page with a `data:image/png;base64,…` string.

## Setup steps

### 1. Create a new Supabase project

Create a fresh project at supabase.com. Note its **Project URL** and **anon/public key** (Settings → API) — you'll need both later.

### 2. Run the migrations

Run every file in `supabase/migrations/` **in filename order** against your new project (via the Supabase SQL Editor, one at a time, or `supabase db push` with the Supabase CLI if you link the project). **MHA starts with an empty database** — no data is imported from anywhere — so run all 60 files back-to-back, including the last one (`99999999999999_remove_direct_apex_client_feature.sql`, which only exists to tear down an Apex-specific feature; with no data it has nothing to clean up and simply drops the unused tables/columns).

Two things to know:

- `20260828010000_admin_users_allowlist.sql` already contains MHA's admin team (eleven addresses). Only emails on this list can create an admin login, and they are the assignee choices for tasks. To add someone later, run `insert into admin_users (email) values ('name@myhealthangel.com');` — lowercase.
- `20260827020000_allegation_notify_webhook.sql` and `20260901030000_tasks_and_more_admins.sql` carry `REPLACE_WITH_YOUR_WORKER_URL` / `REPLACE_WITH_YOUR_ALLEGATION_WEBHOOK_SECRET` placeholders for the email notification triggers (see step 3b). Fine to run them with the placeholders first and re-run after editing; both are `create or replace function`.

### 3. Data

Nothing to do. The system starts empty; admins add organizations, carriers and materials through the portal. (`data-export/` is an empty folder kept for parity with the other white-label packages.)

### 3b. Email notifications (allegations + tasks)

Every new Allegation/Audit Request (public page or in-portal tab) emails `ALLEGATION_NOTIFY_EMAIL`, and every new task emails its assignee, via Postgres trigger → Worker route → Resend. The Allegations tab also shows a live badge with the count still `Open`/`Investigating`.

1. **Create a Resend account for My Health Angel** at resend.com (free tier is enough). Do not reuse another company's account.
2. In Resend → Domains, add MHA's sending domain and publish the DNS records it gives you (DKIM, SPF, bounce MX). Wait until it shows **Verified**. Resend's default test sender only delivers to the account owner's own address, so a verified domain is required for real delivery.
3. In Resend → API Keys, create a key with sending access. Never commit it.
4. Generate two random secrets (any 40+ character strings). Put one in `20260827020000_allegation_notify_webhook.sql` and one in `20260901030000_tasks_and_more_admins.sql` along with your deployed Worker URL, and run both.
5. Set the matching Worker settings (step 4): `ALLEGATION_WEBHOOK_SECRET`, `TASK_WEBHOOK_SECRET` (must match the migrations exactly), `RESEND_API_KEY`, `ALLEGATION_NOTIFY_EMAIL`, `ALLEGATION_NOTIFY_FROM` and `TASK_NOTIFY_FROM` (both on the verified domain).

Verify: submit a test allegation and create a test task assigned to yourself. If nothing arrives, `select id, status_code, content from net._http_response order by id desc limit 5;` in the SQL Editor shows the trigger's calls to the Worker (401 = secret mismatch, 500 = Resend not configured, no rows = migration not run), and Resend → Emails shows delivery.

### 4. Deploy the Worker

Deploy `admin/worker.js` to Cloudflare Workers (or adapt it — it's a standard `export default { fetch() }` module, no framework dependency). Set these:

| Name | Type | What it is |
|---|---|---|
| `SUPABASE_URL` | Variable | Your new Supabase project's URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Settings → API → `service_role` key (bypasses RLS — server-side only) |
| `STORAGE_SHARED_KEY` | Secret | Any random string you generate — the shared secret between the Worker and `admin/index.html` |
| `ANTHROPIC_API_KEY` | Secret | Powers the Video Submission Builder's on-screen-text OCR and the 1:1 Comparison summary — console.anthropic.com |
| `MONDAY_API_TOKEN` | Secret | Only if you want the Compliance Workflow board-sync working (unreachable from the UI anyway) |
| `ALLEGATION_WEBHOOK_SECRET` | Secret | Must match `20260827020000_allegation_notify_webhook.sql` |
| `TASK_WEBHOOK_SECRET` | Secret | Must match `20260901030000_tasks_and_more_admins.sql` |
| `RESEND_API_KEY` | Secret | The MHA Resend account's API key |
| `ALLEGATION_NOTIFY_EMAIL` | Variable | `compliance@myhealthangel.com` (comma-separate to notify more than one address) |
| `ALLEGATION_NOTIFY_FROM` | Variable | Sender for allegation emails, on the verified domain |
| `TASK_NOTIFY_FROM` | Variable | Sender for task-assignment emails, on the verified domain |

Bindings: a Workers KV namespace bound as `COMPLIANCE_KV`, a Workers AI binding as `AI` (voiceover transcription), and an R2 bucket bound as `VIDEO_R2` (video files and scene screenshots). Read the docstring at the top of `worker.js` for where each is used.

### 5. Configure and host `admin/index.html` + `admin/daybook.html`

Near the top of `admin/index.html`, replace:
```js
var AI_ENDPOINT = "REPLACE_WITH_YOUR_WORKER_URL";
var APEX_STORAGE_KEY='REPLACE_WITH_YOUR_OWN_WORKER_SHARED_KEY';
var SUPABASE_URL = 'REPLACE_WITH_YOUR_SUPABASE_PROJECT_URL';
var SUPABASE_ANON_KEY = 'REPLACE_WITH_YOUR_SUPABASE_ANON_KEY';
```
with your deployed Worker URL, your `STORAGE_SHARED_KEY`, and the Supabase URL + anon key (the admin login uses Supabase Auth with mandatory authenticator-app 2FA). Also set `ALLEGATION_FORM_URL` (search for `REPLACE_WITH_YOUR_PARTNER_PORTAL_DOMAIN`) to where you host the public allegation form. The header already shows `compliance.myhealthangel.com` (`domain:` in the `BRAND` block) — change it if the admin portal ends up somewhere else.

Host `index.html`, `daybook.html`, `mha-logo.png` and `favicon.png` together in the same folder of any static host (Cloudflare Pages, Netlify, S3+CloudFront). The intended address for the admin portal is **https://compliance.myhealthangel.com/**. `daybook.html` needs no configuration of its own — the admin page hands it the Worker URL and key at runtime. Opened directly it shows only the personal planner.

### 6. Configure and host `partner-client/index.html` and `allegations.html`

In **both** files, replace:
```js
var SUPABASE_URL = 'REPLACE_WITH_YOUR_SUPABASE_PROJECT_URL';
var SUPABASE_ANON_KEY = 'REPLACE_WITH_YOUR_SUPABASE_ANON_KEY';
```
with your project's URL and anon/public key (safe for client-side use — it's RLS-protected). Both pages already show `compliance@myhealthangel.com` as the contact address. Host both files plus `mha-logo.png` as static assets. They don't need to share a domain with the admin portal (a subdomain such as `partners.myhealthangel.com` works well); whatever you choose, put it in `ALLEGATION_FORM_URL` in `admin/index.html` so the admin portal's "allegation form" link points at it.

## Quick placeholder checklist

- [ ] `admin/index.html`: `AI_ENDPOINT`, `APEX_STORAGE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLEGATION_FORM_URL`
- [ ] `admin/worker.js` settings: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_SHARED_KEY`, `ANTHROPIC_API_KEY`, `ALLEGATION_WEBHOOK_SECRET`, `TASK_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ALLEGATION_NOTIFY_EMAIL`, `ALLEGATION_NOTIFY_FROM`, `TASK_NOTIFY_FROM`, `MONDAY_API_TOKEN` (optional); bindings `COMPLIANCE_KV`, `AI`, `VIDEO_R2`
- [ ] `supabase/migrations/20260827020000_allegation_notify_webhook.sql` + `20260901030000_tasks_and_more_admins.sql`: Worker URL + webhook secrets
- [ ] `partner-client/index.html`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, compliance email
- [ ] `partner-client/allegations.html`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, compliance email
