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
  PRIORITY_LABEL, ROLE_LABEL, LEAVE_TYPES, LEAVE_TYPE_LABEL, LEAVE_STATUS_LABEL, HALF_LABEL
} from './model.js';
import { diffFields, summarize, taskAction } from './log.js';
import { todayISO, toDate } from './util.js';
import * as perm from './perm.js';
import { deriveStepFields, cleanSteps, dropOutsiders } from './steps.js';
import { applyTheme, isTheme } from './theme.js';

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
  'priority', 'startDate', 'dueDate', 'estimateHours', 'checklist', 'archived'
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

function buildTask(draft, ownerId, status) {
  const teamId = teamForOwner(draft, ownerId);
  const { steps, dropped } = dropOutsiders(cleanSteps(draft.checklist), teamId, teamIdsOf);
  const id = backend.newId('tasks');
  const stamp = backend.ts();
  const log = makeLog({
    action: 'task.create', entityType: 'task', entityId: id,
    entityTitle: draft.title.trim(), teamId,
    changes: [
      { field: 'ownerId', from: '', to: userName(ownerId) },
      { field: 'status', from: '', to: status.name },
      ...(draft.dueDate ? [{ field: 'dueDate', from: '', to: draft.dueDate }] : []),
      { field: 'priority', from: '', to: PRIORITY_LABEL[draft.priority || 'medium'] }
    ]
  });
  const task = {
    title: draft.title.trim(), description: draft.description || '',
    teamId, projectId: cleanText(draft.projectId), ownerId,
    createdBy: state.user.id,
    status: status.id, statusCategory: status.category, statusNote: null,
    priority: draft.priority || 'medium',
    startDate: cleanText(draft.startDate), dueDate: cleanText(draft.dueDate),
    estimateHours: cleanNum(draft.estimateHours),
    checklist: steps, ...deriveStepFields(steps), archived: false,
    completedAt: null, completedDate: null, submits: 0, reworks: 0,
    createdAt: stamp, updatedAt: stamp, lastLogId: log.id
  };
  return { id, task, log, dropped };
}

