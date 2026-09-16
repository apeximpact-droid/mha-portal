# MyHealthAngel Partner Compliance Portal — Developer Handoff

**Prepared for:** MHA engineering team
**Prepared by:** Apex Digital Consulting Group
**Contact:** amorman@myhealthangel.com

---

## 1. What you're receiving

| File | What it is |
|---|---|
| `mha-partner-portal.html` | A complete, working front-end prototype. **This is the specification.** |
| `mha-schema.sql` | Reference database schema + row-level security policies (Postgres/Supabase) |
| This document | Architecture, rules, API surface, and build checklist |

**To run the prototype:** double-click the HTML file. No server, no build step, no dependencies.

- Admin login: `amorman@myhealthangel.com` / `demo1234`
- Demo partner login: `partner@demo.com` / `demo1234`
- A second demo partner (`summit@demo.com` / `summit1234`) exists to demonstrate isolation between partners.

> The password in the file is a throwaway placeholder. Real credentials must never live in front-end source.

---

## 2. Read this first — what the prototype is and is not

The prototype is **feature-complete and behaviour-complete**. Every screen, field, label, workflow, and business rule is implemented and working. Treat it as the functional spec: if there's ever a question about how something should look or behave, the answer is "the way the prototype does it."

**What it is not** is a system that can be deployed. All data lives in the visitor's own browser (`localStorage`). If you host the file as-is:

- Materials the admin uploads save to the *admin's* browser only
- Each partner sees only the seeded demo data, not real materials
- Nothing is shared between users; every visitor gets a private sandbox

**Your job is to replace the storage and security layer underneath a finished interface.** The UI, styling, screen flow, and business logic carry over essentially unchanged.

---

## 3. Architecture target

```
Browser (existing HTML/CSS/JS, largely unchanged)
   │  HTTPS + session cookie
   ▼
API layer  ── enforces AuthN + AuthZ on every request
   │
   ├── Database        (partners, materials, shares, messages, statuses, audit)
   └── Object storage  (documents; served via short-lived signed URLs)
```

**The single most important design rule:** the browser is never trusted. The prototype currently filters what a partner can see *in JavaScript* (`clientCreatives()`). That is presentation only. In production, the **server** must decide what a partner is allowed to receive, before it sends a single byte. A partner requesting a material they don't have access to must get a 403/404 — not a filtered-out result.

---

## 4. Data model

The prototype stores nested JSON. Below is the normalized equivalent. Full DDL is in `mha-schema.sql`.

### `organizations` — partner companies
| Column | Notes |
|---|---|
| id | PK |
| name | e.g. "Bright Path Marketing" |
| active | false blocks login immediately |
| created_at | |

### `users` — login accounts
| Column | Notes |
|---|---|
| id | PK |
| email | unique |
| password_hash | bcrypt/argon2 — **never** plain text |
| role | `admin` \| `partner` |
| org_id | FK → organizations; NULL for admin |
| active, created_at, last_login_at | |

