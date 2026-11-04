// The app's data layer. Every screen reads and writes through here.
//
// Quota design (Firebase free plan):
//  - People, teams, statuses and projects are cached in the browser for
//    REFDATA_TTL_MINUTES and only re-read on request or after the cache expires.
//  - Task screens read only what they show (open tasks for one team or one person).
//  - Only "My Tasks" listens live. Everything else loads once, with a Refresh button.
//  - One Save = one batched write (the change plus its log entry), never many small ones.

import { firebaseConfig } from '../config.js';
import {
  INITIAL_STATUS_ID, OPEN_CATEGORIES, REFDATA_TTL_MINUTES, DEFAULT_STATUSES,
  PRIORITY_LABEL, ROLE_LABEL, LEAVE_TYPES, LEAVE_TYPE_LABEL, LEAVE_STATUS_LABEL, HALF_LABEL, ENTITLED_TYPES
} from './model.js';
import { diffFields, summarize, taskAction } from './log.js';
import { todayISO, toDate } from './util.js';
import * as perm from './perm.js';
import { deriveStepFields, cleanSteps, dropOutsiders, stampSteps } from './steps.js';
import { groupLeaves, buildPolicy } from './entitlement.js';
import { applyTheme, isTheme } from './theme.js';
import { cleanTags } from './tags.js';
import { MAX_BLOCKERS } from './deps.js';
import { missingForNew } from './taskrules.js';
import { validateKeyDate, KEY_CATEGORY_LABEL } from './keydates.js';
import { findMentions, snippetOf, MAX_MENTIONS } from './mentions.js';
import { dueOccurrence, occurrenceTaskId, dueDateFor, MAX_TEMPLATE_OWNERS, REPEATS } from './recurrence.js';

let backend = null;

export const state = {
  user: null,                       // the signed-in person's staff record
  ref: { users: [], teams: [], statuses: [], projects: [], loadedAt: null },
  tasks: new Map()                  // every task loaded so far, by id
};
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export function setBackend(b) { backend = b; }
export const getBackend = () => backend;
export const isDemo = () => backend?.mode === 'demo';

// ------------------------------------------------------------------ lookups

const byId = (list, id) => list.find((x) => x.id === id) || null;
export const userById = (id) => byId(state.ref.users, id);
export const teamById = (id) => byId(state.ref.teams, id);
export const statusById = (id) => byId(state.ref.statuses, id);
export const projectById = (id) => byId(state.ref.projects, id);

export const userName = (id) => userById(id)?.name || (id ? 'Unknown person' : '');
export const teamName = (id) => teamById(id)?.name || (id ? 'Unknown team' : '');
export const statusName = (id) => statusById(id)?.name || id || '';
export const projectName = (id) => projectById(id)?.name || '';

export const activeStatuses = () => state.ref.statuses.filter((s) => s.active !== false);
export const myTeams = () => perm.visibleTeams(state.user, state.ref.teams);

