# Setting up Team Planner (about 30 minutes, free)

The app already runs on its own in **demo mode** (fake data, nothing saved to the internet).
To go live for your team you connect it to your own Firebase project. Do the steps in order.

## 0. Try it first (no account needed)

```
cd Planner
npm install        # only needed once, for the test tools
npm run serve      # then open http://localhost:8000
```

Demo mode switches itself on while `js/config.js` still says `PASTE_YOUR_...`. Use the buttons on the
login screen to sign in as a Director, Manager, Team Leader, Assistant or Team Member and compare what
each one can do. Demo data lives only in your browser.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**. Name it (for example `smm-planner`).
   Google Analytics is not needed; switch it off.
2. Stay on the free **Spark** plan. Do not add a billing account.
3. **Build > Authentication > Get started > Email/Password > Enable > Save.**
4. **Build > Firestore Database > Create database.** Pick **Production mode**, and a region close to you
   (for example `asia-southeast1` Singapore). The region cannot be changed later.
5. **Project settings (gear icon) > General > Your apps > Web (`</>`)**. Register an app (no hosting).
   Copy the `firebaseConfig` values.

## 2. Paste the configuration

Open `js/config.js` and replace the six `PASTE_...` values with the ones from step 1.5.
These values are not secrets: they only identify your project. The Security Rules (step 4) are what protect the data.

## 3. Allow your website address to sign in

**Authentication > Settings > Authorized domains > Add domain** and add `YOUR-GITHUB-NAME.github.io`
(and your own domain if you use one). `localhost` is already allowed.

## 4. Publish the Security Rules and indexes (do this before anyone signs in)

Easiest with the Firebase CLI:

```
npm install -g firebase-tools
firebase login
firebase use --add            # choose your project
firebase deploy --only firestore:rules,firestore:indexes
```

Without the CLI: copy all of `firestore.rules` into **Firestore > Rules > Publish**. The indexes
(`firestore.indexes.json`) can also be created later: the first time a report or the Activity page needs one,
the browser console shows an error with a link that creates it in one click. Indexes take a few minutes to build.

### Test the rules (strongly recommended, needs Java 11+)

```
npm run test:rules
```

This starts a local copy of Firestore and runs about 70 checks (including the leave and holiday rules), such as "a member cannot change a due date" and
"a change without a log entry is refused". **All checks should pass before you add real people.**
If any fail, please send me the output.

## 5. Create the first Director (one time, by hand)

The app can only create accounts when a Director is already signed in, so the first one is made in the console.

1. **Authentication > Users > Add user.** Enter your email and a password. Copy the **User UID**.
2. **Firestore > Start collection** `users`, Document ID = **the UID you copied**, with these fields exactly:

| Field | Type | Value |
|---|---|---|
| name | string | Your name |
| email | string | The same email |
| role | string | `director` |
| teamIds | array | (empty) |
| active | boolean | true |
| createdAt | timestamp | now |
| lastLoginAt | null | |
| lastLogId | string | `bootstrap` |

3. Open the site and sign in. Then, as Director:
   1. **Statuses > Set up default statuses** (one click, creates Pending, In Progress, In Review, Returned for Rework, On Hold, Blocked, Completed, Cancelled).
   2. **Teams & projects** > create your teams (for example EduEdge, EduGames), then projects.
   3. **People** > add everyone. Give each person a role and team(s). Share the temporary password privately,
      or tick the box that emails them a link to choose their own.

## 6. Put the site on GitHub Pages

1. Create a repository on GitHub and upload the contents of this folder (without `node_modules`; `.gitignore` handles that).
2. **Settings > Pages > Build and deployment > Deploy from a branch > `main` / root > Save.**
3. After a minute the site is at `https://YOUR-GITHUB-NAME.github.io/REPOSITORY/`.

Notes
- On the free GitHub plan Pages needs a **public** repository. That is acceptable here because the page holds no
  private data (your data is in Firebase behind the rules), but do not put passwords or private notes in the repository.
  A private repository with Pages needs a paid GitHub plan.
