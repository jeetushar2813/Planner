# Team Planner

A task and productivity manager for a team, replacing Excel trackers. Plain HTML, CSS and JavaScript (no build step
for the app itself), Firebase Authentication + Firestore for data, hosted free on GitHub Pages.

**Status:** Phase 0 and Phase 1 (login, roles, tasks, statuses, activity log, people, teams, projects) plus
the Calendar, Leave and Team overview pages are built.
Reports, Malaysian holidays and project owners are built too.
Not built yet: Excel import, bulk creation, recurring tasks.

Start with **SETUP.md**.

## What it does today

- Five roles: Director, Manager, Team Leader, Assistant Team Leader, Team Member, each with a login.
- Superuser: a switch on a person's account that gives every Director power while their role stays (for example Team Leader). Only a Director or Superuser can switch it on.
- Task extras: tags, "waiting for" other tasks, Duplicate, add several tasks at once, required fields (a due date by default), and a warning when the owner is on leave or the due date is a weekend or holiday.
- Templates and recurring tasks (weekly, monthly...), made when a Team Leader, Manager or Director opens the app. An Alerts button shows tasks given to you, overdue and due soon.
- HR: a switch on a person's account (set by a Director or Superuser). HR sets the yearly leave entitlements (annual, medical, hospitalization, compassionate, marriage) for everyone, with per-person exceptions, sees every approved leave and a balance table, and acknowledges approved leave. Leave is approved by the Team Leader then the Director; HR's acknowledgement never blocks it.
- A task can be given to several people at once (one task each), and each checklist step can be given to one person or to the whole team. Steps ticked are credited to the person who ticked them in Reports, and a step given to you appears in your Alerts.
- Mention teammates in a comment with @Name; they see it in their Alerts. A Workload page compares hours due with working time for each person, and a Weekly summary page is made for the Monday meeting (copy as text or save as PDF).
- Key dates on the calendar for things that are not tasks and not days off (Semester starts, Exam week, Open day). One-day dates or date ranges, optionally repeating every year, for one team or everyone. Team Leaders and above add them; everyone sees them on the Calendar, on Home ("Key dates ahead"), in the Alerts bell (3 days before) and in the Weekly summary.
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
- **Leave** (everyone): members request leave (annual, sick, training, other; full or half days). The Team Leader approves first, then the Director
  (a decline needs a reason; HR is told for acknowledgement only). Leaders can also record leave for someone, and the Director sets public holidays.
  Only approved leave counts. Assistant Team Leaders can see their team's leave but not decide on it.
- **Team overview** (Assistant Team Leader and above): filter by team and person. Status breakdown, workload per person,
  completed per week (on time vs late), on-time rate, 14-day availability grid, needs-attention list, deadlines for the
  next 7 days, and a team roster with last sign-in. Numbers are explained at the bottom of the page.
- **Reports** (Assistant Team Leader and above): a weekly, monthly, quarterly, yearly or custom-date report for a team or one
  person, to use in progress meetings. It has headline figures compared with the previous period, tasks completed on time and
  late, individual scorecards, a project breakdown, the tasks completed and still open, and leave and public holidays. Save it
  as PDF (the browser's print window, choose "Save as PDF") or download it as an Excel workbook with a sheet for each part and
  every task listed. Quarters follow the calendar year unless `fiscalYearStartMonth` is set in `js/config.js`.
- **Project owners** (any person, in any team): a Team Leader, Manager or the Director sets one owner per project in
  Teams & projects. The owner sees every task in that project, even tasks held by people in other teams, can create tasks
  for anyone and reassign tasks, and approves or sends back work that is in Review. They cannot edit other people's task
  details (title, description, dates, priority, checklist) or archive anything. The **My projects** page shows the owner's
  open tasks, work waiting for review (Approve / Send back), who is carrying what, and "Handed to others" (open tasks the
  person created for someone else). Reports has a **Project** view for owners (the Director can pick any project).
  A task always belongs to the team of the person who gets it, so giving work to someone in another team moves the task
  into that team. People can also always see tasks they created for someone else.
- **My profile** (everyone; click your name in the sidebar): your details, **change your own password** (you type your
  current one first, so the Director does not need to send a reset email), and a **colour theme** picker: Match my device,
  Light, Dark, Corporate, Monochrome blue, Slate, Colourful, Purple, Midnight purple and Forest. The choice is saved on your
  account (so it follows you to other devices) and in the browser (so it shows before you sign in). Password changes are
  noted in the activity log; the password itself is never stored there. The colours live in `css/themes.css`.
- **Malaysian public holidays (Kuala Lumpur):** on the Leave page the Director can press "Add Malaysian holidays" to load the
  2026 and 2027 lists (national holidays, plus the Kuala Lumpur ones: New Year's Day, Thaipusam, Federal Territory Day and
  Nuzul Al-Quran, and the replacement days for Sunday holidays). Running it twice never doubles anything, and each holiday can
  still be edited or removed. The dates are in `js/data/holidays-my-kl.js`, taken from the Cabinet Division's gazette tables.
  Dates marked "may move" (Hari Raya, Deepavali) follow the moon, so check them when the government announces changes.
- Leave and holiday changes are written to the activity log like everything else.
- Leave balances (entitled, taken, waiting, remaining) use the HR entitlement table and count working days only.
- Limits to know: the Director has no team, so cannot request leave; a person in two teams gets one request per team;
  team members cannot see colleagues' leave (sick leave is private to the person and their leaders).

## Folder map

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The web app. `js/config.js` holds your Firebase settings. |
| `js/backend/firebase.js` / `demo.js` | Real backend and the demo backend (same interface). |
| `js/core/` | Data layer (`store.js`), permissions (`perm.js`), model, helpers. |
| `js/ui/` | Screens. |
| `js/ui/profile.js`, `js/core/theme.js`, `css/themes.css` | My profile page, and the colour themes. |
| `js/ui/projects.js` | The My projects page for project owners. |
| `js/core/report.js`, `reportExport.js`, `xlsx.js` | Report maths, the Excel sheets, and a small Excel file writer (no libraries). |
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
