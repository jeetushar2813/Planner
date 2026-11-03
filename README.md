# Team Planner

A task and productivity manager for a team, replacing Excel trackers. Plain HTML, CSS and JavaScript (no build step
for the app itself), Firebase Authentication + Firestore for data, hosted free on GitHub Pages.

**Status:** Phase 0 and Phase 1 are built (login, roles, tasks, statuses, activity log, people, teams, projects).
Not built yet: calendar (Phase 2), productivity measures and day/week/month/quarter/year reports (Phase 3),
Excel import, bulk creation, recurring tasks (Phase 4).

Start with **SETUP.md**.

## What it does today

- Five roles: Director, Manager, Team Leader, Assistant Team Leader, Team Member, each with a login.
- Tasks with owner, team, project, priority, start and due dates, checklist, comments and a status note.
- Customisable statuses grouped into categories (to do, active, review, paused, done, closed). Overdue is worked out automatically.
- My tasks (live), Team tasks (list and board with drag-and-drop), filters and search.
- Members update progress on their own tasks only. Leaders and above assign, edit, approve and archive. The Assistant cannot change deadlines or archive.
- An approval gate per team: members stop at In Review until a leader completes the task (can be switched off per team).
- Activity log of every change (who, what, from, to, when). It can never be edited or deleted, and each change is
  refused by the database unless its log entry is saved with it. A "Who is using the tool" panel shows last sign-ins.

## Folder map

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The web app. `js/config.js` holds your Firebase settings. |
| `js/backend/firebase.js` / `demo.js` | Real backend and the demo backend (same interface). |
| `js/core/` | Data layer (`store.js`), permissions (`perm.js`), model, helpers. |
| `js/ui/` | Screens. |
| `firestore.rules` | The real security. Roles and the log requirement are enforced here. |
| `firestore.indexes.json` | Indexes needed for finished-task and log queries. |
| `tests/rules.test.mjs` | Tests for the rules (`npm run test:rules`). |
| `tools/` | Local server and the script that bundles the Firebase SDK into `js/vendor/firebase.js`. |

## Commands

```
npm install          # once
npm run serve        # http://localhost:8000
npm run test:rules   # rules tests (needs Java and firebase-tools)
npm run build:vendor # only if you upgrade the Firebase SDK
```
