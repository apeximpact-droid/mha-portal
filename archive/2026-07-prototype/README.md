# MyHealthAngel — Partner Compliance Portal

Prepared by Apex Digital Consulting Group for **My Health Angel**.

This repository contains a working front-end prototype of a partner compliance portal,
plus everything an engineering team needs to build it into a live, secure, multi-user system.

> **This is a separate, self-contained project.** It shares no code, data, or storage with any
> other client's portal. Keep this repository private.

## Contents

| File | Purpose |
|---|---|
| `mha-partner-portal.html` | The working prototype. Double-click to run — no server or build step. **This is the specification.** |
| `MHA-Portal-Developer-Handoff.md` | Architecture, data model, authorization rules, API surface, security requirements, and acceptance tests. |
| `mha-schema.sql` | Reference Postgres/Supabase schema with row-level security enforcing per-partner isolation. |
| `CHANGELOG.md` | Dated log of changes to the prototype. Read this first to see what's new. |
| `STAYING-CURRENT.md` | How the engineering team tracks ongoing changes via git + the changelog. |

## Try the prototype

Open `mha-partner-portal.html` in a browser.

- **Admin:** `amorman@myhealthangel.com` / `demo1234`
- **Demo partner:** `partner@demo.com` / `demo1234`
- A second demo partner (`summit@demo.com` / `summit1234`) exists to show isolation between partners.

The password in the file is a **placeholder** for demonstration. Real credentials must never
live in front-end source — see the handoff document.

## Important: what this prototype is

It is **feature- and behaviour-complete** — treat every screen, field, and workflow as the spec.
It is **not deployable as-is**: all data lives in the visitor's own browser (`localStorage`), so
nothing is shared between users until a real backend is built underneath it. Start with the
handoff document, section 2.

## For the engineer — start here

1. Read `MHA-Portal-Developer-Handoff.md` in full.
2. Stand up `mha-schema.sql` on a scratch database and run its smoke test (bottom of file).
3. Follow the build order in handoff section 11 — security first.
4. The acceptance tests in handoff section 10 define "done."

## Security note

- Keep this repository **private**.
- Never commit real passwords, API keys, or database credentials.
- Questions on intended behaviour: **compliance@myhealthangel.com**.
