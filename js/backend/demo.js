// Demo backend: the same interface as firebase.js, but everything lives in the
// browser (localStorage). It is used while Firebase is not configured so you can
// try every screen with sample data. It does NOT enforce the Security Rules; the
// screens still hide actions by role, but real protection only exists with Firebase.

import { DEFAULT_STATUSES } from '../core/model.js';
import { addDays, todayISO, uid20 } from '../core/util.js';

const STORE_KEY = 'planner-demo-v1';
const SESSION_KEY = 'planner-demo-session';
const SERVER_TS = { __serverTimestamp: true };

let data = {};              // { 'tasks': {id: doc}, 'tasks/abc/comments': {...}, ... }
let auth = {};              // { uid: { email, password } }
let currentUid = null;
const authListeners = new Set();
const watchers = new Set();

// ------------------------------------------------------------- persistence

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ data, auth }, function (k, v) {
      const raw = this[k];
      return raw instanceof Date ? { $d: raw.toISOString() } : v;
    }));
  } catch { /* storage unavailable: demo still works for this page view */ }
}

function load() {
  try {
    const text = localStorage.getItem(STORE_KEY);
    if (!text) return false;
    const parsed = JSON.parse(text, (k, v) => (v && v.$d ? new Date(v.$d) : v));
    data = parsed.data; auth = parsed.auth;
    return true;
  } catch { return false; }
}

export function resetDemo() {
  try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  location.reload();
}

// ------------------------------------------------------------------ queries

const norm = (v) => (v === undefined ? null : v);
const num = (v) => (v instanceof Date ? v.getTime() : v);

function matches(doc, [field, op, value]) {
  const v = norm(doc[field]);
  switch (op) {
    case '==': return num(v) === num(norm(value));
    case '!=': return num(v) !== num(norm(value));
    case 'in': return value.some((x) => num(x) === num(v));
    case 'not-in': return !value.some((x) => num(x) === num(v));
    case '>=': return v !== null && num(v) >= num(value);
    case '<=': return v !== null && num(v) <= num(value);
    case '>': return v !== null && num(v) > num(value);
    case '<': return v !== null && num(v) < num(value);
    case 'array-contains': return Array.isArray(v) && v.includes(value);
    case 'array-contains-any': return Array.isArray(v) && v.some((x) => value.includes(x));
    default: throw new Error('Demo backend does not support operator ' + op);
  }
}

function run(path, opts = {}) {
  let rows = Object.entries(data[path] || {}).map(([id, d]) => ({ id, ...structuredCloneSafe(d) }));
  for (const clause of opts.where || []) rows = rows.filter((r) => matches(r, clause));
  for (const [field, dir] of [...(opts.orderBy || [])].reverse()) {
    rows.sort((a, b) => {
      const x = num(norm(a[field])), y = num(norm(b[field]));
      if (x === y) return 0;
      if (x === null) return -1;
      if (y === null) return 1;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    });
  }
  const start = opts.after ? opts.after.offset : 0;
  let end = rows.length;
  if (opts.limit) end = Math.min(rows.length, start + opts.limit);
  const page = rows.slice(start, end);
  return { docs: page, cursor: page.length ? { offset: end } : null };
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj, function (k, v) {
    const raw = this[k];
    return raw instanceof Date ? { $d: raw.toISOString() } : v;
  }), (k, v) => (v && v.$d ? new Date(v.$d) : v));
}

function resolveSentinels(value) {
  if (value === SERVER_TS) return new Date();
  if (Array.isArray(value)) return value.map(resolveSentinels);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveSentinels(v)]));
  }
  return value;
}

function splitPath(path) {
  const parts = path.split('/');
  const id = parts.pop();
  return [parts.join('/'), id];
}

function notifyWatchers() { for (const w of [...watchers]) w(); }

// ------------------------------------------------------------------ backend