### `materials` — creative assets
| Column | Prototype field |
|---|---|
| id | `id` |
| smid | `smid` |
| status | `status` (MHA's own status) |
| plan_year | `py` |
| classification | `classification` — Marketing \| Communications |
| is_annual_resubmission | `annual` (boolean → shown to partners as Yes/No) |
| medium, benefit_type, distribution_area | `medium`, `benefit`, `dist` |
| time_period, election_period | `period`, `election` |
| start_date, end_date, hpms_filing_date | `start`, `end`, `filing` |
| media_type | `mediaType` |
| created_at, updated_at | `updated` |

### `material_carrier_optins` — one row per carrier
| Column | Notes |
|---|---|
| id, material_id | |
| carrier | e.g. "UnitedHealthcare" |
| opted_in | boolean → shows as ✓ or "pending" |
| optin_date | |
| confirmation_file_id | FK → material_files (the screenshot/PDF proving the opt-in) |

A material can have **many** carrier opt-ins. The UI lists them all.

### `material_files` — documents
| Column | Notes |
|---|---|
| id, material_id | |
| file_name, category | category e.g. "Clean & Final", "HPMS Opt-In" |
| storage_path | object-storage key — **not** a public URL |
| uploaded_by, uploaded_at | |

Accepted types: PDF, DOCX/DOC, XLSX/XLS, PNG/JPG/GIF/WEBP.

### `material_shares` — which partners can see what
| Column | Notes |
|---|---|
| material_id, org_id | composite PK |
| shared_at, shared_by | drives the partner's "Recent Updates" feed |

**This table is the access control list.** Presence of a row = access. Deleting the row = revocation.

### `material_org_status` — per-partner status
| Column | Notes |
|---|---|
| material_id, org_id | composite PK |
| status | Submitted \| In Review \| Approved \| Will Not Use |
| updated_at | |

Each partner tracks a material through **their own** internal compliance process. This is deliberately separate from `materials.status` (MHA's status). If no row exists, the partner sees MHA's status as the default.

### `material_status_history`
| Column | Notes |
|---|---|
| id, material_id | |
| org_id | NULL = an MHA/admin-level change |
| from_status, to_status, changed_by, changed_at | |

Partners see MHA's history merged with **their own** entries — never another partner's.

### `messages` — private threads
| Column | Notes |
|---|---|
| id, material_id, org_id | |
| author_type | `admin` \| `partner` |
| author_name, body, created_at | |

**Every message belongs to exactly one (material, org) pair.** Two partners with access to the same material have two entirely separate conversations. Neither can see the other's messages, nor MHA's replies to the other.

### `audit_log` — append-only
| Column | Notes |
|---|---|
| id, occurred_at | |
| actor_type, actor_name | |
| kind | `access` \| `status` \| `file` \| `item` \| `client` |
| action | e.g. "Access granted", "Document removed" |
| target | SMID or organization name |
| detail, material_id, org_id | |
| backfilled | true = reconstructed, date-only, no time |

No UPDATE or DELETE. Ever.

---

## 5. Authorization rules — build these first

These are the rules most likely to be implemented incorrectly, and the ones with real consequences. **Write automated tests for each.**

Let `O` = the authenticated partner's `org_id`.

| # | Rule |
|---|---|
| 1 | A partner may read a material **only if** a `material_shares` row exists for (material, `O`). |
| 2 | A partner may read a material's files/opt-ins **only if** rule 1 passes for that material. |
| 3 | A partner may read messages **only where** `messages.org_id = O`. |
| 4 | A partner may read/write `material_org_status` **only where** `org_id = O`. |
| 5 | A partner may read status history where `org_id = O` **or** `org_id IS NULL` (MHA-level). Never another org's. |
| 6 | A partner may never read `organizations`, `users`, `audit_log`, or any other org's rows. |
| 7 | Deleting a `material_shares` row revokes access **immediately**, including in-flight file URLs where practical. |
| 8 | An inactive `organization` or `user` cannot authenticate. |
| 9 | Admin may read/write everything, except `audit_log` which is insert + read only. |

**Enforce these server-side.** If you use Postgres, the supplied RLS policies enforce them at the database level, which is the most reliable place — a bug in application code then can't leak data.

---

## 6. API surface implied by the UI

Names are indicative; shape matters more than spelling.

**Auth**
```
POST   /auth/login                 → sets httpOnly session cookie
POST   /auth/logout
GET    /auth/me                    → { role, org }
POST   /auth/invite                (admin) emails a set-password link
POST   /auth/set-password          (token from invite / reset)
```

**Admin — organizations**
```
GET    /orgs
POST   /orgs
PATCH  /orgs/:id                   (rename, activate/deactivate)
DELETE /orgs/:id
```

**Admin — materials**
```
GET    /materials                  (all)
POST   /materials
GET    /materials/:id
PATCH  /materials/:id
DELETE /materials/:id
POST   /materials/:id/files            multipart upload
DELETE /materials/:id/files/:fileId
PUT    /materials/:id/optins           replace opt-in set
POST   /materials/:id/shares           { org_id }   → grant
DELETE /materials/:id/shares/:orgId                 → revoke
GET    /materials/:id/messages?org_id=…
POST   /materials/:id/messages         { org_id, body }
GET    /audit?kind=&q=&from=&to=
GET    /audit/export.csv
```

**Partner** — all implicitly scoped to the caller's org
```
GET    /materials                      only shared with caller
GET    /materials/:id                  403/404 if not shared
GET    /materials/:id/files/:fileId    → 302 to signed URL (≤5 min TTL)
PATCH  /materials/:id/status           own org status only
GET    /materials/:id/messages         own thread only
POST   /materials/:id/messages
GET    /exports/summary.csv            own materials only
```

---

## 7. Replace-this-with-that checklist

Keyed to actual identifiers in `mha-partner-portal.html`.

| In the prototype | Replace with |
|---|---|
| `const DB = { load, save }` (localStorage) | API client — `fetch` calls to the endpoints above |
| `const ADMIN = {email, password}` | `users` row, role `admin`, hashed password |
| `seed()`, `migrate()`, `backfillAudit()` | One-time data migration script, then delete |
| `clientCreatives()` — browser-side filter | **Delete.** Server returns only permitted materials |
| `statusFor(c, cid)` | Read from `material_org_status`, fall back to `materials.status` |
| `getThread(c, cid)` | `GET /materials/:id/messages` — server-scoped |
| `f.dataUrl` base64 blobs | `storage_path` + signed URL |
| `downloadFile()`, `downloadOptin()` | Fetch signed URL, then download |
| `logAudit()` | Server-side insert; client cannot write audit rows |
| `saveSession()` / `loadSession()` / remember-me | httpOnly, Secure, SameSite cookie; server-side session or short-lived JWT + refresh |
| `exportCsvFor()`, `exportDocsFor()` | Keep client-side rendering, but source data from the API. Consider a server-generated ZIP to replace the multi-file download |
| localStorage quota guard in `DB.save` | Remove — no longer applicable |

**Keep as-is:** all HTML structure, all CSS, and the render functions (`renderHome`, `renderCreatives`, `renderDetail`, `renderItemView`, `renderItemEditor`, `renderAudit`, etc.). They only need their data source swapped.

---

## 8. Security requirements

- **TLS everywhere.** HSTS on.
- **Password hashing:** bcrypt (cost ≥ 12) or argon2id. Admin should not set partner passwords manually — send an invite link and let the partner set their own.
- **Sessions:** httpOnly + Secure + SameSite=Lax cookies. "Remember me" = longer-lived refresh token, server-revocable, 30-day cap (matches prototype behaviour).
- **MFA on admin accounts.** The admin controls every partner's access; it's the highest-value target.
- **Rate-limit** login and password-reset endpoints.
- **File downloads:** signed URLs, ≤5 minute TTL, generated per request. Never expose bucket paths or make the bucket public.
- **Upload validation:** verify MIME type and extension, cap file size, scan for malware, strip metadata where appropriate.
- **Audit log:** INSERT and SELECT only. No UPDATE/DELETE grants, even for admin.
- **Backups** with tested restores.

---

## 9. Compliance notes specific to this system

- The portal holds **Medicare marketing materials and carrier opt-in records**. These are generally *not* PHI, so HIPAA likely does not attach to the current scope.
- **If beneficiary data is ever introduced** — lead lists, Scope of Appointment forms, enrollment records — that changes: you'd need a signed BAA with the hosting/storage vendor and stricter controls. Confirm scope before launch.
- **Carrier agreements** (UnitedHealthcare and others) may impose their own data-handling and confidentiality obligations on the TPMO. Review those before selecting a host.
- **Retention:** CMS marketing-material retention obligations mean deletion must be deliberate and logged. Soft-delete materials rather than hard-deleting, and never purge `audit_log`.

---

## 10. Acceptance tests

The build isn't done until these pass. Tests 1–4 are the ones that matter most.

1. **Cross-partner read blocked.** Authenticated as Partner A, request a material ID shared only with Partner B → 403/404. Confirm it fails at the API, not just the UI.
2. **Message privacy.** Share one material with both partners. Post an MHA reply to each. Partner A sees only their thread; Partner B sees only theirs. Verify at the API response, not the screen.
3. **Status independence.** Partner A sets "Will Not Use." Partner B's view and MHA's status are unchanged.
4. **Revocation is immediate.** Remove a share; Partner A's next request for that material and its files fails. Previously issued signed URLs expire.
5. **Deactivation.** Deactivate an organization → its users cannot log in.
6. **File URLs expire** and cannot be replayed after TTL.
7. **Audit integrity.** Grant then revoke access; both events appear. Attempt UPDATE/DELETE on `audit_log` → denied.
8. **Backfill labelling.** Migrated historical grants display as "backfilled" and are not presented as precise timestamps.

---

## 11. Suggested build order

1. Database + RLS policies (`mha-schema.sql`)
2. Auth: login, sessions, invite/set-password, admin MFA
3. Read-only partner path: materials list → detail → file download. **Prove tests 1, 2, 6 here.**
4. Admin CRUD: materials, orgs, shares, uploads
5. Messages, per-partner status, audit log
6. Exports
7. Migration of any existing prototype data, then delete `seed()`/`migrate()`/`backfillAudit()`

---

## 12. Open decisions for MHA

- Does a partner set their own password via invite (recommended), or does admin assign one?
- Should MHA see partner-set statuses only, or be able to override them?
- Bulk document download: server-generated ZIP, or keep individual downloads?
- Retention period for audit entries and soft-deleted materials?
- Email notifications when a material is shared — in scope for v1?

---

*Questions on intended behaviour: amorman@myhealthangel.com. When in doubt, the prototype is the source of truth.*