- To update the app later, upload the changed files; the site refreshes by itself.

## Staying inside the free quota

The free plan allows 50,000 reads and 20,000 writes per day. The app is built to stay far below that for a team of
tens of people: people, teams, statuses and projects are cached in the browser for 30 minutes, only **My tasks**
listens live, and every save is one batched write (task plus its log entry). Use the Firebase console
(**Usage**) to keep an eye on it. If you ever approach the limit, tell me and we will tighten it.

## Backups

## Updating the app later

Each new version changes some files. To update:

1. Copy the new files over your Planner folder, **but keep your own `js/config.js`** (it holds your Firebase settings).
2. Upload the changed files to GitHub (the site refreshes in a minute or two; press Cmd+Shift+R to see it).
3. **Publish the rules again** (`firestore.rules` into Firestore > Rules > Publish) whenever the new version says the rules changed.
4. If a page shows an error that mentions an index, click the link in the browser console (or deploy `firestore.indexes.json`).

### This version (Calendar, Leave, Team overview, Reports, Project owners, My profile and themes)

- **Templates, recurring tasks, tags, "waiting for", alerts and required fields: the rules changed again, so publish
  `firestore.rules` once more** (Firestore > Rules > paste > Publish) **before** you use any of it. Until you do, Templates will
  show "Missing or insufficient permissions", and saving a task with tags or "waiting for" is refused. No new index is needed.
- **Required fields.** A new task now needs a **due date**. To change this, add `taskRules` to `appSettings` in `js/config.js`
  (the app works without it; these are the defaults):

```js
taskRules: {
  requireDueDate: true,        // every new task needs a due date
  requireEstimate: false,      // every new task needs an estimate in hours
  requireEstimateFrom: '',     // ...or only from this priority up: 'medium', 'high' or 'urgent' ('' = never)
  requireProject: false,
  requireDescription: false
}
```

  These are checked by the app when a task is created, not by the database, and older tasks without a due date still open and save normally.
