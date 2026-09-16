# Changelog — MyHealthAngel Partner Compliance Portal

All notable changes to the prototype are recorded here. Newest first.
Whoever changes the portal should add a dated entry describing what changed and why,
so the engineering team can track intent alongside the git diff.

Format: `YYYY-MM-DD — summary`. Keep entries short; the git history holds the detail.

---

## v1.0 — 2026-07-22 — Baseline handed to engineering

First complete prototype. Feature- and behaviour-complete; storage is browser-only
(`localStorage`, namespace `mha_`) pending a real backend.

**Roles & access**
- Admin and partner logins; role-based navigation and routing.
- Remember-me (persistent vs. session login, 30-day cap).
- Per-partner data isolation — a partner only sees materials shared with them.

**Admin — client management**
- Create / edit / activate / deactivate / delete partner logins with assigned passwords.

**Admin — creative items**
- Create / edit / delete materials; all compliance fields entered manually.
- "Annual Re-Submission" flag (checkbox for admin, shown to partners as Yes/No).
- Carrier opt-ins: one row per carrier, each with its own opt-in confirmation file.
- Upload PDF / Excel / Word / image documents per material.
- Per-client visibility toggles control who can see each material.
- Creative dashboard: view a material and Edit / Delete from inside it.
- Admin-side export (CSV + documents) with select-one or select-all, plus a
  "Shared With" column listing partner organizations.

**Partner side**
- Home dashboard with summary cards and a **Recent Updates** feed (new assignments,
  admin replies, status changes) — scoped to that partner only.
- Creatives list: search, filter, sort; shows all carrier opt-ins; Annual Re-Submission column.
- Material detail: Asset / Dates / HPMS / Associated Files, plus opt-in confirmations.
- Per-partner status + status history (a partner's status never affects another's or MHA's).
- Private discussion threads (each partner's thread with MHA is private to them).
- Export: per-material checkboxes (single or bulk) for CSV summary and documents.

**Compliance / audit**
- Append-only audit log: access grants/revocations, status changes, document
  add/remove, item and client lifecycle. Filterable, CSV-exportable. Historical
  assignments backfilled and labelled as such.

**Security posture (prototype)**
- Admin password is a placeholder (`demo1234`) — real auth belongs on the backend.
- See `MHA-Portal-Developer-Handoff.md` for what must move server-side.

---

## Template for future entries

```
## vX.Y — YYYY-MM-DD — short title
- what changed
- why / what it affects
- any follow-up the backend needs
```