// Projects the signed-in person owns (active ones), and everyone they could hand a task to.
export const ownedProjects = () => state.ref.projects.filter((p) => p.active !== false && p.ownerId && p.ownerId === state.user?.id);
export function assignableUsers() {
  return state.ref.users
    .filter((u) => u.active !== false && (u.teamIds || []).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}
// "Name (Team, Team)" so a project owner can tell people in different teams apart.
export const userWithTeams = (u) => `${u.name} (${(u.teamIds || []).map((t) => teamName(t)).join(', ')})`;

// People who can own a task in this team.
export function ownerCandidates(teamId) {
  const list = state.ref.users.filter((u) => u.active !== false && (u.teamIds || []).includes(teamId));
  if (perm.isDirector(state.user) && !list.some((u) => u.id === state.user.id)) list.push(state.user);
  if (perm.isMember(state.user)) return list.filter((u) => u.id === state.user.id);
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveForLog(field, value) {
  switch (field) {
    case 'ownerId': return userName(value);
    case 'teamId': return teamName(value);
    case 'projectId': return projectName(value);
    case 'status': return statusName(value);
    case 'priority': return PRIORITY_LABEL[value] || value;
    case 'role': return ROLE_LABEL[value] || value;
    case 'teamIds': return (value || []).map(teamName).join(', ');
    case 'ownerIds': return (value || []).map(userName).join(', ');
    case 'blockedBy': return (value || []).map((id) => state.tasks.get(id)?.title || 'another task').join(', ');
    default: return value;
  }
}

// ------------------------------------------------------------------ sign-in

export class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function startSession(authUser, { freshSignIn = false } = {}) {
  let doc;
  try {
    doc = await backend.getDoc('users/' + authUser.uid);
  } catch (err) {
    if (err.code === 'permission-denied') {
      throw new SessionError('no-profile', 'Your login is valid but your staff record is missing or deactivated. Please ask the Director.');
    }
    throw err;
  }
  if (!doc) throw new SessionError('no-profile', 'Your login is valid but no staff record exists for it yet. Please ask the Director to add you.');
  if (doc.active === false) throw new SessionError('inactive', 'This account has been deactivated. Please contact the Director.');

  state.user = doc;
  if (isTheme(doc.theme)) applyTheme(doc.theme);   // the colour theme this person chose, on any device
  await loadRefData();
  await recordLogin(freshSignIn);
  return state.user;
}

// Writes one "Signed in" log entry per browser session (not on every page load),
// which keeps the free quota safe and still shows who is using the tool.
async function recordLogin(freshSignIn) {
  const key = 'planner-login-logged-' + state.user.id;
  try { if (!freshSignIn && sessionStorage.getItem(key)) return; } catch { /* ignore */ }
  try {
    const log = makeLog({
      action: 'auth.login', entityType: 'user', entityId: state.user.id,
      entityTitle: state.user.name, teamId: (state.user.teamIds || [])[0] ?? null
    });
    await backend.commit([
      { type: 'update', path: 'users/' + state.user.id, data: { lastLoginAt: backend.ts(), lastLogId: log.id } },
      log.op
    ]);
    state.user.lastLoginAt = new Date();
    patchRef('users', { id: state.user.id, lastLoginAt: state.user.lastLoginAt, lastLogId: log.id });
    try { sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
  } catch (err) {
    console.warn('Could not record sign-in', err);
  }
}

export async function endSession() {
  state.user = null;
  state.tasks.clear();
  state.ref = { users: [], teams: [], statuses: [], projects: [], loadedAt: null };
  await backend.signOut();
}

// ----------------------------------------------------------- reference data

const REF_KEY = 'planner-ref-v1-' + (firebaseConfig.projectId || 'demo');

function applyRef(ref) {
  state.ref = {
    users: [...ref.users].sort((a, b) => a.name.localeCompare(b.name)),
    teams: [...ref.teams].sort((a, b) => a.name.localeCompare(b.name)),
    statuses: [...ref.statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    projects: [...ref.projects].sort((a, b) => a.name.localeCompare(b.name)),
    loadedAt: ref.loadedAt || Date.now()
  };
  syncOwnedProjects();
  emit('ref');
}

// Remember which projects the signed-in person owns, so screens and permission checks
// can answer without reading anything more.
function syncOwnedProjects() {
  if (!state.user) return;
  state.user = {
    ...state.user,
    ownedProjectIds: state.ref.projects.filter((p) => p.active !== false && p.ownerId === state.user.id).map((p) => p.id)
  };
}

function readRefCache() {
  if (isDemo()) return null;
  try {
    const cached = JSON.parse(localStorage.getItem(REF_KEY) || 'null');
    if (!cached || cached.uid !== state.user.id) return null;
    if (Date.now() - cached.loadedAt > REFDATA_TTL_MINUTES * 60000) return null;
    return cached;
  } catch { return null; }
}

function writeRefCache() {
  if (isDemo()) return;
  try {
    localStorage.setItem(REF_KEY, JSON.stringify({ uid: state.user.id, ...state.ref }));
  } catch { /* storage full or blocked: just skip caching */ }
}

export async function loadRefData({ force = false } = {}) {
  if (!force) {
    const cached = readRefCache();
    if (cached) { applyRef(cached); return false; }
  }
  const [users, teams, statuses, projects] = await Promise.all([
    backend.query('users'), backend.query('teams'),
    backend.query('statuses'), backend.query('projects')
  ]);
  applyRef({
    users: users.docs, teams: teams.docs, statuses: statuses.docs, projects: projects.docs,
    loadedAt: Date.now()
  });
  // Refresh our own record in case the Director changed our role or teams.
  const me = userById(state.user.id);
  if (me) state.user = { ...state.user, ...me };
  writeRefCache();
  return true;
}

// After we write reference data ourselves, patch the local copy instead of re-reading.
function patchRef(kind, doc) {
  const list = state.ref[kind];
  const i = list.findIndex((x) => x.id === doc.id);
  if (i >= 0) list[i] = { ...list[i], ...doc }; else list.push(doc);
  // Update our own record first, so screens that react to the 'ref' event already see it.
  if (kind === 'users' && doc.id === state.user.id) state.user = { ...state.user, ...doc };
  applyRef({ ...state.ref });
  syncOwnedProjects();
  writeRefCache();
}

// ---------------------------------------------------------------- log entries

export function makeLog({ action, entityType, entityId, entityTitle, teamId = null, changes = [] }) {
  const id = backend.newId('activityLog');
  return {
    id,
    op: {
      type: 'set', path: 'activityLog/' + id,
      data: {
        ts: backend.ts(),
        actorId: state.user.id, actorName: state.user.name, actorRole: state.user.role,
        action, entityType, entityId,
        entityTitle: (entityTitle || '').slice(0, 300),
        teamId: teamId ?? null,
        changes,
        summary: summarize(action, entityTitle, changes)
      }
    }
  };
}

// -------------------------------------------------------------------- profile

// Colour theme: shown at once, remembered in this browser, and stored on the person's account so
// it follows them to other devices. A preference is not business data, so it is not logged.
export async function setMyTheme(themeId) {
  if (!isTheme(themeId)) throw new Error('That colour theme does not exist.');
  applyTheme(themeId);
  if (state.user.theme === themeId) return;
  await backend.commit([{ type: 'update', path: 'users/' + state.user.id, data: { theme: themeId } }]);
  patchRef('users', { id: state.user.id, theme: themeId });
}

export const PASSWORD_MIN = 8;
export function validateNewPassword(current, next, confirm) {
  if (!current) return 'Please type your current password.';
  if (next.length < PASSWORD_MIN) return `The new password needs at least ${PASSWORD_MIN} characters.`;
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return 'Please use letters and at least one number in the new password.';
  if (next === current) return 'The new password must be different from your current one.';
  if (next !== confirm) return 'The two new passwords do not match.';
  return null;
}

// A person changes their own password. The password itself is never stored or logged;
// only the fact that it was changed is written to the activity log.
export async function changeMyPassword(current, next, confirm) {
  const problem = validateNewPassword(current, next, confirm);
  if (problem) throw new Error(problem);
  await backend.changePassword(current, next);
  try {
    const log = makeLog({
      action: 'user.password', entityType: 'user', entityId: state.user.id, entityTitle: state.user.name,
      teamId: (state.user.teamIds || [])[0] ?? null
    });
    await backend.commit([log.op]);
  } catch (err) { console.warn('Password changed, but the log entry could not be written.', err); }
}

// ---------------------------------------------------------------------- tasks

const TRACKED_TASK_FIELDS = [
  'title', 'description', 'teamId', 'projectId', 'ownerId', 'status', 'statusNote',
  'priority', 'startDate', 'dueDate', 'estimateHours', 'checklist', 'tags', 'blockedBy', 'archived'
];

const openQuery = [['archived', '==', false], ['statusCategory', 'in', OPEN_CATEGORIES]];

function remember(docs) {
  for (const doc of docs) state.tasks.set(doc.id, doc);
  return docs;
}

// A fresh read of "all open tasks in some scope" replaces what we held for that scope,
// so tasks that someone else finished or archived do not linger on screen.
function replaceOpen(docs, belongs) {
  const fresh = new Set(docs.map((d) => d.id));
  for (const [id, t] of state.tasks) {
    if (belongs(t) && !t.archived && OPEN_CATEGORIES.includes(t.statusCategory) && !fresh.has(id)) {
      state.tasks.delete(id);
    }
  }
  return remember(docs);
}

// My Tasks: the only live listener in the app.
export function watchMyTasks(onData, onError) {
  return backend.watch(
    'tasks',
    { where: [['ownerId', '==', state.user.id], ...openQuery] },
    (docs) => { replaceOpen(docs, (t) => t.ownerId === state.user.id); onData(docs); },
    onError
  );
}

// Tasks (any owner) that have a checklist step given to the signed-in person. One query per team
// of theirs: the Security Rules only let a person read tasks of their own teams, so each query
// has to name the team. "teamId ==" plus "array-contains" is served by the automatic single-field
// indexes (no composite index). Finished tasks come back too; the alerts filter them out.
export async function loadMyStepTasks() {
  const teamIds = state.user.teamIds || [];
  const results = await Promise.all(teamIds.map((teamId) => backend.query('tasks', {
    where: [['teamId', '==', teamId], ['checklistAssignees', 'array-contains', state.user.id]]
  })));
  return remember(results.flatMap((r) => r.docs));
}

export async function loadOpenTasks({ teamId = null } = {}) {
  const where = teamId ? [['teamId', '==', teamId], ...openQuery] : [...openQuery];
  const { docs } = await backend.query('tasks', { where });
  return replaceOpen(docs, (t) => (teamId ? t.teamId === teamId : true));
}

// Finished (Done) tasks of a team or person since a date. Needs the indexes in firestore.indexes.json.
export async function loadFinished({ teamId = null, ownerId = null, fromISO }) {
  const where = [['statusCategory', '==', 'done'], ['completedDate', '>=', fromISO]];
  if (ownerId) where.unshift(['ownerId', '==', ownerId]);
  else if (teamId) where.unshift(['teamId', '==', teamId]);
  const { docs } = await backend.query('tasks', { where });
  return remember(docs);
}

// ---- project owners
// Every open task in one project, whichever team the assignee is in.
export async function loadProjectTasks(projectId) {
  const { docs } = await backend.query('tasks', { where: [['projectId', '==', projectId], ...openQuery] });
  return replaceOpen(docs, (t) => t.projectId === projectId);
}

// Finished tasks in one project. The date filter is applied here, so no extra index is needed.
export async function loadProjectDone(projectId, fromISO = null) {
  const { docs } = await backend.query('tasks', { where: [['projectId', '==', projectId], ['statusCategory', '==', 'done']] });
  remember(docs);
  return fromISO ? docs.filter((t) => (t.completedDate || '') >= fromISO) : docs;
}

// Open tasks I created for someone else (in any team).
export async function loadAssignedByMe() {
  const { docs } = await backend.query('tasks', { where: [['createdBy', '==', state.user.id], ...openQuery] });
  remember(docs);
  return docs.filter((t) => t.ownerId !== state.user.id);
}

export async function loadArchived(teamId) {
  const where = [['archived', '==', true]];
  if (teamId) where.unshift(['teamId', '==', teamId]);
  const { docs } = await backend.query('tasks', { where });
  return remember(docs);
}

export function validateTaskDraft(d) {
  if (!d.title || !d.title.trim()) return 'Please give the task a title.';
  if (d.title.trim().length > 200) return 'The title is too long (200 characters at most).';
  if (!d.teamId) return 'Please choose a team.';
  if (!d.ownerId) return 'Please choose who this task is for.';
  if (d.startDate && d.dueDate && d.dueDate < d.startDate) return 'The due date is before the start date.';
  if ((d.blockedBy || []).length > MAX_BLOCKERS) return `A task can wait for at most ${MAX_BLOCKERS} other tasks.`;
  if (d.estimateHours !== '' && d.estimateHours !== null && d.estimateHours !== undefined) {
    const n = Number(d.estimateHours);
    if (isNaN(n) || n < 0) return 'The estimate must be a number of hours (0 or more).';
  }
  return null;
}

const cleanNum = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const cleanText = (v) => (v === '' || v === undefined ? null : v);

// The team a task goes to when it is given to this person. Normally the team chosen on the
// form. A project owner can give work to anyone, so then the task follows the person: their
// team if they are in the form's team, else the project's team, else their first team.
export function teamForOwner(draft, ownerId) {
  if (!perm.ownsProject(state.user, draft.projectId)) return draft.teamId;
  const theirs = userById(ownerId)?.teamIds || [];
  if (!theirs.length || theirs.includes(draft.teamId)) return draft.teamId;
  const project = projectById(draft.projectId);
  return theirs.includes(project?.teamId) ? project.teamId : theirs[0];
}

const teamIdsOf = (id) => userById(id)?.teamIds || [];
// Several tasks are written in one batch. Each task costs the rules a few document reads and
// a batch may use only 20, so a long list of people is written in chunks of this size.
export const CREATE_CHUNK = 5;
export const MAX_ASSIGNEES = 30;

// `extra` is for tasks made from a template: a fixed id, and the template they came from.
function buildTask(draft, ownerId, status, extra = {}) {
  const teamId = teamForOwner(draft, ownerId);
  const dropRes = dropOutsiders(cleanSteps(draft.checklist), teamId, teamIdsOf);
  const steps = stampSteps(dropRes.steps, [], state.user.id);
  const dropped = dropRes.dropped;
  const id = extra.id || backend.newId('tasks');
  const stamp = backend.ts();
  const title = (extra.title || draft.title).trim();
  const tags = cleanTags(draft.tags);
  const blockedBy = [...new Set(draft.blockedBy || [])].slice(0, MAX_BLOCKERS);
  const log = makeLog({
    action: 'task.create', entityType: 'task', entityId: id,
    entityTitle: title, teamId,
    changes: [
      { field: 'ownerId', from: '', to: userName(ownerId) },
      { field: 'status', from: '', to: status.name },
      ...(draft.dueDate ? [{ field: 'dueDate', from: '', to: draft.dueDate }] : []),
      { field: 'priority', from: '', to: PRIORITY_LABEL[draft.priority || 'medium'] },
      ...(extra.recurringName ? [{ field: 'recurring', from: '', to: extra.recurringName }] : [])
    ]
  });
  const task = {
    title, description: draft.description || '',
    teamId, projectId: cleanText(draft.projectId), ownerId,
    createdBy: state.user.id,
    status: status.id, statusCategory: status.category, statusNote: null,
    priority: draft.priority || 'medium',
    startDate: cleanText(draft.startDate), dueDate: cleanText(draft.dueDate),
    estimateHours: cleanNum(draft.estimateHours),
    checklist: steps, ...deriveStepFields(steps), archived: false,
    completedAt: null, completedDate: null, submits: 0, reworks: 0,
    // who gave this task to its owner, and when: the owner's "new for you" alert reads these
    assignedBy: state.user.id, assignedAt: stamp,
    ...(tags.length ? { tags } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
    ...(extra.recurringId ? { recurringId: extra.recurringId } : {}),
    createdAt: stamp, updatedAt: stamp, lastLogId: log.id
  };
  return { id, task, log, dropped };
}

// Gives the same task to one or more people: one separate task for each person, so each can
// move their own copy through the statuses. Returns the tasks created (and how many step
// assignments had to be dropped because the person is not in that task's team).
//
// `draft.titles` (a list of titles) makes one task per title and per person: "add several at once".
export async function createTasks(draft, ownerIds) {
  const people = [...new Set((ownerIds && ownerIds.length ? ownerIds : [draft.ownerId]).filter(Boolean))];
  const titles = (draft.titles && draft.titles.length ? draft.titles : [draft.title]).map((t) => String(t || '').trim()).filter(Boolean);
  const problem = validateTaskDraft({ ...draft, title: titles[0] || '', ownerId: people[0] || '' });
  if (problem) throw new Error(problem);
  const tooLong = titles.find((t) => t.length > 200);
  if (tooLong) throw new Error('One of the titles is too long (200 characters at most).');
  const missing = missingForNew(draft);
  if (missing.length) throw new Error(missing.join(' '));
  if (people.length * titles.length > MAX_ASSIGNEES) {
    throw new Error(`That would create ${people.length * titles.length} tasks. Please keep it to ${MAX_ASSIGNEES} or fewer at a time.`);
  }
  if (people.length > 1 && perm.isMember(state.user) && !perm.ownsProject(state.user, draft.projectId)) {
    throw new Error('Only an Assistant Team Leader or above can give a task to other people.');
  }
  const status = statusById(draft.status || INITIAL_STATUS_ID);
  if (!status) throw new Error('The default statuses are not set up yet. Ask the Director to set them up.');

  const built = titles.flatMap((title) => people.map((ownerId) => buildTask(draft, ownerId, status, { title })));
  const created = [];
  let dropped = 0;
  for (let i = 0; i < built.length; i += CREATE_CHUNK) {
    const chunk = built.slice(i, i + CREATE_CHUNK);
    try {
      await backend.commit(chunk.flatMap((b) => [{ type: 'set', path: 'tasks/' + b.id, data: b.task }, b.log.op]));
    } catch (err) {
      if (created.length) {
        emit('tasks');
        throw new Error(`${created.length} of ${built.length} tasks were created (for ${created.map((t) => userName(t.ownerId)).join(', ')}). `
          + `The rest were not: ${err.message || err}. Open the list to check, then add the missing ones.`);
      }
      throw err;
    }
    const now = new Date();
    for (const b of chunk) {
      const local = { id: b.id, ...b.task, createdAt: now, updatedAt: now };
      state.tasks.set(b.id, local);
      created.push(local);
      dropped += b.dropped;
    }
  }
  emit('tasks');
  created.droppedSteps = dropped;
  return created;
}

export async function createTask(draft) {
  const [task] = await createTasks(draft, [draft.ownerId]);
  return task;
}

// Saves only what changed, together with its log entry, in one write.
// Returns the updated task, or null if nothing changed.
export async function updateTask(original, draft) {
  const problem = validateTaskDraft({ ...original, ...draft });
  if (problem) throw new Error(problem);

  const next = { ...original, ...draft };
  const status = statusById(next.status);
  if (!status) throw new Error('That status no longer exists.');

  // A status that needs a reason (Blocked, On Hold...) must come with one.
  const statusChanged = next.status !== original.status;
  if (statusChanged) {
    if (status.needsReason && !(next.statusNote || '').trim()) {
      throw new Error(`"${status.name}" needs a short reason. Please fill in the status note.`);
    }
    if (!status.needsReason) next.statusNote = null;
  }

  // Steps: only the allowed keys, and nobody keeps a step in a team they are not part of.
  let steps = cleanSteps(next.checklist);
  if (next.teamId !== original.teamId) steps = dropOutsiders(steps, next.teamId, teamIdsOf).steps;
  steps = stampSteps(steps, original.checklist, state.user.id);

  const normalised = {
    ...next,
    checklist: steps,
    projectId: cleanText(next.projectId), startDate: cleanText(next.startDate),
    dueDate: cleanText(next.dueDate), estimateHours: cleanNum(next.estimateHours),
    statusNote: cleanText(next.statusNote), description: next.description || '',
    tags: cleanTags(next.tags), blockedBy: [...new Set(next.blockedBy || [])].slice(0, MAX_BLOCKERS)
  };
  if (normalised.blockedBy.includes(original.id)) throw new Error('A task cannot wait for itself.');

  // Compare steps in one canonical form so key order in stored data never shows up as a change.
  const changes = diffFields({
    ...original, checklist: cleanSteps(original.checklist), tags: original.tags || [], blockedBy: original.blockedBy || []
  }, normalised, TRACKED_TASK_FIELDS, resolveForLog);
  if (!changes.length) return null;

  const stamp = backend.ts();
  const log = makeLog({
    action: taskAction(changes), entityType: 'task', entityId: original.id,
    entityTitle: normalised.title, teamId: normalised.teamId, changes
  });

  // Send only the fields that changed, plus what the system derives.
  const patch = {};
  for (const c of changes) patch[c.field] = normalised[c.field];
  // Keep the two summary fields in step with the checklist, but send them only when they change
  // (a person ticking their own step may not touch them).
  if (patch.checklist) {
    const derived = deriveStepFields(steps);
    if (JSON.stringify(original.checklistAssignees || []) !== JSON.stringify(derived.checklistAssignees)) {
      patch.checklistAssignees = derived.checklistAssignees;
    }
    if ((original.checklistForTeam === true) !== derived.checklistForTeam) patch.checklistForTeam = derived.checklistForTeam;
  }
  if (statusChanged) {
    patch.statusCategory = status.category;
    const wasDone = original.statusCategory === 'done';
    const isDone = status.category === 'done';
    if (isDone && !wasDone) { patch.completedAt = stamp; patch.completedDate = todayISO(); }
    if (!isDone && wasDone) { patch.completedAt = null; patch.completedDate = null; }
    if (status.category === 'review' && original.statusCategory !== 'review') patch.submits = (original.submits || 0) + 1;
    if (status.id === 'rework') patch.reworks = (original.reworks || 0) + 1;
  }
  // Handing the task to someone else: remember who and when (their "new for you" alert).
  if (patch.ownerId) { patch.assignedBy = state.user.id; patch.assignedAt = stamp; }
  patch.updatedAt = stamp;
  patch.lastLogId = log.id;

  await backend.commit([{ type: 'update', path: 'tasks/' + original.id, data: patch }, log.op]);

  const local = { ...original };
  for (const [k, v] of Object.entries(patch)) local[k] = v === stamp ? new Date() : v;
  state.tasks.set(original.id, local);
  emit('tasks');
  return local;
}

// -------------------------------------------------------------------- comments

export async function loadComments(taskId) {
  const { docs } = await backend.query(`tasks/${taskId}/comments`, { orderBy: [['createdAt', 'asc']], limit: 100 });
  return docs;
}

// People who can be named in a comment on this task: everyone who can read it (the task's team,
// its owner, whoever created it, the project owner and every Director or Superuser), not yourself.
export function mentionCandidates(task) {
  const me = state.user.id;
  const project = task.projectId ? projectById(task.projectId) : null;
  return state.ref.users
    .filter((u) => u.active !== false && u.id !== me && (
      (u.teamIds || []).includes(task.teamId) || u.id === task.ownerId || u.id === task.createdBy
      || (project && u.id === project.ownerId) || u.role === 'director' || u.superuser === true))
    .map((u) => ({ id: u.id, name: u.name }));
}

export async function addComment(task, text) {
  const clean = (text || '').trim();
  if (!clean) throw new Error('Please type a comment first.');
  if (clean.length > 2000) throw new Error('That comment is too long (2000 characters at most).');
  const people = mentionCandidates(task);
  const mentions = findMentions(clean, people, MAX_MENTIONS + 1);
  if (mentions.length > MAX_MENTIONS) throw new Error(`You can mention at most ${MAX_MENTIONS} people in one comment.`);
  const commentId = backend.newId(`tasks/${task.id}/comments`);
  const log = makeLog({
    action: 'comment.add', entityType: 'comment', entityId: commentId,
    entityTitle: task.title, teamId: task.teamId,
    changes: [
      { field: 'text', from: '', to: clean.length > 120 ? clean.slice(0, 117) + '...' : clean },
      ...(mentions.length ? [{ field: 'mentions', from: '', to: mentions.map(userName).join(', ') }] : [])
    ]
  });
  const comment = {
    authorId: state.user.id, authorName: state.user.name, text: clean,
    ...(mentions.length ? { mentions } : {}),
    createdAt: backend.ts(), logId: log.id
  };
  // One small note per person named, written in the same batch as the comment.
  const notes = mentions.map((toId) => ({
    type: 'set', path: 'mentions/' + backend.newId('mentions'),
    data: {
      toId, fromId: state.user.id, fromName: state.user.name, taskId: task.id, taskTitle: task.title,
      commentId, snippet: snippetOf(clean), read: false, createdAt: backend.ts()
    }
  }));
  await backend.commit([{ type: 'set', path: `tasks/${task.id}/comments/${commentId}`, data: comment }, log.op, ...notes]);
  return { id: commentId, ...comment, createdAt: new Date() };
}

// Notes for the signed-in person that they have not marked read. One equality query, no index.
export async function loadMyMentions() {
  const { docs } = await backend.query('mentions', { where: [['toId', '==', state.user.id], ['read', '==', false]] });
  return docs;
}

// One task by id (for opening it from an alert). Uses the copy already loaded when there is one.
export async function loadTask(id) {
  const have = state.tasks.get(id);
  if (have) return have;
  const doc = await backend.getDoc('tasks/' + id);
  if (doc) state.tasks.set(id, doc);
  return doc;
}

export async function markMentionsRead(ids) {
  const list = [...new Set(ids)].slice(0, 400);
  if (!list.length) return;
  await backend.commit(list.map((id) => ({ type: 'update', path: 'mentions/' + id, data: { read: true } })));
}

// ----------------------------------------------------------------------- people

export async function createPerson({ name, email, role, teamIds, password, sendReset, superuser = false, hr = false }) {
  if (!name.trim()) throw new Error('Please enter a name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (!password || password.length < 8) throw new Error('The temporary password needs at least 8 characters.');
  if (state.ref.users.some((u) => (u.email || '').toLowerCase() === email.trim().toLowerCase())) {
    throw new Error('Someone with that email is already on the list.');
  }
  const uid = await backend.createAccount(email.trim(), password);
  const log = makeLog({
    action: 'user.create', entityType: 'user', entityId: uid, entityTitle: name.trim(),
    teamId: teamIds[0] ?? null,
    changes: [
      { field: 'role', from: '', to: ROLE_LABEL[role] },
      { field: 'teamIds', from: '', to: teamIds.map(teamName).join(', ') },
      ...(superuser ? [{ field: 'superuser', from: '', to: 'yes' }] : []),
      ...(hr ? [{ field: 'hr', from: '', to: 'yes' }] : [])
    ]
  });
  const doc = {
    name: name.trim(), email: email.trim(), role, teamIds, active: true,
    ...(superuser ? { superuser: true } : {}),
    ...(hr ? { hr: true } : {}),
    createdAt: backend.ts(), lastLoginAt: null, lastLogId: log.id
  };
  try {
    await backend.commit([{ type: 'set', path: 'users/' + uid, data: doc }, log.op]);
  } catch (err) {
    throw new Error('The login was created but the staff record could not be saved ('
      + (err.message || err) + '). Try adding the same email again after checking your connection and the Security Rules.');
  }
  if (sendReset) { try { await backend.resetPassword(email.trim()); } catch { /* optional */ } }
  patchRef('users', { id: uid, ...doc, createdAt: new Date() });
  return uid;
}

// Would this account still have Director powers after the change? Used to stop a person
// from taking their own admin access away by mistake (firestore.rules checks the same thing).
export const keepsFullPower = (u) => u.role === 'director' || u.superuser === true;

export async function updatePerson(user, patch) {
  const before = { ...user, superuser: user.superuser === true, hr: user.hr === true };
  const next = { ...before, ...patch };
  if (patch.superuser !== undefined) next.superuser = patch.superuser === true;
  if (patch.hr !== undefined) next.hr = patch.hr === true;
  if (user.id === state.user.id) {
    if (next.active === false) throw new Error('You cannot deactivate your own account.');
    if (!keepsFullPower(next)) {
      throw new Error('That would remove your own admin powers. Tick "Superuser access" first, or ask another Director or Superuser to change your role.');
    }
  }
  const changes = diffFields(before, next, ['name', 'role', 'teamIds', 'active', 'superuser', 'hr'], resolveForLog);
  if (!changes.length) return;
  const log = makeLog({
    action: 'user.update', entityType: 'user', entityId: user.id, entityTitle: next.name,
    teamId: (next.teamIds || [])[0] ?? null, changes
  });
  const data = { lastLogId: log.id };
  for (const c of changes) data[c.field] = next[c.field];
  await backend.commit([{ type: 'update', path: 'users/' + user.id, data }, log.op]);
  patchRef('users', { id: user.id, ...data });
}

// ------------------------------------------------------------------------ teams

export async function createTeam(name) {
  if (!name.trim()) throw new Error('Please enter a team name.');
  const id = backend.newId('teams');
  const log = makeLog({ action: 'team.create', entityType: 'team', entityId: id, entityTitle: name.trim() });
  const doc = { name: name.trim(), approvalGate: true, active: true, createdAt: backend.ts(), lastLogId: log.id };
  await backend.commit([{ type: 'set', path: 'teams/' + id, data: doc }, log.op]);
  patchRef('teams', { id, ...doc, createdAt: new Date() });
  return id;
}

export async function updateTeam(team, patch) {
  const next = { ...team, ...patch };
  const changes = diffFields(team, next, ['name', 'approvalGate', 'active']);
  if (!changes.length) return;
  const log = makeLog({
    action: 'team.update', entityType: 'team', entityId: team.id, entityTitle: next.name,
    teamId: team.id, changes
  });
  const data = { lastLogId: log.id };
  for (const c of changes) data[c.field] = next[c.field];
  await backend.commit([{ type: 'update', path: 'teams/' + team.id, data }, log.op]);
  patchRef('teams', { id: team.id, ...data });
}

// --------------------------------------------------------------------- projects

export async function createProject({ name, teamId, description, ownerId = null }) {
  if (!name.trim()) throw new Error('Please enter a project name.');
  if (!teamId) throw new Error('Please choose a team for the project.');
  const id = backend.newId('projects');
  const log = makeLog({ action: 'project.create', entityType: 'project', entityId: id, entityTitle: name.trim(), teamId });
  const doc = {
    name: name.trim(), teamId, description: description || '', active: true,
    ownerId: ownerId || null,
    createdAt: backend.ts(), lastLogId: log.id
  };
  await backend.commit([{ type: 'set', path: 'projects/' + id, data: doc }, log.op]);
  patchRef('projects', { id, ...doc, createdAt: new Date() });
  return id;
}

export async function updateProject(project, patch) {
  const next = { ...project, ...patch };
  next.ownerId = next.ownerId || null;
  const changes = diffFields({ ...project, ownerId: project.ownerId || null }, next, ['name', 'teamId', 'description', 'active', 'ownerId'], resolveForLog);
  if (!changes.length) return;
  const log = makeLog({
    action: 'project.update', entityType: 'project', entityId: project.id, entityTitle: next.name,
    teamId: next.teamId, changes
  });
  const data = { lastLogId: log.id };
  for (const c of changes) data[c.field] = next[c.field];
  await backend.commit([{ type: 'update', path: 'projects/' + project.id, data }, log.op]);
  patchRef('projects', { id: project.id, ...data });
}

// --------------------------------------------------------------------- statuses

export async function seedDefaultStatuses() {
  const ops = [];
  const created = [];
  for (const s of DEFAULT_STATUSES) {
    const { id, ...rest } = s;
    const log = makeLog({ action: 'status.create', entityType: 'status', entityId: id, entityTitle: s.name });
    const doc = { ...rest, active: true, lastLogId: log.id };
    ops.push({ type: 'set', path: 'statuses/' + id, data: doc }, log.op);
    created.push({ id, ...doc });
  }
  await backend.commit(ops);
  created.forEach((s) => patchRef('statuses', s));
}

export async function createStatus({ name, category, color, needsReason }) {
  if (!name.trim()) throw new Error('Please enter a status name.');
  const id = backend.newId('statuses');
  const order = Math.max(0, ...state.ref.statuses.map((s) => s.order || 0)) + 10;
  const log = makeLog({ action: 'status.create', entityType: 'status', entityId: id, entityTitle: name.trim() });
  const doc = {
    name: name.trim(), category, color: color || '#64748b', order, active: true,
    needsReason: !!needsReason, lastLogId: log.id
  };
  await backend.commit([{ type: 'set', path: 'statuses/' + id, data: doc }, log.op]);
  patchRef('statuses', { id, ...doc });
}

export async function updateStatus(status, patch) {
  const next = { ...status, ...patch };
  const changes = diffFields(status, next, ['name', 'category', 'color', 'order', 'active', 'needsReason']);
  if (!changes.length) return;
  const log = makeLog({ action: 'status.update', entityType: 'status', entityId: status.id, entityTitle: next.name, changes });
  const data = { lastLogId: log.id };
  for (const c of changes) data[c.field] = next[c.field];
  await backend.commit([{ type: 'update', path: 'statuses/' + status.id, data }, log.op]);
  patchRef('statuses', { id: status.id, ...data });
}


// ------------------------------------------------------------------------- leave

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateLeaveDraft(d) {
  if (!LEAVE_TYPES.includes(d.type)) return 'Please choose the kind of leave.';
  if (!DATE_RE.test(d.startDate || '') || !DATE_RE.test(d.endDate || '')) return 'Please choose the first and last day.';
  if (d.endDate < d.startDate) return 'The last day is before the first day.';
  if ((d.reason || '').length > 300) return 'The reason is too long (300 characters at most).';
  if (!d.teamIds || !d.teamIds.length) return 'Please choose at least one team.';
  return null;
}

const rangeText = (l) => (l.startDate === l.endDate ? l.startDate : `${l.startDate} to ${l.endDate}`);
const leaveTitle = (l) => `${l.userName}: ${LEAVE_TYPE_LABEL[l.type] || l.type}, ${rangeText(l)}`;

// Asks for leave for yourself (waits for approval), or records leave for someone else
// (approved straight away). One request is created for each team, so every team's leader
// sees it and the team calendars stay accurate. All in one write.
export async function submitLeave({ person, type, startDate, endDate, half, reason, teamIds, existing = [] }) {
  const draft = { type, startDate, endDate, half: startDate === endDate ? (half || 'full') : 'full', reason: (reason || '').trim(), teamIds };
  const problem = validateLeaveDraft(draft);
  if (problem) throw new Error(problem);
  const clash = existing.find((l) => l.userId === person.id && ['pending', 'leader_ok', 'approved'].includes(l.status)
    && teamIds.includes(l.teamId) && l.startDate <= endDate && l.endDate >= startDate);
  if (clash) throw new Error(`${person.name} already has leave from ${rangeText(clash)} (${LEAVE_STATUS_LABEL[clash.status].toLowerCase()}).`);

  const forOthers = person.id !== state.user.id;
  if (forOthers) {
    for (const teamId of teamIds) {
      if (!perm.canRecordLeaveFor(state.user, person, teamId)) throw new Error('Your role cannot record leave for that person.');
    }
  }
  // Where the request starts in the approval chain. The Director's own record is final. A
  // Team Leader or Manager has nobody above them in the team, so their step is done and it goes
  // to the Director. Everyone else starts with their Team Leader.
  const me = state.user;
  const start = perm.isDirector(me) ? 'approved' : (me.role === 'leader' || me.role === 'manager') ? 'leader_ok'
    : (forOthers ? 'leader_ok' : 'pending');
  const approvedNow = start === 'approved';
  const stamp = backend.ts();
  const ops = [];
  const created = [];
  for (const teamId of teamIds) {
    const id = backend.newId('leaves');
    const doc = {
      userId: person.id, userName: person.name, teamId,
      type: draft.type, startDate, endDate, half: draft.half, reason: draft.reason,
      status: start,
      requestedBy: state.user.id,
      decidedBy: approvedNow ? state.user.id : null, decidedAt: approvedNow ? stamp : null, decisionNote: null,
      ...(start === 'leader_ok' ? { leaderBy: state.user.id, leaderAt: stamp } : {}),
      createdAt: stamp, updatedAt: stamp, lastLogId: ''
    };
    const log = makeLog({
      action: forOthers ? 'leave.record' : (approvedNow ? 'leave.record' : 'leave.request'), entityType: 'leave', entityId: id,
      entityTitle: leaveTitle(doc), teamId,
      changes: [
        { field: 'type', from: '', to: LEAVE_TYPE_LABEL[draft.type] },
        { field: 'startDate', from: '', to: startDate },
        ...(endDate !== startDate ? [{ field: 'endDate', from: '', to: endDate }] : []),
        ...(draft.half !== 'full' ? [{ field: 'half', from: '', to: HALF_LABEL[draft.half] }] : []),
        ...(draft.reason ? [{ field: 'reason', from: '', to: draft.reason.slice(0, 120) }] : [])
      ]
    });
    doc.lastLogId = log.id;
    ops.push({ type: 'set', path: 'leaves/' + id, data: doc }, log.op);
    const now = new Date();
    created.push({ id, ...doc, createdAt: now, updatedAt: now, decidedAt: approvedNow ? now : null, leaderAt: start === 'leader_ok' ? now : undefined });
  }
  await backend.commit(ops);
  emit('leave');
  return created;
}

// Step 1 (Team Leader) moves a request to "waiting for the Director"; step 2 (Director) approves it.
// Either can decline, with a reason.
export async function decideLeave(leave, decision, note) {
  const approve = decision === 'approve';
  const text = (note || '').trim();
  if (!approve && !text) throw new Error('Please give a short reason for declining.');
  if (!perm.canApproveLeave(state.user, leave)) throw new Error('Your role cannot decide on this leave.');
  const stamp = backend.ts();
  const stepOne = approve && leave.status === 'pending';
  const status = !approve ? 'declined' : stepOne ? 'leader_ok' : 'approved';
  const log = makeLog({
    action: !approve ? 'leave.decline' : stepOne ? 'leave.leader' : 'leave.approve', entityType: 'leave', entityId: leave.id,
    entityTitle: leaveTitle(leave), teamId: leave.teamId,
    changes: [
      { field: 'status', from: LEAVE_STATUS_LABEL[leave.status], to: LEAVE_STATUS_LABEL[status] },
      ...(text ? [{ field: 'decisionNote', from: '', to: text.slice(0, 120) }] : [])
    ]
  });
  const patch = stepOne
    ? { status, leaderBy: state.user.id, leaderAt: stamp, updatedAt: stamp, lastLogId: log.id }
    : { status, decidedBy: state.user.id, decidedAt: stamp, decisionNote: text || null, updatedAt: stamp, lastLogId: log.id };
  await backend.commit([{ type: 'update', path: 'leaves/' + leave.id, data: patch }, log.op]);
  emit('leave');
  const now = new Date();
  return { ...leave, ...patch, ...(stepOne ? { leaderAt: now } : { decidedAt: now }), updatedAt: now };
}

export async function cancelLeave(leave) {
  if (!perm.canCancelLeave(state.user, leave)) throw new Error('This leave cannot be cancelled.');
  const stamp = backend.ts();
  const log = makeLog({
    action: 'leave.cancel', entityType: 'leave', entityId: leave.id, entityTitle: leaveTitle(leave), teamId: leave.teamId,
    changes: [{ field: 'status', from: LEAVE_STATUS_LABEL[leave.status], to: LEAVE_STATUS_LABEL.cancelled }]
  });
  const patch = { status: 'cancelled', updatedAt: stamp, lastLogId: log.id };
  await backend.commit([{ type: 'update', path: 'leaves/' + leave.id, data: patch }, log.op]);
  emit('leave');
  return { ...leave, status: 'cancelled', updatedAt: new Date(), lastLogId: log.id };
}

// Leave that has not finished yet, for one team (needs the teamId + endDate index).
export async function loadTeamLeave(teamId, fromISO = todayISO()) {
  const { docs } = await backend.query('leaves', { where: [['teamId', '==', teamId], ['endDate', '>=', fromISO]] });
  return docs;
}

// Everything you asked for yourself (no index needed).
export async function loadMyLeave() {
  const { docs } = await backend.query('leaves', { where: [['userId', '==', state.user.id]], limit: 200 });
  return docs;
}

// Requests still waiting on someone: for the Team Leader (pending) and for the Director (leader_ok).
export async function loadPendingLeave(teamId) {
  const [a, b] = await Promise.all(['pending', 'leader_ok'].map((st) =>
    backend.query('leaves', { where: [['teamId', '==', teamId], ['status', '==', st]] })));
  return [...a.docs, ...b.docs];
}

// ------------------------------------------------------------------- HR: entitlements and acknowledging
//
// HR reads every leave record. To keep reads low, one query loads a whole year (leaves that end in
// that year or in the month after), the result is kept for 5 minutes, and the To-acknowledge badge
// in the menu uses the same data.

export async function loadLeaveYear(year) {
  const { docs } = await backend.query('leaves', { where: [['endDate', '>=', `${year}-01-01`], ['endDate', '<=', `${Number(year) + 1}-01-31`]] });
  return docs.filter((l) => l.startDate <= `${year}-12-31`);
}

const policyCache = new Map();
export async function loadPolicy(year, { force = false } = {}) {
  const key = String(year);
  if (!force && policyCache.has(key)) return policyCache.get(key);
  const doc = await backend.getDoc('leavePolicy/' + key);
  policyCache.set(key, doc);
  return doc;
}

const FIELD_DAYS = (t) => LEAVE_TYPE_LABEL[t] || t;
export async function savePolicy(year, days, overrides) {
  if (!perm.canSetEntitlements(state.user)) throw new Error('Only HR can set leave entitlements.');
  const before = await loadPolicy(year, { force: true });
  const next = buildPolicy(year, days, overrides);
  const changes = [];
  for (const t of ENTITLED_TYPES) {
    const a = before?.days?.[t], b = next.days[t];
    if (a !== b) changes.push({ field: t, from: a === undefined ? '' : String(a), to: b === undefined ? 'not set' : String(b) });
  }
  // One line for each person whose exception was added, changed or removed.
  const describe = (o) => (o ? ENTITLED_TYPES.filter((t) => typeof o[t] === 'number').map((t) => `${LEAVE_TYPE_LABEL[t]} ${o[t]}`).join(', ') : '');
  const ids = [...new Set([...Object.keys(before?.overrides || {}), ...Object.keys(next.overrides)])];
  for (const id of ids) {
    const was = describe(before?.overrides?.[id]), now = describe(next.overrides[id]);
    if (was !== now) changes.push({ field: `Exception: ${userName(id)}`, from: was, to: now || 'removed' });
  }
  changes.splice(30);
  if (!changes.length) return null;
  const log = makeLog({
    action: 'policy.update', entityType: 'policy', entityId: String(year),
    entityTitle: `Leave entitlements ${year}`, teamId: null, changes
  });
  const stamp = backend.ts();
  const doc = { ...next, updatedAt: stamp, lastLogId: log.id };
  await backend.commit([{ type: 'set', path: 'leavePolicy/' + year, data: doc }, log.op]);
  policyCache.delete(String(year));
  emit('policy');
  return { id: String(year), ...doc, updatedAt: new Date() };
}
export const entitlementLabel = FIELD_DAYS;

// HR acknowledges approved leave. A request that was stored once per team is acknowledged in one go.
// Nothing about the approval changes. Chunks of 8 stay inside the rules' document-access limit.
export async function acknowledgeLeave(groups) {
  if (!perm.isHr(state.user)) throw new Error('Only HR can acknowledge leave.');
  const docs = groups.flatMap((g) => g.docs.filter((d) => d.status === 'approved' && !d.hrAckBy));
  if (!docs.length) return 0;
  let done = 0;
  for (let i = 0; i < docs.length; i += 8) {
    const chunk = docs.slice(i, i + 8);
    const stamp = backend.ts();
    const ops = [];
    for (const l of chunk) {
      const log = makeLog({
        action: 'leave.ack', entityType: 'leave', entityId: l.id, entityTitle: leaveTitle(l), teamId: l.teamId,
        changes: [{ field: 'hrAck', from: '', to: 'acknowledged' }]
      });
      ops.push({ type: 'update', path: 'leaves/' + l.id, data: { hrAckBy: state.user.id, hrAckAt: stamp, updatedAt: stamp, lastLogId: log.id } }, log.op);
    }
    await backend.commit(ops);
    done += chunk.length;
    const now = new Date();
    for (const l of chunk) { l.hrAckBy = state.user.id; l.hrAckAt = now; }
  }
  emit('leave');
  return done;
}

// Number shown on the HR menu entry: approved leave nobody in HR has acknowledged yet (this year).
export const hrQueue = { count: 0, at: 0, leaves: null, year: null };
const thisYearNumber = () => Number(todayISO().slice(0, 4));
// Keeps the menu badge in step with a year of leave that a screen has just loaded or changed.
export function syncHrQueue(leaves, year) {
  if (year !== thisYearNumber()) return;
  hrQueue.leaves = leaves; hrQueue.year = year; hrQueue.at = Date.now();
  hrQueue.count = groupLeaves(leaves).filter((g) => g.waitingForHr).length;
  emit('hr');
}
export async function refreshHrQueue({ force = false } = {}) {
  if (!perm.isHr(state.user)) return 0;
  const year = thisYearNumber();
  if (!force && hrQueue.leaves && hrQueue.year === year && Date.now() - hrQueue.at < 5 * 60000) return hrQueue.count;
  syncHrQueue(await loadLeaveYear(year), year);
  return hrQueue.count;
}

// ---------------------------------------------------------------------- holidays

export async function loadHolidays(fromISO = todayISO()) {
  const { docs } = await backend.query('holidays', { where: [['date', '>=', fromISO]], orderBy: [['date', 'asc']] });
  return docs;
}

function validateHoliday(d) {
  if (!(d.name || '').trim()) return 'Please give the holiday a name.';
  if (d.name.trim().length > 100) return 'The name is too long (100 characters at most).';
  if (!DATE_RE.test(d.date || '')) return 'Please choose the date.';
  return null;
}

export async function createHoliday({ name, date, teamId }) {
  const problem = validateHoliday({ name, date });
  if (problem) throw new Error(problem);
  if (!teamId && !perm.isDirector(state.user)) throw new Error('Only the Director can add a holiday for everyone. Choose your team instead.');
  const id = backend.newId('holidays');
  const log = makeLog({
    action: 'holiday.create', entityType: 'holiday', entityId: id, entityTitle: `${name.trim()} (${date})`, teamId: teamId || null,
    changes: [{ field: 'date', from: '', to: date }, { field: 'teamId', from: '', to: teamId ? teamName(teamId) : 'Everyone' }]
  });
  const doc = { name: name.trim(), date, teamId: teamId || null, active: true, createdAt: backend.ts(), lastLogId: log.id };
  await backend.commit([{ type: 'set', path: 'holidays/' + id, data: doc }, log.op]);
  emit('leave');
  return { id, ...doc, createdAt: new Date() };
}

// ---- bulk add (the bundled Malaysian list). Director only, always "everyone".
// A holiday counts as already added when the same name is on the same date for everyone,
// so running the import twice never doubles anything.
const holidayKey = (date, name) => `${date}|${name.trim().toLowerCase()}`;
const IMPORT_BATCH = 8; // 8 holidays = 16 writes, safely inside the rules' document-access limit

export async function planHolidayImport(items) {
  if (!items.length) return { fresh: [], existing: [] };
  const from = items.map((i) => i.date).sort()[0];
  const have = new Set((await loadHolidays(from))
    .filter((x) => x.active !== false && !x.teamId).map((x) => holidayKey(x.date, x.name)));
  const fresh = [], existing = [];
  for (const i of items) (have.has(holidayKey(i.date, i.name)) ? existing : fresh).push(i);
  return { fresh, existing };
}

export async function importHolidays(items) {
  if (!perm.isDirector(state.user)) throw new Error('Only the Director can add holidays for everyone.');
  for (const i of items) { const p = validateHoliday(i); if (p) throw new Error(`${i.name || 'Holiday'}: ${p}`); }
  const { fresh, existing } = await planHolidayImport(items);
  let added = 0;
  try {
    for (let n = 0; n < fresh.length; n += IMPORT_BATCH) {
      const ops = [];
      for (const i of fresh.slice(n, n + IMPORT_BATCH)) {
        const id = backend.newId('holidays');
        const log = makeLog({
          action: 'holiday.create', entityType: 'holiday', entityId: id, entityTitle: `${i.name.trim()} (${i.date})`, teamId: null,
          changes: [{ field: 'date', from: '', to: i.date }, { field: 'teamId', from: '', to: 'Everyone' }]
        });
        ops.push({ type: 'set', path: 'holidays/' + id, data: { name: i.name.trim(), date: i.date, teamId: null, active: true, createdAt: backend.ts(), lastLogId: log.id } }, log.op);
      }
      await backend.commit(ops);
      added += Math.min(IMPORT_BATCH, fresh.length - n);
    }
  } catch (err) {
    emit('leave');
    throw new Error(`${added} of ${fresh.length} holidays were added before it stopped (${err.message}). Run it again to add the rest.`);
  }
  if (added) emit('leave');
  return { added, skipped: existing.length };
}

export async function updateHoliday(holiday, patch) {
  const next = { ...holiday, ...patch, name: (patch.name ?? holiday.name).trim() };
  const problem = validateHoliday(next);
  if (problem) throw new Error(problem);
  if (!next.teamId && !perm.isDirector(state.user)) throw new Error('Only the Director can make a holiday apply to everyone.');
  const changes = diffFields(holiday, next, ['name', 'date', 'teamId', 'active'], resolveForLog);
  if (!changes.length) return holiday;
  const log = makeLog({
    action: 'holiday.update', entityType: 'holiday', entityId: holiday.id,
    entityTitle: `${next.name} (${next.date})`, teamId: next.teamId || null, changes
  });
  const data = { lastLogId: log.id };
  for (const c of changes) data[c.field] = next[c.field] ?? null;
  await backend.commit([{ type: 'update', path: 'holidays/' + holiday.id, data }, log.op]);
  emit('leave');
  return { ...holiday, ...data };
}

// ------------------------------------------------------------------------ key dates
//
// Days worth marking on the calendar (Semester 1 starts, Exam week ...). Everyone signed in reads
// them. There are only a few dozen, so they are read in one go and kept for 10 minutes, then
// shared by Home, Calendar, the Weekly summary and the Alerts bell.

const KEYDATE_TTL = 10 * 60000;
export const keyDates = { list: [], at: 0, user: null };

export async function loadKeyDates({ force = false } = {}) {
  const now = Date.now();
  if (!force && keyDates.user === state.user?.id && now - keyDates.at < KEYDATE_TTL) return keyDates.list;
  const { docs } = await backend.query('keyDates', { where: [] });
  // Everyone can read them all, but a team's own dates are only shown to people who can see that team.
  const mine = new Set(myTeams().map((t) => t.id));
  keyDates.list = docs.filter((d) => d.active !== false && (!d.teamId || mine.has(d.teamId)));
  keyDates.at = now; keyDates.user = state.user?.id || null;
  return keyDates.list;
}

// Team Leaders and Managers add dates for their own team; Directors and Superusers for anyone.
export const canManageKeyDates = (u) => perm.isLeaderUp(u);
export const canManageKeyDateFor = (u, teamId) => perm.isDirector(u) || (perm.isLeaderUp(u) && !!teamId && perm.inTeam(u, teamId));

// draft: { title, startDate, endDate, teamId, category, yearly, note }. `existing` is null for a new one.
export async function saveKeyDate(existing, draft) {
  const next = {
    title: (draft.title || '').trim(), startDate: draft.startDate, endDate: draft.endDate || draft.startDate,
    teamId: draft.teamId || null, category: draft.category || 'other', yearly: draft.yearly === true,
    note: (draft.note || '').trim(), active: draft.active !== false
  };
  const problem = validateKeyDate(next);
  if (problem) throw new Error(problem);
  if (!canManageKeyDateFor(state.user, next.teamId)) {
    throw new Error(next.teamId ? 'You can only add key dates for your own team.' : 'Only the Director can add a key date for everyone. Choose your team instead.');
  }
  if (existing && !canManageKeyDateFor(state.user, existing.teamId)) throw new Error('You cannot change this key date.');
  const scope = next.teamId ? teamName(next.teamId) : 'Everyone';
  const resolve = (field, v) => (field === 'teamId' ? (v ? teamName(v) : 'Everyone') : field === 'yearly' ? (v ? 'Yes' : 'No') : field === 'category' ? KEY_CATEGORY_LABEL[v] || v : v);
  const FIELDS = ['title', 'startDate', 'endDate', 'teamId', 'category', 'yearly', 'note', 'active'];
  if (!existing) {
    const id = backend.newId('keyDates');
    const log = makeLog({
      action: 'keydate.create', entityType: 'keydate', entityId: id, entityTitle: `${next.title} (${next.startDate})`, teamId: next.teamId,
      changes: [{ field: 'startDate', from: '', to: next.startDate }, { field: 'endDate', from: '', to: next.endDate }, { field: 'teamId', from: '', to: scope }]
    });
    const doc = {
      title: next.title, startDate: next.startDate, endDate: next.endDate, teamId: next.teamId, category: next.category, yearly: next.yearly,
      ...(next.note ? { note: next.note } : {}), active: true,
      createdBy: state.user.id, createdAt: backend.ts(), updatedAt: backend.ts(), lastLogId: log.id
    };
    await backend.commit([{ type: 'set', path: 'keyDates/' + id, data: doc }, log.op]);
    keyDates.at = 0;
    emit('keydates');
    return { id, ...doc, createdAt: new Date(), updatedAt: new Date() };
  }
  const before = { ...existing, note: existing.note || '' };
  const changes = diffFields(before, next, FIELDS, resolve);
  if (!changes.length) return existing;
  const log = makeLog({
    action: 'keydate.update', entityType: 'keydate', entityId: existing.id, entityTitle: `${next.title} (${next.startDate})`, teamId: next.teamId, changes
  });
  const data = { lastLogId: log.id, updatedAt: backend.ts() };
  for (const c of changes) data[c.field] = c.field === 'note' && !next.note ? null : next[c.field];
  await backend.commit([{ type: 'update', path: 'keyDates/' + existing.id, data }, log.op]);
  keyDates.at = 0;
  emit('keydates');
  return { ...existing, ...data, updatedAt: new Date() };
}

// -------------------------------------------------------------------- activity log

// Director: anything. Manager / Team Leader: one team at a time. Everyone else: their own activity.
export async function loadLog({ teamId = null, actorId = null, fromISO = null, toISO = null, after = null, pageSize = 40 } = {}) {
  const where = [];
  if (teamId) where.push(['teamId', '==', teamId]);
  if (actorId) where.push(['actorId', '==', actorId]);
  if (fromISO) where.push(['ts', '>=', new Date(fromISO + 'T00:00:00')]);
  if (toISO) where.push(['ts', '<=', new Date(toISO + 'T23:59:59.999')]);
  return backend.query('activityLog', { where, orderBy: [['ts', 'desc']], limit: pageSize, after });
}

// ---------------------------------------------------------------- availability (task form)
//
// When someone picks an owner and a due date, the form can warn "Raj is on leave that day".
// Only people who may read their team's leave get this (Assistant Team Leader and above); the
// warning never says what kind of leave it is. Leave and holidays are kept for 5 minutes.

const AVAIL_TTL = 5 * 60 * 1000;
const availLeave = new Map();                    // teamId -> { at, docs }
let availHolidays = { at: 0, docs: [], user: null };

export async function availabilityData(teamIds) {
  const user = state.user;
  if (!user || !perm.isDeputyUp(user)) return { leaves: [], holidays: [] };
  const now = Date.now();
  const leaves = [];
  for (const id of [...new Set(teamIds.filter(Boolean))]) {
    if (!perm.isDirector(user) && !perm.inTeam(user, id)) continue;   // the rules would refuse it
    let hit = availLeave.get(id);
    if (!hit || now - hit.at > AVAIL_TTL || hit.user !== user.id) {
      try { hit = { at: now, user: user.id, docs: await loadTeamLeave(id, todayISO()) }; } catch { hit = { at: now, user: user.id, docs: [] }; }
      availLeave.set(id, hit);
    }
    leaves.push(...hit.docs);
  }
  if (availHolidays.user !== user.id || now - availHolidays.at > AVAIL_TTL) {
    try { availHolidays = { at: now, user: user.id, docs: await loadHolidays(todayISO()) }; } catch { availHolidays = { at: now, user: user.id, docs: [] }; }
  }
  return { leaves, holidays: availHolidays.docs };
}

// ---------------------------------------------------------------- task templates and recurring tasks
//
// A template is a saved task. With a repeat (weekly, monthly ...) the Planner makes the task for
// you. There is no server, so it happens when a Team Leader, Manager or Director opens the app:
// the task and the template's new "next date" are written together, so each occurrence is made
// once, and a fixed task id makes a second attempt fail instead of making a duplicate.

export const canUseTemplates = (u) => perm.isDeputyUp(u);        // pick one when creating a task
export const canManageTemplates = (u) => perm.isLeaderUp(u);     // create, edit, switch on and off
const TEMPLATE_TTL = 10 * 60 * 1000;
export const templates = { list: [], at: 0, userId: null };
const TRACKED_TEMPLATE_FIELDS = [
  'name', 'teamId', 'title', 'description', 'priority', 'projectId', 'estimateHours', 'dueInDays', 'tags',
  'checklist', 'ownerIds', 'repeat', 'nextDate', 'active'
];

export async function loadTemplates({ force = false } = {}) {
  const user = state.user;
  if (!user || !canUseTemplates(user)) return [];
  if (!force && templates.userId === user.id && templates.at && Date.now() - templates.at < TEMPLATE_TTL) return templates.list;
  const docs = perm.isDirector(user)
    ? (await backend.query('taskTemplates', { where: [] })).docs
    : (await Promise.all(myTeams().map((t) => backend.query('taskTemplates', { where: [['teamId', '==', t.id]] })))).flatMap((r) => r.docs);
  templates.list = docs.sort((a, b) => a.name.localeCompare(b.name));
  templates.at = Date.now();
  templates.userId = user.id;
  return templates.list;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function validateTemplateDraft(d) {
  if (!(d.name || '').trim()) return 'Please give the template a name.';
  if (d.name.trim().length > 100) return 'The template name is too long (100 characters at most).';
  if (!(d.title || '').trim()) return 'Please give the task a title.';
  if (d.title.trim().length > 200) return 'The title is too long (200 characters at most).';
  if (!d.teamId) return 'Please choose a team.';
  const owners = d.ownerIds || [];
  if (!owners.length) return 'Please choose who gets the task.';
  if (owners.length > MAX_TEMPLATE_OWNERS) return `A template can give the task to at most ${MAX_TEMPLATE_OWNERS} people.`;
  if (!REPEATS.includes(d.repeat)) return 'Please choose how often it repeats.';
  if (d.repeat !== 'none' && !DAY_RE.test(d.nextDate || '')) return 'Please choose the date of the first task.';
  if (d.dueInDays !== '' && d.dueInDays !== null && d.dueInDays !== undefined) {
    const n = Number(d.dueInDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) return '"Due after" must be a whole number of days from 0 to 365.';
  }
  if (d.estimateHours !== '' && d.estimateHours !== null && d.estimateHours !== undefined && (isNaN(Number(d.estimateHours)) || Number(d.estimateHours) < 0)) {
    return 'The estimate must be a number of hours (0 or more).';
  }
  return null;
}

export async function saveTemplate(existing, draft) {
  const problem = validateTemplateDraft(draft);
  if (problem) throw new Error(problem);
  const steps = (draft.checklist || []).map((c) => ({ id: c.id, text: String(c.text || '').trim().slice(0, 200) })).filter((c) => c.text).slice(0, 60);
  const next = {
    name: draft.name.trim(), teamId: draft.teamId, title: draft.title.trim(), description: draft.description || '',
    priority: draft.priority || 'medium', projectId: cleanText(draft.projectId), estimateHours: cleanNum(draft.estimateHours),
    dueInDays: draft.dueInDays === '' || draft.dueInDays === null || draft.dueInDays === undefined ? null : Number(draft.dueInDays),
    tags: cleanTags(draft.tags), checklist: steps, ownerIds: [...new Set(draft.ownerIds)],
    repeat: draft.repeat, nextDate: draft.repeat === 'none' ? null : draft.nextDate,
    active: draft.active !== false
  };
  next.anchorDay = next.nextDate ? Number(next.nextDate.slice(8)) : null;
  const stamp = backend.ts();
  if (!existing) {
    const id = backend.newId('taskTemplates');
    const log = makeLog({
      action: 'template.create', entityType: 'template', entityId: id, entityTitle: next.name, teamId: next.teamId,
      changes: [{ field: 'repeat', from: '', to: next.repeat }, ...(next.nextDate ? [{ field: 'nextDate', from: '', to: next.nextDate }] : [])]
    });
    const doc = { ...next, lastRunDate: null, createdBy: state.user.id, createdAt: stamp, updatedAt: stamp, lastLogId: log.id };
    await backend.commit([{ type: 'set', path: 'taskTemplates/' + id, data: doc }, log.op]);
    const local = { id, ...doc, createdAt: new Date(), updatedAt: new Date() };
    templates.list = [...templates.list, local].sort((a, b) => a.name.localeCompare(b.name));
    emit('templates');
    return local;
  }
  const changes = diffFields({ ...existing, tags: existing.tags || [], checklist: existing.checklist || [] }, next, TRACKED_TEMPLATE_FIELDS, resolveForLog);
  if (!changes.length) return null;
  const log = makeLog({ action: 'template.update', entityType: 'template', entityId: existing.id, entityTitle: next.name, teamId: next.teamId, changes });
  const patch = { updatedAt: stamp, lastLogId: log.id, anchorDay: next.anchorDay };
  for (const c of changes) patch[c.field] = next[c.field];
  await backend.commit([{ type: 'update', path: 'taskTemplates/' + existing.id, data: patch }, log.op]);
  const local = { ...existing, ...patch, updatedAt: new Date() };
  templates.list = templates.list.map((t) => (t.id === existing.id ? local : t)).sort((a, b) => a.name.localeCompare(b.name));
  emit('templates');
  return local;
}

// {month}, {year} and {date} in a template's title or description become the occurrence's date.
export function fillTokens(text, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const month = new Date(y, m - 1, d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return String(text || '').replaceAll('{month}', month).replaceAll('{year}', String(y))
    .replaceAll('{date}', new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
}

// The form's draft for a template (used by "Start from a template" and by the generator).
export function draftFromTemplate(tpl, iso = todayISO()) {
  return {
    title: fillTokens(tpl.title, iso), description: fillTokens(tpl.description || '', iso),
    teamId: tpl.teamId, projectId: tpl.projectId || '', priority: tpl.priority || 'medium',
    estimateHours: tpl.estimateHours ?? '', startDate: iso, dueDate: dueDateFor(tpl, iso) || '',
    tags: [...(tpl.tags || [])], blockedBy: [],
    checklist: (tpl.checklist || []).map((c) => ({ id: c.id, text: fillTokens(c.text, iso), done: false }))
  };
}

// Makes the tasks that are due from one template, and moves its next date on. Returns how many were made.
async function makeOccurrence(tpl, due) {
  const status = statusById(INITIAL_STATUS_ID);
  if (!status) return 0;
  const owners = (tpl.ownerIds || []).filter((id) => {
    const u = userById(id);
    return u && u.active !== false && (u.teamIds || []).includes(tpl.teamId);
  });
  if (!owners.length) return 0;
  const draft = draftFromTemplate(tpl, due.date);
  const built = owners.map((ownerId) => buildTask(draft, ownerId, status, {
    id: occurrenceTaskId(tpl.id, due.date, ownerId), recurringId: tpl.id, recurringName: tpl.name
  }));
  const stamp = backend.ts();
  const log = makeLog({
    action: 'template.run', entityType: 'template', entityId: tpl.id, entityTitle: tpl.name, teamId: tpl.teamId,
    changes: [
      { field: 'nextDate', from: tpl.nextDate, to: due.next },
      { field: 'recurring', from: '', to: `${owners.length} task${owners.length === 1 ? '' : 's'} for ${due.date}${due.skipped ? ` (${due.skipped} earlier skipped)` : ''}` }
    ]
  });
  const patch = { nextDate: due.next, lastRunDate: due.date, updatedAt: stamp, lastLogId: log.id };
  await backend.commit([
    ...built.flatMap((b) => [{ type: 'set', path: 'tasks/' + b.id, data: b.task }, b.log.op]),
    { type: 'update', path: 'taskTemplates/' + tpl.id, data: patch },
    log.op
  ]);
  const now = new Date();
  for (const b of built) state.tasks.set(b.id, { id: b.id, ...b.task, createdAt: now, updatedAt: now, assignedAt: now });
  templates.list = templates.list.map((t) => (t.id === tpl.id ? { ...t, nextDate: due.next, lastRunDate: due.date } : t));
  return built.length;
}

let recurringBusy = false;
// Called when a Team Leader, Manager or Director opens the app (and from the Templates page).
// Returns the number of tasks made. A failure (for example someone else just made them) is not an error.
export async function runRecurring({ force = true } = {}) {
  const user = state.user;
  if (!user || recurringBusy || !perm.isLeaderUp(user)) return 0;
  recurringBusy = true;
  let made = 0;
  try {
    const today = todayISO();
    for (const tpl of await loadTemplates({ force })) {
      if (!perm.isDirector(user) && !perm.inTeam(user, tpl.teamId)) continue;
      const due = dueOccurrence(tpl, today);
      if (!due) continue;
      try { made += await makeOccurrence(tpl, due); } catch (err) { console.warn('Recurring task skipped:', err?.message || err); }
    }
    if (made) { emit('tasks'); emit('templates'); }
  } catch (err) {
    console.warn('Could not check recurring tasks:', err?.message || err);
  } finally {
    recurringBusy = false;
  }
  return made;
}

export { toDate };
