# Staying Current — for the MyHealthAngel engineering team

This repository is the single source of truth for the MyHealthAngel Partner Compliance
Portal. Amber will keep changing the prototype as requirements evolve. Here's how to
stay in sync without guesswork.

## How updates reach you

1. **Amber changes the prototype** (`mha-partner-portal.html`) and/or the docs.
2. The updated file(s) are committed to this repo — a new version is pushed to `main`.
3. **The commit itself is the notification.** GitHub shows exactly what changed,
   line by line, between any two points in time.
4. Every meaningful change also gets a dated entry in **`CHANGELOG.md`** describing
   the intent, so you have the "why," not just the "what."

## How to see what changed

- **Watch the repo:** on GitHub, click **Watch → All Activity** to get notified of every push.
- **Read the diff:** open the newest commit (or compare two commits) to see the exact edits.
  The whole app is one HTML file, so a diff is easy to scan.
- **Read `CHANGELOG.md` first** for a plain-English summary before diving into the diff.

## Where the truth lives

| Question | Look here |
|---|---|
| What does the portal do / how should it behave? | `mha-partner-portal.html` (run it) |
| What changed recently, and why? | `CHANGELOG.md` + the git commit history |
| How do I build the real backend? | `MHA-Portal-Developer-Handoff.md` |
| What's the data model / isolation rules? | `mha-schema.sql` + handoff sections 4–5 |

## Important

- The prototype's behaviour is the spec. If a diff changes a screen or rule, that
  new behaviour is now the requirement — mirror it in the backend build.
- The admin password in the file is a placeholder (`demo1234`). Never commit real
  credentials; they belong in server configuration.
- Keep this repository **private**.

Questions on intent: **compliance@myhealthangel.com**.