- **Leave and holiday warning.** On **New task** (and when you change an owner or due date), Assistant Team Leaders and above see a
  yellow warning if the due date is a weekend, a public holiday, or a day the owner is on approved leave. It never says what kind
  of leave, and you can still save. Members do not see it (they cannot read their colleagues' leave).
- **Tags.** Up to 8 short tags on a task (type and press Enter). Team tasks and My tasks get an **Any tag** filter, and search also finds tags.
- **Waiting for.** In a task, press **+ Add a task this one waits for** and pick up to 5 tasks of the same team or project. While any
  of them is unfinished the task shows a "Waiting for N" chip, and moving it forward (In Progress, In Review or Completed) asks
  you to confirm first. It is a warning, not a lock. Two tasks cannot wait for each other.
- **Duplicate and add several.** Open a task and press **Duplicate** for a new task with the same details (no due date, steps
  un-ticked). On **New task**, **Add several tasks at once** creates one task per line, for each person ticked (at most 30 in one go).
- **Templates and recurring tasks (Team Leader, Manager, Director).** Open **Templates** > **+ New template**: name, team, the title
  (you can use `{month}`, `{year}` and `{date}`), who gets it (up to 5 people, each gets their own task), steps, tags, due after N
  days, and **Repeats** (weekly, every 2 weeks, monthly, every 3 months, yearly, or not at all). Assistant Team Leaders can start a
  task from a template on **New task** (**Start from a template**). **Use now** on the Templates page does the same.
  - There is no server, so a repeating template makes its task **when a Team Leader, Manager or Director of that team (or the
    Director) opens the app** on or after its date. Open the app on the 1st and the monthly report is waiting.
  - If several dates were missed (for example everyone was on holiday), only the **latest** one is made, not a pile of old tasks.
  - Each occurrence is made once even if two leaders open the app at the same moment (the task gets a fixed id).
  - **Pause** stops it; **Resume** skips the dates that went by. Every run is in the Activity log ("Made a recurring task").
- **Alerts.** The **Alerts** button in the top bar shows tasks someone gave you since you last pressed **Mark new as seen**, tasks that
  are overdue, and tasks due within 2 days. It is worked out from your own open tasks, so it adds no database reads or writes. "Seen" is
  remembered in that browser only. There is no email or phone notification: the free plan has no server to send them.
- Limits worth knowing: the database cannot check each tag's length or what is inside a "waiting for" list (the app does); a task you
  wait for that you have not loaded shows as "Another task"; the template checks run on the day someone opens the app, not at midnight.
- Recommended: run `npm run test:rules` on your Mac. It now also checks the template rules, the tag and "waiting for" fields, and the
  recurring-task write. (I could not run the rules tests in my own environment, so please run them once after publishing and tell me if anything fails.)

- **HR role, yearly leave entitlements and the two-step leave approval: the rules changed, so publish `firestore.rules` again**
  (Firestore > Rules > paste > Publish) **before** you use any of this. Until you do, approving leave, acknowledging leave and
  saving entitlements are refused with "Missing or insufficient permissions". No new index is needed.
- **Make someone HR (one time):** sign in as the Director or a Superuser, open **People**, press **Edit** on the HR person and
  tick **HR access**, then **Save changes**. HR is a switch like Superuser: the person keeps their role and team (put them in a
  normal "HR" team, and they can still be a Team Leader or anything else). Not even a Director gets the HR powers without the tick,
  and only a Director or Superuser can give it. HR people see an **HR leave** page in the menu with a badge for leave waiting to
  be acknowledged.
- **Set the yearly entitlements:** HR opens **HR leave > Entitlements**, picks the year and types the days for annual, medical
  (sick), hospitalization, compassionate and marriage leave. The company-wide table applies to everyone; "Exceptions" lets HR give one
  person different days. "Copy from last year" saves retyping. Training and Other leave are not counted. People then see their own
  balance on the Leave page: entitled, taken (approved), waiting and remaining, counting working days only (weekends and public
  holidays are excluded).
- **How leave is approved now:** a request goes to the **Team Leader first** (status "Waiting for Director" afterwards), then the
  **Director**. When both have approved, the leave is approved and counts everywhere. A Director who approves a request that is
  still waiting for the Team Leader counts only as that first step; the second approval is separate. A Team Leader's or Manager's
  own request skips the first step; a Director's own record is approved at once. A decline needs a reason and ends the request.
- **HR acknowledgement never blocks anything:** leave is already approved once the Team Leader and Director approve. HR only
  sees it under **HR leave > To acknowledge** and presses Acknowledge (or Acknowledge all), after which it shows who acknowledged and when.
  HR can see every approved leave in all teams (read-only) and a balance table for everyone.
- Things to know: a balance that goes below zero is only a warning, it never stops a request; there is no carry-over or
  part-year proration; entitlement exceptions are stored in the same yearly record, so any signed-in person's browser can
  technically read them (the page only shows each person their own).
- Recommended: run `npm run test:rules` on your Mac. It now also checks the two-step leave chain, HR acknowledgement and the entitlement rules.
  (I could not run the rules tests in my own environment, so please run them once after publishing and tell me if anything fails.)

- **Superuser, assigning to several people, and checklist steps: the rules changed, so publish `firestore.rules` again**
  (Firestore > Rules > paste > Publish) **before** you use any of this. Until you do, saving a Superuser or a step given to
  someone is refused with "Missing or insufficient permissions". No new index is needed.
- **Make yourself a Superuser Team Leader (one time):**
  1. Sign in as the Director you use now and open **People**.
  2. Press **Edit** on your own name.
  3. Tick **Superuser access**, change **Role** to **Team Leader**, and tick **your team** under Teams.
  4. Press **Save changes**. Your menu refreshes and still shows People, Teams & projects, Statuses and Reports.
  The order matters: if you change the role first and do not tick Superuser, the save is refused, because that would take
  away your own admin powers. Nobody can switch off their own Superuser access while their role is not Director; ask another
  Director or Superuser. Other Team Leaders stay ordinary Team Leaders: only a Director or a Superuser sees the Superuser
  tick-box, and the database refuses anyone else.
- **Give a task to several people:** on **New task**, an Assistant Team Leader or above (and the owner of the chosen project)
  sees an **Assign to** list. Tick everyone who should get it. One separate task is created for each person, so each can move
  their own copy through the statuses. The button shows how many it will create (for example "Create 3 tasks"). You are ticked
  by default; untick yourself if you are only giving the work out. Very long lists are written in groups of five.
  Choosing who owns a *project* is unchanged (Team Leader and above, on **Teams & projects**).
- **Give checklist steps to people:** in a task, each step has a drop-down: **Anyone**, **Whole team (any one of them)**, or one
  person of the task's team. A person who was given a step (or, for a team step, anyone in the task's team) can open the task,
  tick that step and press **Save**: the app records who did it and when. They cannot change anything else on the task.
  Team tasks shows "N steps for you" next to such tasks, and there is a **Steps for me** filter.
  Limit worth knowing: the database cannot look inside a checklist, so someone allowed to tick steps could in principle also
  tick or un-tick the other steps of that task (never anything else). The page only offers them their own.