export const backend = {
  mode: 'demo',

  async init() {
    if (!load()) seed();
    try { currentUid = localStorage.getItem(SESSION_KEY); } catch { currentUid = null; }
    if (currentUid && !auth[currentUid]) currentUid = null;
  },

  onAuth(callback) {
    const emit = () => callback(currentUid ? { uid: currentUid, email: auth[currentUid].email } : null);
    authListeners.add(emit);
    setTimeout(emit, 0);
    return () => authListeners.delete(emit);
  },

  async signIn(email, password) {
    const entry = Object.entries(auth).find(([, a]) => a.email.toLowerCase() === email.trim().toLowerCase());
    if (!entry || entry[1].password !== password) {
      const err = new Error('Wrong email or password.');
      err.code = 'auth/invalid-credential';
      throw err;
    }
    currentUid = entry[0];
    try { localStorage.setItem(SESSION_KEY, currentUid); } catch { /* ignore */ }
    authListeners.forEach((l) => l());
    return { uid: currentUid, email: entry[1].email };
  },

  async signOut() {
    currentUid = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    authListeners.forEach((l) => l());
  },

  async resetPassword() { /* demo: nothing to send */ },

  async createAccount(email, password) {
    if (Object.values(auth).some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      const err = new Error('That email already has an account.');
      err.code = 'auth/email-already-in-use';
      throw err;
    }
    const uid = 'u_' + uid20().slice(0, 10).toLowerCase();
    auth[uid] = { email, password };
    save();
    return uid;
  },

  async getDoc(path) {
    const [col, id] = splitPath(path);
    const doc = (data[col] || {})[id];
    return doc ? { id, ...structuredCloneSafe(doc) } : null;
  },

  async query(path, opts = {}) { return run(path, opts); },

  watch(path, opts, onData) {
    const push = () => onData(run(path, opts).docs);
    watchers.add(push);
    setTimeout(push, 0);
    return () => watchers.delete(push);
  },

  async commit(ops) {
    // All or nothing: work on a copy and only keep it if every operation succeeds.
    const next = structuredCloneSafe(data);
    for (const op of ops) {
      const [col, id] = splitPath(op.path);
      next[col] = next[col] || {};
      const incoming = resolveSentinels(op.data);
      if (op.type === 'set') next[col][id] = incoming;
      else {
        if (!next[col][id]) throw new Error('Cannot update a missing document: ' + op.path);
        next[col][id] = { ...next[col][id], ...incoming };
      }
    }
    data = next;
    save();
    notifyWatchers();
  },

  ts() { return SERVER_TS; },
  newId() { return uid20(); }
};

// --------------------------------------------------------------------- seed