// Gives the same task to one or more people: one separate task for each person, so each can
// move their own copy through the statuses. Returns the tasks created (and how many step
// assignments had to be dropped because the person is not in that task's team).
export async function createTasks(draft, ownerIds) {
  const people = [...new Set((ownerIds && ownerIds.length ? ownerIds : [draft.ownerId]).filter(Boolean))];
  const problem = validateTaskDraft({ ...draft, ownerId: people[0] || '' });
  if (problem) throw new Error(problem);
  if (people.length > MAX_ASSIGNEES) throw new Error(`Please choose at most ${MAX_ASSIGNEES} people at a time.`);
  if (people.length > 1 && perm.isMember(state.user) && !perm.ownsProject(state.user, draft.projectId)) {
    throw new Error('Only an Assistant Team Leader or above can give a task to other people.');
  }
  const status = statusById(draft.status || INITIAL_STATUS_ID);
  if (!status) throw new Error('The default statuses are not set up yet. Ask the Director to set them up.');

  const built = people.map((ownerId) => buildTask(draft, ownerId, status));
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

  const normalised = {
    ...next,
    checklist: steps,
    projectId: cleanText(next.projectId), startDate: cleanText(next.startDate),
    dueDate: cleanText(next.dueDate), estimateHours: cleanNum(next.estimateHours),
    statusNote: cleanText(next.statusNote), description: next.description || ''
  };

  // Compare steps in one canonical form so key order in stored data never shows up as a change.
  const changes = diffFields({ ...original, checklist: cleanSteps(original.checklist) }, normalised, TRACKED_TASK_FIELDS, resolveForLog);
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

export async function addComment(task, text) {
  const clean = (text || '').trim();
  if (!clean) throw new Error('Please type a comment first.');
  if (clean.length > 2000) throw new Error('That comment is too long (2000 characters at most).');
  const commentId = backend.newId(`tasks/${task.id}/comments`);
  const log = makeLog({
    action: 'comment.add', entityType: 'comment', entityId: commentId,
    entityTitle: task.title, teamId: task.teamId,
    changes: [{ field: 'text', from: '', to: clean.length > 120 ? clean.slice(0, 117) + '...' : clean }]
  });
  const comment = {
    authorId: state.user.id, authorName: state.user.name, text: clean,
    createdAt: backend.ts(), logId: log.id
  };
  await backend.commit([{ type: 'set', path: `tasks/${task.id}/comments/${commentId}`, data: comment }, log.op]);
  return { id: commentId, ...comment, createdAt: new Date() };
}

// ----------------------------------------------------------------------- people

export async function createPerson({ name, email, role, teamIds, password, sendReset, superuser = false }) {
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
      ...(superuser ? [{ field: 'superuser', from: '', to: 'yes' }] : [])
    ]
  });
  const doc = {
    name: name.trim(), email: email.trim(), role, teamIds, active: true,
    ...(superuser ? { superuser: true } : {}),
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
  const before = { ...user, superuser: user.superuser === true };
  const next = { ...before, ...patch };
  if (patch.superuser !== undefined) next.superuser = patch.superuser === true;
  if (user.id === state.user.id) {
    if (next.active === false) throw new Error('You cannot deactivate your own account.');
    if (!keepsFullPower(next)) {
      throw new Error('That would remove your own admin powers. Tick "Superuser access" first, or ask another Director or Superuser to change your role.');
    }
  }
  const changes = diffFields(before, next, ['name', 'role', 'teamIds', 'active', 'superuser'], resolveForLog);
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
  const clash = existing.find((l) => l.userId === person.id && ['pending', 'approved'].includes(l.status)
    && teamIds.includes(l.teamId) && l.startDate <= endDate && l.endDate >= startDate);
  if (clash) throw new Error(`${person.name} already has leave from ${rangeText(clash)} (${LEAVE_STATUS_LABEL[clash.status].toLowerCase()}).`);

  const forOthers = person.id !== state.user.id;
  if (forOthers) {
    for (const teamId of teamIds) {
      if (!perm.canRecordLeaveFor(state.user, person, teamId)) throw new Error('Your role cannot record leave for that person.');
    }
  }
  const approvedNow = forOthers || perm.isDirector(state.user);
  const stamp = backend.ts();
  const ops = [];
  const created = [];
  for (const teamId of teamIds) {
    const id = backend.newId('leaves');
    const doc = {
      userId: person.id, userName: person.name, teamId,
      type: draft.type, startDate, endDate, half: draft.half, reason: draft.reason,
      status: approvedNow ? 'approved' : 'pending',
      requestedBy: state.user.id,
      decidedBy: approvedNow ? state.user.id : null, decidedAt: approvedNow ? stamp : null, decisionNote: null,
      createdAt: stamp, updatedAt: stamp, lastLogId: ''
    };
    const log = makeLog({
      action: approvedNow ? 'leave.record' : 'leave.request', entityType: 'leave', entityId: id,
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
    created.push({ id, ...doc, createdAt: now, updatedAt: now, decidedAt: approvedNow ? now : null });
  }
  await backend.commit(ops);
  emit('leave');
  return created;
}

export async function decideLeave(leave, decision, note) {
  const approve = decision === 'approve';
  const text = (note || '').trim();
  if (!approve && !text) throw new Error('Please give a short reason for declining.');
  if (!perm.canApproveLeave(state.user, leave)) throw new Error('Your role cannot decide on this leave.');
  const stamp = backend.ts();
  const status = approve ? 'approved' : 'declined';
  const log = makeLog({
    action: approve ? 'leave.approve' : 'leave.decline', entityType: 'leave', entityId: leave.id,
    entityTitle: leaveTitle(leave), teamId: leave.teamId,
    changes: [
      { field: 'status', from: LEAVE_STATUS_LABEL[leave.status], to: LEAVE_STATUS_LABEL[status] },
      ...(text ? [{ field: 'decisionNote', from: '', to: text.slice(0, 120) }] : [])
    ]
  });
  const patch = { status, decidedBy: state.user.id, decidedAt: stamp, decisionNote: text || null, updatedAt: stamp, lastLogId: log.id };
  await backend.commit([{ type: 'update', path: 'leaves/' + leave.id, data: patch }, log.op]);
  emit('leave');
  const now = new Date();
  return { ...leave, ...patch, decidedAt: now, updatedAt: now };
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

export async function loadPendingLeave(teamId) {
  const { docs } = await backend.query('leaves', { where: [['teamId', '==', teamId], ['status', '==', 'pending']] });
  return docs;
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

export { toDate };
