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
  PRIORITY_LABEL, ROLE_LABEL
} from './model.js';
import { diffFields, summarize, taskAction } from './log.js';
import { todayISO, toDate } from './util.js';
import * as perm from './perm.js';

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
  emit('ref');
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
  applyRef({ ...state.ref });
  if (kind === 'users' && doc.id === state.user.id) state.user = { ...state.user, ...doc };
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
  if (!d.ownerId) return 'Please choose an owner.';
  if (d.startDate && d.dueDate && d.dueDate < d.startDate) return 'The due date is before the start date.';
  if (d.estimateHours !== '' && d.estimateHours !== null && d.estimateHours !== undefined) {
    const n = Number(d.estimateHours);
    if (isNaN(n) || n < 0) return 'The estimate must be a number of hours (0 or more).';
  }
  return null;
}

const cleanNum = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const cleanText = (v) => (v === '' || v === undefined ? null : v);

export async function createTask(draft) {
  const problem = validateTaskDraft(draft);
  if (problem) throw new Error(problem);
  const status = statusById(draft.status || INITIAL_STATUS_ID);
  if (!status) throw new Error('The default statuses are not set up yet. Ask the Director to set them up.');

  const id = backend.newId('tasks');
  const stamp = backend.ts();
  const log = makeLog({
    action: 'task.create', entityType: 'task', entityId: id,
    entityTitle: draft.title.trim(), teamId: draft.teamId,
    changes: [
      { field: 'ownerId', from: '', to: userName(draft.ownerId) },
      { field: 'status', from: '', to: status.name },
      ...(draft.dueDate ? [{ field: 'dueDate', from: '', to: draft.dueDate }] : []),
      { field: 'priority', from: '', to: PRIORITY_LABEL[draft.priority || 'medium'] }
    ]
  });
  const task = {
    title: draft.title.trim(), description: draft.description || '',
    teamId: draft.teamId, projectId: cleanText(draft.projectId), ownerId: draft.ownerId,
    createdBy: state.user.id,
    status: status.id, statusCategory: status.category, statusNote: null,
    priority: draft.priority || 'medium',
    startDate: cleanText(draft.startDate), dueDate: cleanText(draft.dueDate),
    estimateHours: cleanNum(draft.estimateHours),
    checklist: draft.checklist || [], archived: false,
    completedAt: null, completedDate: null, submits: 0, reworks: 0,
    createdAt: stamp, updatedAt: stamp, lastLogId: log.id
  };
  await backend.commit([{ type: 'set', path: 'tasks/' + id, data: task }, log.op]);
  const now = new Date();
  const local = { id, ...task, createdAt: now, updatedAt: now };
  state.tasks.set(id, local);
  emit('tasks');
  return local;
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

  const normalised = {
    ...next,
    projectId: cleanText(next.projectId), startDate: cleanText(next.startDate),
    dueDate: cleanText(next.dueDate), estimateHours: cleanNum(next.estimateHours),
    statusNote: cleanText(next.statusNote), description: next.description || ''
  };

  const changes = diffFields(original, normalised, TRACKED_TASK_FIELDS, resolveForLog);
  if (!changes.length) return null;

  const stamp = backend.ts();
  const log = makeLog({
    action: taskAction(changes), entityType: 'task', entityId: original.id,
    entityTitle: normalised.title, teamId: normalised.teamId, changes
  });

  // Send only the fields that changed, plus what the system derives.
  const patch = {};
  for (const c of changes) patch[c.field] = normalised[c.field];
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

export async function createPerson({ name, email, role, teamIds, password, sendReset }) {
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
      { field: 'teamIds', from: '', to: teamIds.map(teamName).join(', ') }
    ]
  });
  const doc = {
    name: name.trim(), email: email.trim(), role, teamIds, active: true,
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

export async function updatePerson(user, patch) {
  const next = { ...user, ...patch };
  const changes = diffFields(user, next, ['name', 'role', 'teamIds', 'active'], resolveForLog);
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

export async function createProject({ name, teamId, description }) {
  if (!name.trim()) throw new Error('Please enter a project name.');
  if (!teamId) throw new Error('Please choose a team for the project.');
  const id = backend.newId('projects');
  const log = makeLog({ action: 'project.create', entityType: 'project', entityId: id, entityTitle: name.trim(), teamId });
  const doc = {
    name: name.trim(), teamId, description: description || '', active: true,
    createdAt: backend.ts(), lastLogId: log.id
  };
  await backend.commit([{ type: 'set', path: 'projects/' + id, data: doc }, log.op]);
  patchRef('projects', { id, ...doc, createdAt: new Date() });
  return id;
}

export async function updateProject(project, patch) {
  const next = { ...project, ...patch };
  const changes = diffFields(project, next, ['name', 'teamId', 'description', 'active'], resolveForLog);
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