- **Credit for checklist steps (no rules change, no new index):** a step counts for the person who ticked it, on their own
  task or on someone else's. **Reports** now show a **Steps done** tile, a **Steps done** column in each person's scorecard (with
  "N for others" when some were on other people's tasks), a **Steps completed** list, and the same in the Excel file (new
  **Steps done** sheet; the People sheet gains Steps done, Steps on others tasks and Steps waiting). Steps ticked before this
  update are credited too, because the app already recorded who ticked each step and when.
  The **Alerts** bell also shows **Steps given to you** (a step someone gave you after you last cleared the alerts). That costs
  one small read per team when the app opens and again when the bell is opened (at most every 2 minutes). Steps given before this
  update carry no "given at" time, so they do not raise an alert. A step's time is not counted in the person's task figures
  such as days to finish or on-time rate: those still belong to the task owner.
- Recommended: run `npm run test:rules` on your Mac. It now also checks Superuser and the step rules. (I could not run the rules
  tests in my own environment, so please run them once after publishing and tell me if anything fails.)

- **My profile:** publish `firestore.rules` (the same publish as for project owners). The new part lets each person save their
  own colour theme on their account. Until the rules are published the theme still works on that device, and the page says
  it could not be saved to the account. Changing a password needs no rules change.
- If **Change password** says "please sign out and sign in again", Firebase wants a recent sign-in: sign out, sign in, retry.
- Files that changed outside the usual ones: `index.html`, `css/themes.css`, and `js/vendor/firebase.js` (rebuilt to include
  the password functions; copy it over too).

- **Project owners: the rules changed again, so publish `firestore.rules` once more** (Firestore > Rules > paste > Publish).
  Until you do, owners will see "Missing or insufficient permissions" on My projects. No new index is needed.
- After publishing, sign in as a Team Leader, Manager or the Director, open **Teams & projects**, edit a project and choose
  its **Project owner** (any person, in any team). The owner then gets **My projects** and a Project view in **Reports**.
  Older projects have no owner until you set one.
- Recommended: run `npm run test:rules` on your Mac (it checks the owner rules, including the exact queries the app runs).

- The rules changed: publish them again, otherwise Leave and Calendar will say "Your role does not allow that action".
- One new index is used (leaves by team and end date). It is in `firestore.indexes.json`.
- New: Reports page (Assistant Team Leader and above). It uses the same rules and indexes as Calendar and Team overview, so
  nothing new needs publishing. Optional: if your financial year does not start in January, add `fiscalYearStartMonth: 4`
  (for April, for example) to `appSettings` so quarters and "year" follow it.
