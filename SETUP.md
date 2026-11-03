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

### This version (Calendar, Leave, Team overview)

- The rules changed: publish them again, otherwise Leave and Calendar will say "Your role does not allow that action".
- One new index is used (leaves by team and end date). It is in `firestore.indexes.json`.
- New: public holidays for Malaysia. After the new files are on GitHub, sign in as the Director, open **Leave**, press
  **Add Malaysian holidays**, keep the years ticked and press **Add**. No rules change is needed for this.
- Optional settings in `js/config.js`, inside `appSettings` (the app works without them):

```js
export const appSettings = {
  appName: 'Planner',
  organisation: 'SMM Education Group',
  weekendDays: [0, 6],   // 0 = Sunday ... 6 = Saturday. Use [5, 6] for Friday and Saturday weekends.
  weekStartsOn: 1        // 1 = Monday, 0 = Sunday
};
```

## Backups

Firestore on the free plan has no scheduled backup. Phase 4 adds an "Export everything to Excel" button.
Until then, avoid deleting the Firebase project and keep a note of who has console access.
