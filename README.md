# Team Planner

A task and productivity manager for a team, replacing Excel trackers. Plain HTML, CSS and JavaScript (no build step
for the app itself), Firebase Authentication + Firestore for data, hosted free on GitHub Pages.

**Status:** Phase 0 and Phase 1 (login, roles, tasks, statuses, activity log, people, teams, projects) plus
the Calendar, Leave and Team overview pages are built.
Not built yet: downloadable day/week/month/quarter/year reports, Excel import, bulk creation, recurring tasks.

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

## Calendar, leave and team overview

- **Calendar** (everyone): month and week views of due dates, approved leave and public holidays, filtered by team and
  person. Leaders also see warnings for days that are short-staffed (half the team or more away) or heavy (three or more
  deadlines for each person available), and tasks due while their owner is on leave.
- **Leave** (everyone): members request leave (annual, sick, training, other; full or half days). Team Leaders, Managers
  and the Director approve or decline (a decline needs a reason), record leave for someone, and set public holidays.
  Only approved leave counts. Assistant Team Leaders can see their team's leave but not decide on it.
- **Team overview** (Assistant Team Leader and above): filter by team and person. Status breakdown, workload per person,
  completed per week (on time vs late), on-time rate, 14-day availability grid, needs-attention list, deadlines for the
  next 7 days, and a team roster with last sign-in. Numbers are explained at the bottom of the page.
- **Malaysian public holidays (Kuala Lumpur):** on the Leave page the Director can press "Add Malaysian holidays" to load the
  2026 and 2027 lists (national holidays, plus the Kuala Lumpur ones: New Year's Day, Thaipusam, Federal Territory Day and
  Nuzul Al-Quran, and the replacement days for Sunday holidays). Running it twice never doubles anything, and each holiday can
  still be edited or removed. The dates are in `js/data/holidays-my-kl.js`, taken from the Cabinet Division's gazette tables.
  Dates marked "may move" (Hari Raya, Deepavali) follow the moon, so check them when the government announces changes.
- Leave and holiday changes are written to the activity log like everything else.
- Limits to know: the Director has no team, so cannot request leave; a person in two teams gets one request per team;
  team members cannot see colleagues' leave (sick leave is private to the person and their leaders).

## Folder map

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The web app. `js/config.js` holds your Firebase settings. |
| `js/backend/firebase.js` / `demo.js` | Real backend and the demo backend (same interface). |
| `js/core/` | Data layer (`store.js`), permissions (`perm.js`), model, helpers. |
| `js/ui/` | Screens. |
| `js/data/holidays-my-kl.js` | Bundled Malaysian (Kuala Lumpur) public holidays. Add a new year here each December. |
| `firestore.rules` | The real security. Roles and the log requirement are enforced here. |
| `firestore.indexes.json` | Indexes needed for finished-task and log queries. |
| `tests/rules.test.mjs` | Tests for the rules (`npm run test:rules`). |
| `tests/core.test.mjs` | Tests for the calendar and productivity maths (`npm run test:core`, no Firebase needed). |
| `tools/` | Local server and the script that bundles the Firebase SDK into `js/vendor/firebase.js`. |

## Commands

```
npm install          # once
npm run serve        # http://localhost:8000
npm run test:core    # calendar and productivity maths
npm run test:rules   # rules tests (needs Java and firebase-tools)
npm run build:vendor # only if you upgrade the Firebase SDK
```