- New: public holidays for Malaysia. After the new files are on GitHub, sign in as the Director, open **Leave**, press
  **Add Malaysian holidays**, keep the years ticked and press **Add**. No rules change is needed for this.
- Optional settings in `js/config.js`, inside `appSettings` (the app works without them):

```js
export const appSettings = {
  appName: 'Planner',
  organisation: 'SMM Education Group',
  weekendDays: [0, 6],   // 0 = Sunday ... 6 = Saturday. Use [5, 6] for Friday and Saturday weekends.
  weekStartsOn: 1,       // 1 = Monday, 0 = Sunday
  fiscalYearStartMonth: 1 // 1 = January. Use 4 if your financial year starts in April (affects Reports)
};
```

## Backups

Firestore on the free plan has no scheduled backup. Phase 4 adds an "Export everything to Excel" button.
Until then, avoid deleting the Firebase project and keep a note of who has console access.


## Mentions, Workload and Weekly summary

- **Publish `firestore.rules` again (needed for mentions).** Mentions add a small `mentions` collection. Until the new rules are
  published, a comment that names someone will be refused. Comments without a mention keep working. Then run `npm run test:rules`
  on your Mac (new "mentions" tests).
- **@mentions:** in a task's comment box type `@` and pick a name (or keep typing the name). Anyone who can read the task can be
  named: the task's team, its owner, whoever created it, the project owner and Directors. At most 5 people per comment. Each person
  named gets "Mentioned you" in their **Alerts** bell until they open it or press **Mark new as seen**. Cost: one small read per
  person when the app opens (and when the bell is opened, at most every 2 minutes), one small write per person named.
  Comments stay permanent and are logged; the log line says who was named.
- **Workload** (Assistant Team Leader and above): hours due in the period against each person's working time (weekends, public
  holidays and approved leave taken out). Pick "rest of this week", "next week", "next 2 weeks" or "rest of this month". Click a
  person to see their tasks and waiting steps. A task with no estimate counts as 0 hours and is flagged. The length of a working
  day is 8 hours; to change it add `workHoursPerDay: 7.5` to `appSettings` in `js/config.js`.
- **Weekly summary** (Assistant Team Leader and above): last week (or this week so far) and the 7 days ahead, in meeting order:
  at a glance, people, finished, overdue, waiting for review, blocked or paused, due soon, who is away. **Copy as text** puts it on
  the clipboard for a chat or email; **Save as PDF** opens the print window. The Notes box is not saved. Reads: each team's open
  tasks, the tasks finished that week and leave, kept for 5 minutes. No new index and no rules change for these two pages.
  The summary also lists key dates in the next 14 days (see below).

## Key dates (Semester starts, Exam week...)

- **Publish `firestore.rules` again (needed for key dates).** They add a `keyDates` collection. Until the new rules are published,
  saving a key date will be refused. Then run `npm run test:rules` on your Mac (new "key dates" tests).
- **Who can add:** Team Leaders and Managers for their own team; the Director and Superusers for any team or for everyone. Members
  and Assistant Team Leaders can see them but not add. Open **Calendar** and press **+ Key date** (or open a day and press
  **+ Key date on this day**). Press a starred chip to edit it. **Remove** switches it off; it stays in the Activity log.
- **Kinds:** one day, or a range (at most 60 days; add a second one for a longer period). **Repeats every year** shows it again each year on
  the same month and day (29 February falls on 28 February in other years). If the real date moves one year, edit it.
- **Where they show:** Calendar (a "Key dates" tick-box turns them off; they carry a star so colour is not the only clue), Home
  ("Key dates ahead", next 30 days), the **Alerts** bell (once, from 3 days before until you press **Mark new as seen**), and the
  Weekly summary (next 14 days). A team's own dates show only to people who can see that team.
- **Alert lead time:** to change the 3 days, add `keyDateAlertDays: 5` to `appSettings` in `js/config.js`.
- **Cost:** one small read of the key dates, kept for 10 minutes and shared by Home, Calendar, Weekly summary and the bell. Writing one
  date is one document plus one activity-log entry.