function seed() {
  const now = new Date();
  const day = (offset) => addDays(todayISO(), offset);
  const put = (col, id, doc) => { (data[col] = data[col] || {})[id] = doc; };

  const people = [
    ['dana',   'Dana Tan',     'director',    []],
    ['marcus', 'Marcus Lim',   'manager',     ['content', 'dev']],
    ['lena',   'Lena Wong',    'leader',      ['content']],
    ['devi',   'Devi Nair',    'leader',      ['dev']],
    ['arun',   'Arun Raj',     'asst_leader', ['content']],
    ['mei',    'Mei Ling',     'member',      ['content']],
    ['omar',   'Omar Hakim',   'member',      ['content']],
    ['priya',  'Priya Kumar',  'member',      ['dev']],
    ['raj',    'Raj Singh',    'member',      ['dev']]
  ];
  for (const [id, name, role, teamIds] of people) {
    put('users', id, {
      name, email: `${id}@demo.test`, role, teamIds, active: true,
      createdAt: now, lastLoginAt: id === 'dana' ? now : null, lastLogId: 'seed'
    });
    auth[id] = { email: `${id}@demo.test`, password: 'demo' };
  }

  put('teams', 'content', { name: 'Content Team', approvalGate: true, active: true, createdAt: now, lastLogId: 'seed' });
  put('teams', 'dev', { name: 'Development Team', approvalGate: true, active: true, createdAt: now, lastLogId: 'seed' });

  put('projects', 'p_edu', { name: 'EduEdge Term 1', teamId: 'content', description: 'Chapter amendments and QC rounds', active: true, createdAt: now, lastLogId: 'seed' });
  put('projects', 'p_game', { name: 'EduGames Level Build', teamId: 'dev', description: 'Scene integration and releases', active: true, createdAt: now, lastLogId: 'seed' });

  for (const s of DEFAULT_STATUSES) {
    const { id, ...rest } = s;
    put('statuses', id, { ...rest, active: true, lastLogId: 'seed' });
  }
  const cat = Object.fromEntries(DEFAULT_STATUSES.map((s) => [s.id, s.category]));

  // [title, team, project, owner, status, priority, dueOffset, estimateHours, createdBy, note]
  const tasks = [
    ['Amend Chapter 1 (BM, English, Chinese)', 'content', 'p_edu', 'mei', 'in_progress', 'high', 3, 8, 'lena'],
    ['Amend Chapter 2 (BM, English, Chinese)', 'content', 'p_edu', 'mei', 'pending', 'medium', 10, 8, 'lena'],
    ['QC round 2: Chapter 7 English', 'content', 'p_edu', 'omar', 'in_review', 'high', 1, 4, 'lena'],
    ['Prepare Term 2 content sheet', 'content', 'p_edu', 'omar', 'rework', 'medium', -2, 6, 'lena', 'Feedback: Chinese titles are missing'],
    ['Proofread T4 stories (Chinese)', 'content', 'p_edu', 'mei', 'completed', 'medium', -5, 5, 'lena'],
    ['Weekly content report', 'content', 'p_edu', 'lena', 'in_progress', 'low', 0, 1, 'lena'],
    ['Review chapter feedback v3', 'content', 'p_edu', 'arun', 'pending', 'medium', 2, 3, 'lena'],
    ['Wait for artwork from APD', 'content', 'p_edu', 'omar', 'blocked', 'high', 4, 2, 'lena', 'Waiting for APD artwork'],
    ['Scene integration L1 Chapter 3', 'dev', 'p_game', 'priya', 'in_progress', 'high', 5, 12, 'devi'],
    ['Prefab creation L1 Chapter 4', 'dev', 'p_game', 'raj', 'pending', 'medium', 8, 10, 'devi'],
    ['Addressable bundle build', 'dev', 'p_game', 'priya', 'in_review', 'high', 1, 5, 'devi'],
    ['Fix audio sync bug', 'dev', 'p_game', 'raj', 'in_progress', 'urgent', -1, 3, 'devi'],
    ['External QC fixes', 'dev', 'p_game', 'raj', 'completed', 'medium', -3, 6, 'devi'],
    ['Approve Q4 content calendar', 'content', null, 'marcus', 'pending', 'medium', 6, 2, 'dana'],
    ['Review quarterly productivity', 'content', null, 'dana', 'pending', 'low', 14, 3, 'dana']
  ];

  tasks.forEach(([title, teamId, projectId, ownerId, status, priority, dueOffset, est, createdBy, note], i) => {
    const id = 't' + String(i + 1).padStart(2, '0');
    const done = cat[status] === 'done';
    put('tasks', id, {
      title, description: '', teamId, projectId, ownerId, createdBy,
      status, statusCategory: cat[status], statusNote: note || null,
      priority, startDate: day(dueOffset - 7), dueDate: day(dueOffset), estimateHours: est,
      checklist: i === 0 ? [
        { id: 'c1', text: 'BM version', done: true },
        { id: 'c2', text: 'English version', done: true },
        { id: 'c3', text: 'Chinese version', done: false }
      ] : [],
      archived: false,
      completedAt: done ? new Date(now.getTime() - 86400000 * 2) : null,
      completedDate: done ? day(dueOffset + 1) : null,
      submits: cat[status] === 'review' || done ? 1 : 0,
      reworks: status === 'rework' ? 1 : 0,
      createdAt: new Date(now.getTime() - 86400000 * 7), updatedAt: now, lastLogId: 'log_' + id
    });
    const owner = people.find((p) => p[0] === createdBy);
    put('activityLog', 'log_' + id, {
      ts: new Date(now.getTime() - 86400000 * 7), actorId: createdBy, actorName: owner[1], actorRole: owner[2],
      action: 'task.create', entityType: 'task', entityId: id, entityTitle: title, teamId, changes: [],
      summary: `Created task "${title}"`
    });
  });

  put('tasks/t03/comments', 'c_demo1', {
    authorId: 'lena', authorName: 'Lena Wong', text: 'Sent to QC. Please check the BM version first.',
    createdAt: new Date(now.getTime() - 3600000 * 5), logId: 'seed'
  });
  save();
}
