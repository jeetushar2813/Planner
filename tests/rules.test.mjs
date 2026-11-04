// Security Rules tests. Run with:  npm run test:rules
// (needs Node 20+, Java 11+ and the Firebase CLI: npm i -g firebase-tools)
//
// These tests talk to the local Firestore emulator, never to your real project.
// They check the permission table: who may read, create, change and never delete,
// and that every change must come with a matching activity-log entry.

import { readFileSync } from 'node:fs';
import { test, before, after, beforeEach, describe } from 'node:test';
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  writeBatch, serverTimestamp
} from 'firebase/firestore';

let env;
let seq = 0;
const id = (p) => `${p}${++seq}`;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-planner',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
  });
});
after(async () => { await env.cleanup(); });

// ---------------------------------------------------------------- fixtures

const USERS = {
  dir:   { role: 'director',    teamIds: [] },
  mgrA:  { role: 'manager',     teamIds: ['teamA'] },
  ldrA:  { role: 'leader',      teamIds: ['teamA'] },
  asstA: { role: 'asst_leader', teamIds: ['teamA'] },
  memA1: { role: 'member',      teamIds: ['teamA'] },
  memA2: { role: 'member',      teamIds: ['teamA'] },
  memB:  { role: 'member',      teamIds: ['teamB'] },
  memC:  { role: 'member',      teamIds: ['teamC'] },
  ldrB:  { role: 'leader',      teamIds: ['teamB'] },
  gone:  { role: 'member',      teamIds: ['teamA'], active: false },
  // A Superuser keeps a normal role but has every power of the Director.
  su:     { role: 'leader', teamIds: ['teamA'], superuser: true },
  suGone: { role: 'leader', teamIds: ['teamA'], superuser: true, active: false },
  notSu:  { role: 'leader', teamIds: ['teamA'], superuser: false },
  // HR: a switch on the account. The role and team stay normal.
  hrM:    { role: 'member', teamIds: ['teamC'], hr: true },
  hrLdr:  { role: 'leader', teamIds: ['teamC'], hr: true },
  hrGone: { role: 'member', teamIds: ['teamC'], hr: true, active: false }
};

const STATUSES = {
  pending:    { name: 'Pending',     category: 'todo' },
  inprogress: { name: 'In Progress', category: 'active' },
  review:     { name: 'In Review',   category: 'review' },
  onhold:     { name: 'On Hold',     category: 'paused' },
  done:       { name: 'Completed',   category: 'done' },
  cancelled:  { name: 'Cancelled',   category: 'closed' }
};

function taskDoc(over = {}) {
  return {
    title: 'A task', description: '', teamId: 'teamA', projectId: null, ownerId: 'memA1',
    createdBy: 'ldrA', status: 'pending', statusCategory: 'todo', statusNote: null,
    priority: 'medium', startDate: null, dueDate: '2026-12-01', estimateHours: null,
    checklist: [], archived: false, completedAt: null, completedDate: null,
    submits: 0, reworks: 0, createdAt: new Date(), updatedAt: new Date(), lastLogId: 'seedlog',
    ...over
  };
}

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [uid, u] of Object.entries(USERS)) {
      await setDoc(doc(db, 'users', uid), {
        name: uid, email: `${uid}@x.test`, active: true, createdAt: new Date(),
        lastLoginAt: null, lastLogId: 'seedlog', ...u
      });
    }
    for (const [sid, s] of Object.entries(STATUSES)) {
      await setDoc(doc(db, 'statuses', sid), { color: '#888', order: 1, active: true, needsReason: false, lastLogId: 'seedlog', ...s });
    }
    await setDoc(doc(db, 'teams', 'teamA'), { name: 'A', approvalGate: true,  active: true, createdAt: new Date(), lastLogId: 'seedlog' });
    await setDoc(doc(db, 'teams', 'teamB'), { name: 'B', approvalGate: true,  active: true, createdAt: new Date(), lastLogId: 'seedlog' });
    await setDoc(doc(db, 'teams', 'teamC'), { name: 'C', approvalGate: false, active: true, createdAt: new Date(), lastLogId: 'seedlog' });
    await setDoc(doc(db, 'tasks', 'tA1'), taskDoc({ ownerId: 'memA1' }));
    await setDoc(doc(db, 'tasks', 'tA2'), taskDoc({ ownerId: 'memA2' }));
    await setDoc(doc(db, 'tasks', 'tB1'), taskDoc({ ownerId: 'memB', teamId: 'teamB' }));
    await setDoc(doc(db, 'tasks', 'tC1'), taskDoc({ ownerId: 'memC', teamId: 'teamC' }));
    await setDoc(doc(db, 'tasks', 'tAdone'), taskDoc({ ownerId: 'memA1', status: 'done', statusCategory: 'done', completedAt: new Date(), completedDate: '2026-11-01' }));
    // an old log entry for read tests
    await setDoc(doc(db, 'activityLog', 'oldA'), logBody('memA1', 'member', 'task', 'tA1', 'teamA', new Date()));
    await setDoc(doc(db, 'activityLog', 'oldB'), logBody('memB', 'member', 'task', 'tB1', 'teamB', new Date()));
  });
});

const as = (uid) => env.authenticatedContext(uid).firestore();

function logBody(actorId, actorRole, entityType, entityId, teamId, ts = serverTimestamp()) {
  return {
    ts, actorId, actorName: actorId, actorRole, action: 'task.update', entityType, entityId,
    entityTitle: 'x', teamId, changes: [], summary: 'x'
  };
}

// Writes a document together with its log entry in ONE batch, like the app does.
async function logged(uid, { path, kind, data, type, entityId, teamId }) {
  const db = as(uid);
  const logId = id('log');
  const batch = writeBatch(db);
  const role = USERS[uid].role;
  const body = { ...data, lastLogId: logId };
  if (kind === 'create') batch.set(doc(db, path), body); else batch.update(doc(db, path), body);
  batch.set(doc(db, 'activityLog', logId), logBody(uid, role, type, entityId, teamId));
  return batch.commit();
}

const updateTask = (uid, taskId, patch, teamId = 'teamA') => logged(uid, {
  path: `tasks/${taskId}`, kind: 'update', type: 'task', entityId: taskId, teamId,
  data: { updatedAt: serverTimestamp(), ...patch }
});

const createTask = (uid, taskId, over = {}) => logged(uid, {
  path: `tasks/${taskId}`, kind: 'create', type: 'task', entityId: taskId, teamId: over.teamId || 'teamA',
  data: taskDoc({ createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over })
});

const toDone = { status: 'done', statusCategory: 'done', completedAt: serverTimestamp(), completedDate: '2026-11-03' };

// ---------------------------------------------------------------- sign-in

describe('signed-out and deactivated people', () => {
  test('signed-out visitors read nothing', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'users', 'dir')));
    await assertFails(getDoc(doc(db, 'tasks', 'tA1')));
  });
  test('a deactivated account is locked out', async () => {
    await assertFails(getDoc(doc(as('gone'), 'tasks', 'tA1')));
    await assertFails(getDoc(doc(as('gone'), 'users', 'gone')));
  });
});

// ---------------------------------------------------------------- reading

describe('reading tasks', () => {
  test('a member reads their own team, not another team', async () => {
    await assertSucceeds(getDoc(doc(as('memA1'), 'tasks', 'tA2')));
    await assertFails(getDoc(doc(as('memA1'), 'tasks', 'tB1')));
  });
  test('team query works for own team and is refused for another team', async () => {
    await assertSucceeds(getDocs(query(collection(as('ldrA'), 'tasks'), where('teamId', '==', 'teamA'))));
    await assertFails(getDocs(query(collection(as('ldrA'), 'tasks'), where('teamId', '==', 'teamB'))));
  });
  test('my-tasks query (ownerId) works for a member', async () => {
    await assertSucceeds(getDocs(query(collection(as('memA1'), 'tasks'), where('ownerId', '==', 'memA1'))));
  });
  test('the Director reads every team', async () => {
    await assertSucceeds(getDocs(collection(as('dir'), 'tasks')));
  });
  test('a member cannot list the whole tasks collection', async () => {
    await assertFails(getDocs(collection(as('memA1'), 'tasks')));
  });
});

// ---------------------------------------------------------------- tasks: create

describe('creating tasks', () => {
  test('a leader creates a task for someone in their team', async () => {
    await assertSucceeds(createTask('ldrA', 'new1', { ownerId: 'memA2' }));
  });
  test('a leader cannot create a task in another team', async () => {
    await assertFails(createTask('ldrA', 'new2', { teamId: 'teamB', ownerId: 'memB' }));
  });
  test('a leader cannot give a task to someone outside the team', async () => {
    await assertFails(createTask('ldrA', 'new3', { ownerId: 'memB' }));
  });
  test('a member creates a task only for themselves', async () => {
    await assertSucceeds(createTask('memA1', 'new4', { ownerId: 'memA1' }));
    await assertFails(createTask('memA1', 'new5', { ownerId: 'memA2' }));
  });
  test('a task cannot be created without its log entry', async () => {
    await assertFails(setDoc(doc(as('ldrA'), 'tasks', 'nolog'), taskDoc({
      createdBy: 'ldrA', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ownerId: 'memA2'
    })));
  });
  test('the log entry must name the right person', async () => {
    const db = as('ldrA');
    const b = writeBatch(db);
    b.set(doc(db, 'tasks', 'fake'), taskDoc({ createdBy: 'ldrA', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ownerId: 'memA2', lastLogId: 'l1' }));
    b.set(doc(db, 'activityLog', 'l1'), logBody('memA2', 'member', 'task', 'fake', 'teamA'));
    await assertFails(b.commit());
  });
  test('a new task cannot start as Completed', async () => {
    await assertFails(createTask('ldrA', 'new6', { ownerId: 'memA2', status: 'done', statusCategory: 'done', completedAt: serverTimestamp() }));
  });
});

// ---------------------------------------------------------------- tasks: update

describe('changing tasks', () => {
  test('a member moves their own task to In Progress and In Review', async () => {
    await assertSucceeds(updateTask('memA1', 'tA1', { status: 'inprogress', statusCategory: 'active' }));
    await assertSucceeds(updateTask('memA1', 'tA1', { status: 'review', statusCategory: 'review', submits: 1 }));
  });
  test('a member cannot mark Completed while the approval gate is on', async () => {
    await assertFails(updateTask('memA1', 'tA1', toDone));
  });
  test('a member CAN mark Completed when the team switched the gate off', async () => {
    await assertSucceeds(updateTask('memC', 'tC1', toDone, 'teamC'));
  });
  test('a member cannot edit title, due date, owner or team', async () => {
    await assertFails(updateTask('memA1', 'tA1', { title: 'renamed' }));
    await assertFails(updateTask('memA1', 'tA1', { dueDate: '2027-01-01' }));
    await assertFails(updateTask('memA1', 'tA1', { ownerId: 'memA2' }));
    await assertFails(updateTask('memA1', 'tA1', { archived: true }));
  });
  test('a member cannot touch a colleague’s task', async () => {
    await assertFails(updateTask('memA1', 'tA2', { status: 'inprogress', statusCategory: 'active' }));
  });
  test('a member cannot reopen a finished task', async () => {
    await assertFails(updateTask('memA1', 'tAdone', { status: 'pending', statusCategory: 'todo', completedAt: null, completedDate: null }));
  });
  test('the stored category must match the status', async () => {
    await assertFails(updateTask('ldrA', 'tA1', { status: 'inprogress', statusCategory: 'done' }));
  });
  test('a change without a log entry is refused', async () => {
    await assertFails(updateDoc(doc(as('ldrA'), 'tasks', 'tA1'), { title: 'sneaky', updatedAt: serverTimestamp(), lastLogId: 'nope' }));
  });
  test('a leader edits title and due date and completes a task in their team', async () => {
    await assertSucceeds(updateTask('ldrA', 'tA1', { title: 'renamed', dueDate: '2027-01-01' }));
    await assertSucceeds(updateTask('ldrA', 'tA2', toDone));
  });
  test('a leader cannot touch another team’s task', async () => {
    await assertFails(updateTask('ldrA', 'tB1', { title: 'x' }, 'teamB'));
  });
  test('a leader can archive', async () => {
    await assertSucceeds(updateTask('ldrA', 'tA1', { archived: true }));
  });
  test('an assistant leader edits and reassigns but cannot change deadlines or archive', async () => {
    await assertSucceeds(updateTask('asstA', 'tA1', { title: 'renamed', priority: 'high' }));
    await assertFails(updateTask('asstA', 'tA1', { dueDate: '2027-01-01' }));
    await assertFails(updateTask('asstA', 'tA1', { archived: true }));
  });
  test('completing a task stamps the server time, and a fake time is refused', async () => {
    await assertFails(updateTask('ldrA', 'tA1', { ...toDone, completedAt: new Date('2020-01-01') }));
    await assertSucceeds(updateTask('ldrA', 'tA1', toDone));
  });
  test('reopening clears the completed time', async () => {
    await assertFails(updateTask('ldrA', 'tAdone', { status: 'pending', statusCategory: 'todo' }));
    await assertSucceeds(updateTask('ldrA', 'tAdone', { status: 'pending', statusCategory: 'todo', completedAt: null, completedDate: null }));
  });
  test('nobody deletes a task, not even the Director', async () => {
    await assertFails(deleteDoc(doc(as('dir'), 'tasks', 'tA1')));
    await assertFails(deleteDoc(doc(as('ldrA'), 'tasks', 'tA1')));
  });
});

// ---------------------------------------------------------------- mentions

describe('mentions', () => {
  // A comment that names someone, plus one note for each person named, in one batch.
  const mentionBatch = ({ author = 'memA1', taskId = 'tA2', named = ['memA2'], notes = named, noteOver = {}, commentOver = {} } = {}) => {
    const db = as(author);
    const cid = id('c');
    const logId = id('log');
    const b = writeBatch(db);
    b.set(doc(db, 'tasks', taskId, 'comments', cid), {
      authorId: author, authorName: author, text: 'hello', createdAt: serverTimestamp(), logId, mentions: named, ...commentOver
    });
    b.set(doc(db, 'activityLog', logId), logBody(author, USERS[author].role, 'comment', cid, 'teamA'));
    for (const toId of notes) {
      b.set(doc(db, 'mentions', id('m')), {
        toId, fromId: author, fromName: author, taskId, taskTitle: 'A task', commentId: cid, snippet: 'hello', read: false, createdAt: serverTimestamp(), ...noteOver
      });
    }
    return b.commit();
  };
  test('a comment can name teammates and notify them in the same batch', async () => {
    await assertSucceeds(mentionBatch({ named: ['memA2', 'ldrA'] }));
  });
  test('five people in one comment still fit in one batch', async () => {
    await assertSucceeds(mentionBatch({ named: ['memA2', 'ldrA', 'dir', 'mgrA', 'asstA'] }));
  });
  test('someone who is not active cannot be notified', async () => {
    await assertFails(mentionBatch({ named: ['gone'] }));
  });
  test('five people at most', async () => {
    await assertFails(mentionBatch({ named: ['memA2', 'ldrA', 'dir', 'memB', 'mgrA', 'asstA'] }));
  });
  test('a note cannot be made for someone the comment does not name', async () => {
    await assertFails(mentionBatch({ named: ['memA2'], notes: ['memA2', 'ldrA'] }));
  });
  test('a note cannot be made without a comment, or in someone else’s name', async () => {
    await assertFails(setDoc(doc(as('memA1'), 'mentions', id('m')), {
      toId: 'memA2', fromId: 'memA1', fromName: 'x', taskId: 'tA2', taskTitle: 'A task', commentId: 'nope', snippet: 'hi', read: false, createdAt: serverTimestamp()
    }));
    await assertFails(mentionBatch({ noteOver: { fromId: 'memA2' } }));
  });
  test('you cannot notify yourself, and a note starts unread', async () => {
    await assertFails(mentionBatch({ named: ['memA1'] }));
    await assertFails(mentionBatch({ noteOver: { read: true } }));
  });
  test('only the person it is for reads a note, and can only mark it read', async () => {
    let noteId;
    await env.withSecurityRulesDisabled(async (ctx) => {
      noteId = id('m');
      await setDoc(doc(ctx.firestore(), 'mentions', noteId), {
        toId: 'memA2', fromId: 'memA1', fromName: 'x', taskId: 'tA2', taskTitle: 'A task', commentId: 'c0', snippet: 'hi', read: false, createdAt: new Date()
      });
    });
    await assertSucceeds(getDocs(query(collection(as('memA2'), 'mentions'), where('toId', '==', 'memA2'), where('read', '==', false))));
    await assertFails(getDocs(query(collection(as('memA1'), 'mentions'), where('toId', '==', 'memA2'))));
    await assertFails(getDoc(doc(as('dir'), 'mentions', noteId)));
    await assertFails(updateDoc(doc(as('memA1'), 'mentions', noteId), { read: true }));
    await assertFails(updateDoc(doc(as('memA2'), 'mentions', noteId), { snippet: 'changed' }));
    await assertFails(updateDoc(doc(as('memA2'), 'mentions', noteId), { read: false }));
    await assertSucceeds(updateDoc(doc(as('memA2'), 'mentions', noteId), { read: true }));
    await assertFails(deleteDoc(doc(as('memA2'), 'mentions', noteId)));
  });
});

// ---------------------------------------------------------------- comments

describe('comments', () => {
  const addComment = (uid, taskId, over = {}) => {
    const db = as(uid);
    const cid = id('c');
    const logId = id('log');
    const b = writeBatch(db);
    b.set(doc(db, 'tasks', taskId, 'comments', cid), {
      authorId: uid, authorName: uid, text: 'hello', createdAt: serverTimestamp(), logId, ...over
    });
    b.set(doc(db, 'activityLog', logId), logBody(uid, USERS[uid].role, 'comment', cid, 'teamA'));
    return b.commit();
  };
  test('team members comment on tasks they can see', async () => {
    await assertSucceeds(addComment('memA1', 'tA2'));
  });
  test('people from another team cannot comment', async () => {
    await assertFails(addComment('memB', 'tA1'));
  });
  test('comments cannot be posted in someone else’s name', async () => {
    await assertFails(addComment('memA1', 'tA1', { authorId: 'memA2' }));
  });
  test('comments cannot be edited or deleted', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'tasks', 'tA1', 'comments', 'c0'), { authorId: 'memA1', authorName: 'x', text: 'hi', createdAt: new Date(), logId: 'seedlog' });
    });
    await assertFails(updateDoc(doc(as('memA1'), 'tasks', 'tA1', 'comments', 'c0'), { text: 'changed' }));
    await assertFails(deleteDoc(doc(as('dir'), 'tasks', 'tA1', 'comments', 'c0')));
  });
});

// ---------------------------------------------------------------- people, teams, statuses

describe('people', () => {
  const newUser = (over = {}) => ({
    name: 'New', email: 'new@x.test', role: 'member', teamIds: ['teamA'], active: true,
    createdAt: serverTimestamp(), lastLoginAt: null, ...over
  });
  test('only the Director creates accounts', async () => {
    await assertSucceeds(logged('dir', { path: 'users/u1', kind: 'create', type: 'user', entityId: 'u1', teamId: null, data: newUser() }));
    await assertFails(logged('ldrA', { path: 'users/u2', kind: 'create', type: 'user', entityId: 'u2', teamId: null, data: newUser() }));
  });
  test('only the Director changes a role', async () => {
    await assertSucceeds(logged('dir', { path: 'users/memA1', kind: 'update', type: 'user', entityId: 'memA1', teamId: null, data: { role: 'leader' } }));
    await assertFails(logged('ldrA', { path: 'users/memA1', kind: 'update', type: 'user', entityId: 'memA1', teamId: null, data: { role: 'leader' } }));
  });
  test('nobody promotes themselves', async () => {
    await assertFails(logged('memA1', { path: 'users/memA1', kind: 'update', type: 'user', entityId: 'memA1', teamId: null, data: { role: 'director' } }));
  });
  test('the Director cannot demote or deactivate themselves', async () => {
    await assertFails(logged('dir', { path: 'users/dir', kind: 'update', type: 'user', entityId: 'dir', teamId: null, data: { role: 'member' } }));
    await assertFails(logged('dir', { path: 'users/dir', kind: 'update', type: 'user', entityId: 'dir', teamId: null, data: { active: false } }));
  });
  test('anyone may record their own sign-in, and only that', async () => {
    await assertSucceeds(logged('memA1', { path: 'users/memA1', kind: 'update', type: 'user', entityId: 'memA1', teamId: null, data: { lastLoginAt: serverTimestamp() } }));
    await assertFails(logged('memA1', { path: 'users/memA1', kind: 'update', type: 'user', entityId: 'memA1', teamId: null, data: { lastLoginAt: serverTimestamp(), name: 'Other' } }));
  });
  test('accounts are never deleted', async () => {
    await assertFails(deleteDoc(doc(as('dir'), 'users', 'memA1')));
  });

  // Colour theme: a personal preference, changed without a log entry.
  test('anyone may pick their own colour theme', async () => {
    await assertSucceeds(updateDoc(doc(as('memA1'), 'users', 'memA1'), { theme: 'midnight' }));
    await assertSucceeds(updateDoc(doc(as('dir'), 'users', 'dir'), { theme: 'corporate' }));
  });
  test('nobody changes someone else\'s theme', async () => {
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA2'), { theme: 'dark' }));
    await assertFails(updateDoc(doc(as('ldrA'), 'users', 'memA1'), { theme: 'dark' }));
  });
  test('a theme must be one of the known names', async () => {
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA1'), { theme: 'neon' }));
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA1'), { theme: 7 }));
  });
  test('the theme shortcut cannot smuggle in other changes', async () => {
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA1'), { theme: 'dark', role: 'director' }));
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA1'), { theme: 'dark', teamIds: ['teamB'] }));
  });
  test('a deactivated person cannot change their theme', async () => {
    await assertFails(updateDoc(doc(as('gone'), 'users', 'gone'), { theme: 'dark' }));
  });
  // Changing your own password writes only a log entry ("user.password"), never the password.
  test('a person can log that they changed their own password', async () => {
    await assertSucceeds(setDoc(doc(as('memA1'), 'activityLog', id('pw')),
      { ...logBody('memA1', 'member', 'user', 'memA1', 'teamA'), action: 'user.password' }));
  });
});

describe('teams, projects, statuses', () => {
  test('only the Director creates teams and changes the approval gate', async () => {
    const team = { name: 'New', approvalGate: true, active: true, createdAt: serverTimestamp() };
    await assertSucceeds(logged('dir', { path: 'teams/t9', kind: 'create', type: 'team', entityId: 't9', teamId: 't9', data: team }));
    await assertFails(logged('mgrA', { path: 'teams/t8', kind: 'create', type: 'team', entityId: 't8', teamId: 't8', data: team }));
    await assertSucceeds(logged('dir', { path: 'teams/teamA', kind: 'update', type: 'team', entityId: 'teamA', teamId: 'teamA', data: { approvalGate: false } }));
    await assertFails(logged('mgrA', { path: 'teams/teamA', kind: 'update', type: 'team', entityId: 'teamA', teamId: 'teamA', data: { approvalGate: false } }));
  });
  test('a manager may rename their own team', async () => {
    await assertSucceeds(logged('mgrA', { path: 'teams/teamA', kind: 'update', type: 'team', entityId: 'teamA', teamId: 'teamA', data: { name: 'Renamed' } }));
  });
  test('leaders create projects in their team only; members cannot', async () => {
    const project = (teamId) => ({ name: 'P', teamId, description: '', active: true, createdAt: serverTimestamp() });
    await assertSucceeds(logged('ldrA', { path: 'projects/p1', kind: 'create', type: 'project', entityId: 'p1', teamId: 'teamA', data: project('teamA') }));
    await assertFails(logged('ldrA', { path: 'projects/p2', kind: 'create', type: 'project', entityId: 'p2', teamId: 'teamB', data: project('teamB') }));
    await assertFails(logged('memA1', { path: 'projects/p3', kind: 'create', type: 'project', entityId: 'p3', teamId: 'teamA', data: project('teamA') }));
  });
  test('only the Director edits statuses', async () => {
    const status = { name: 'QA', category: 'review', color: '#123456', order: 9, active: true, needsReason: false };
    await assertSucceeds(logged('dir', { path: 'statuses/qa', kind: 'create', type: 'status', entityId: 'qa', teamId: null, data: status }));
    await assertFails(logged('ldrA', { path: 'statuses/qa2', kind: 'create', type: 'status', entityId: 'qa2', teamId: null, data: status }));
    await assertFails(logged('mgrA', { path: 'statuses/pending', kind: 'update', type: 'status', entityId: 'pending', teamId: null, data: { name: 'x' } }));
  });
});

// ---------------------------------------------------------------- activity log

describe('activity log', () => {
  test('the Director reads everything', async () => {
    await assertSucceeds(getDocs(collection(as('dir'), 'activityLog')));
  });
  test('a leader reads their own team’s log, not another team’s', async () => {
    await assertSucceeds(getDocs(query(collection(as('ldrA'), 'activityLog'), where('teamId', '==', 'teamA'))));
    await assertFails(getDocs(query(collection(as('ldrA'), 'activityLog'), where('teamId', '==', 'teamB'))));
  });
  test('a member reads only their own entries', async () => {
    await assertSucceeds(getDocs(query(collection(as('memA1'), 'activityLog'), where('actorId', '==', 'memA1'))));
    await assertFails(getDocs(query(collection(as('memA1'), 'activityLog'), where('actorId', '==', 'memA2'))));
    await assertFails(getDocs(collection(as('memA1'), 'activityLog')));
  });
  test('entries can never be edited or deleted, even by the Director', async () => {
    await assertFails(updateDoc(doc(as('dir'), 'activityLog', 'oldA'), { summary: 'rewritten' }));
    await assertFails(deleteDoc(doc(as('dir'), 'activityLog', 'oldA')));
  });
  test('a log entry cannot be written in someone else’s name or with a fake time', async () => {
    await assertFails(setDoc(doc(as('memA1'), 'activityLog', 'f1'), logBody('memA2', 'member', 'task', 'tA1', 'teamA')));
    await assertFails(setDoc(doc(as('memA1'), 'activityLog', 'f2'), logBody('memA1', 'member', 'task', 'tA1', 'teamA', new Date('2020-01-01'))));
  });
});

// ---------------------------------------------------------------- leave

describe('leave', () => {
  const leaveDoc = (uid, over = {}) => ({
    userId: uid, userName: uid, teamId: USERS[uid].teamIds[0], type: 'annual', startDate: '2026-12-01', endDate: '2026-12-03',
    half: 'full', reason: '', status: 'pending', requestedBy: uid, decidedBy: null, decidedAt: null, decisionNote: null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over
  });
  const approvedBy = (decider) => ({ status: 'approved', requestedBy: decider, decidedBy: decider, decidedAt: serverTimestamp() });
  const createLeave = (actor, lid, doc, teamId) => logged(actor, {
    path: `leaves/${lid}`, kind: 'create', type: 'leave', entityId: lid, teamId: teamId || doc.teamId, data: doc
  });
  const decide = (actor, lid, patch, teamId = 'teamA') => logged(actor, {
    path: `leaves/${lid}`, kind: 'update', type: 'leave', entityId: lid, teamId,
    data: { updatedAt: serverTimestamp(), ...patch }
  });
  const seedPending = async (lid = 'lv1', uid = 'memA1') => env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'leaves', lid), leaveDoc(uid, { createdAt: new Date(), updatedAt: new Date() }));
  });

  test('a member asks for their own leave and it waits for approval', async () => {
    await assertSucceeds(createLeave('memA1', 'n1', leaveDoc('memA1')));
  });
  test('a member cannot approve their own request when asking', async () => {
    await assertFails(createLeave('memA1', 'n2', leaveDoc('memA1', approvedBy('memA1'))));
  });
  test('a member cannot ask on behalf of a colleague, or for another team', async () => {
    await assertFails(createLeave('memA1', 'n3', leaveDoc('memA2', { requestedBy: 'memA1' }), 'teamA'));
    await assertFails(createLeave('memA1', 'n4', leaveDoc('memA1', { teamId: 'teamB' })));
  });
  test('leave must have a log entry and valid dates', async () => {
    await assertFails(setDoc(doc(as('memA1'), 'leaves', 'nolog'), { ...leaveDoc('memA1'), lastLogId: 'x' }));
    await assertFails(createLeave('memA1', 'n5', leaveDoc('memA1', { startDate: '2026-12-05', endDate: '2026-12-01' })));
    await assertFails(createLeave('memA1', 'n6', leaveDoc('memA1', { half: 'am' })));   // half day needs a single day
  });
  // Leave is approved in two steps. Team Leader: pending -> leader_ok. Director: leader_ok -> approved.
  const leaderOk = (leader) => ({ status: 'leader_ok', leaderBy: leader, leaderAt: serverTimestamp() });
  test('a leader records leave for someone in their team (counts as step 1), not another team', async () => {
    await assertSucceeds(createLeave('ldrA', 'n7', leaveDoc('memA1', { requestedBy: 'ldrA', ...leaderOk('ldrA') }), 'teamA'));
    await assertFails(createLeave('ldrA', 'n8', leaveDoc('memB', { requestedBy: 'ldrA', ...leaderOk('ldrA') }), 'teamB'));
  });
  test('a leader cannot record leave as already approved, only the Director can', async () => {
    await assertFails(createLeave('ldrA', 'n7b', leaveDoc('memA1', approvedBy('ldrA')), 'teamA'));
    await assertSucceeds(createLeave('dir', 'n7c', leaveDoc('memA1', approvedBy('dir')), 'teamA'));
  });
  test('a leader or manager\'s own request skips step 1; a member\'s cannot', async () => {
    await assertSucceeds(createLeave('ldrA', 'n7d', leaveDoc('ldrA', { status: 'leader_ok' })));
    await assertSucceeds(createLeave('mgrA', 'n7e', leaveDoc('mgrA', { status: 'leader_ok' })));
    await assertFails(createLeave('memA1', 'n7f', leaveDoc('memA1', { status: 'leader_ok' })));
    await assertFails(createLeave('asstA', 'n7g', leaveDoc('asstA', { status: 'leader_ok' })));
    await assertFails(createLeave('memA1', 'n7h', leaveDoc('memA1', { status: 'leader_ok', leaderBy: 'ldrA', leaderAt: serverTimestamp() })));   // cannot forge a step
  });
  test('an assistant leader cannot record or approve leave', async () => {
    await assertFails(createLeave('asstA', 'n9', leaveDoc('memA1', approvedBy('asstA')), 'teamA'));
    await seedPending();
    await assertFails(decide('asstA', 'lv1', { status: 'approved', decidedBy: 'asstA', decidedAt: serverTimestamp() }));
  });
  test('a leader gives step 1 on a pending request in their team, with their own name and the server time', async () => {
    await seedPending();
    await assertFails(decide('ldrA', 'lv1', { status: 'leader_ok', leaderBy: 'memA2', leaderAt: serverTimestamp() }));
    await assertFails(decide('ldrA', 'lv1', { status: 'leader_ok', leaderBy: 'ldrA', leaderAt: new Date('2020-01-01') }));
    await assertSucceeds(decide('ldrA', 'lv1', leaderOk('ldrA')));
  });
  test('a leader cannot give the final approval, and nobody can skip a step', async () => {
    await seedPending();
    await assertFails(decide('ldrA', 'lv1', { status: 'approved', decidedBy: 'ldrA', decidedAt: serverTimestamp() }));
    await assertFails(decide('dir', 'lv1', { status: 'approved', decidedBy: 'dir', decidedAt: serverTimestamp() }));   // pending -> approved skips the Team Leader
    await assertSucceeds(decide('ldrA', 'lv1', leaderOk('ldrA')));
    await assertFails(decide('ldrA', 'lv1', { status: 'approved', decidedBy: 'ldrA', decidedAt: serverTimestamp() }));
    await assertFails(decide('mgrA', 'lv1', { status: 'approved', decidedBy: 'mgrA', decidedAt: serverTimestamp() }));
    await assertSucceeds(decide('dir', 'lv1', { status: 'approved', decidedBy: 'dir', decidedAt: serverTimestamp() }));
  });
  test('a Superuser can give the final approval', async () => {
    await seedPending();
    await assertSucceeds(decide('ldrA', 'lv1', leaderOk('ldrA')));
    await assertSucceeds(decide('su', 'lv1', { status: 'approved', decidedBy: 'su', decidedAt: serverTimestamp() }));
  });
  test('step 1 by a leader of another team, a member or the person themselves is refused', async () => {
    await seedPending();
    await assertFails(decide('ldrB', 'lv1', leaderOk('ldrB')));
    await assertFails(decide('memA2', 'lv1', leaderOk('memA2')));
    await assertFails(decide('memA1', 'lv1', leaderOk('memA1')));
    await assertFails(decide('hrM', 'lv1', leaderOk('hrM')));
  });
  test('the Director can decline at either step, a leader only at step 1', async () => {
    await seedPending('lvA'); await seedPending('lvB');
    const decline = (who) => ({ status: 'declined', decidedBy: who, decidedAt: serverTimestamp(), decisionNote: 'No' });
    await assertSucceeds(decide('dir', 'lvA', decline('dir')));
    await assertSucceeds(decide('ldrA', 'lvB', leaderOk('ldrA')));
    await assertFails(decide('ldrA', 'lvB', decline('ldrA')));            // already past the Team Leader
    await assertSucceeds(decide('dir', 'lvB', decline('dir')));
  });
  test('declining needs a reason', async () => {
    await seedPending();
    await assertFails(decide('ldrA', 'lv1', { status: 'declined', decidedBy: 'ldrA', decidedAt: serverTimestamp() }));
    await assertSucceeds(decide('ldrA', 'lv1', { status: 'declined', decidedBy: 'ldrA', decidedAt: serverTimestamp(), decisionNote: 'Busy period' }));
  });
  test('members, other teams’ leaders and the person themselves cannot approve', async () => {
    await seedPending();
    const approve = { status: 'approved', decidedAt: serverTimestamp() };
    await assertFails(decide('memA2', 'lv1', { ...approve, decidedBy: 'memA2' }));
    await assertFails(decide('ldrB', 'lv1', { ...approve, decidedBy: 'ldrB' }));
    await assertFails(decide('memA1', 'lv1', { ...approve, decidedBy: 'memA1' }));
  });
  test('a leader cannot give step 1 on their own leave, the Director can', async () => {
    await seedPending('lv2', 'ldrA');
    await assertFails(decide('ldrA', 'lv2', leaderOk('ldrA')));
    await assertSucceeds(decide('dir', 'lv2', leaderOk('dir')));
  });
  test('the person can cancel their own leave, a colleague cannot', async () => {
    await seedPending();
    await assertFails(decide('memA2', 'lv1', { status: 'cancelled' }));
    await assertSucceeds(decide('memA1', 'lv1', { status: 'cancelled' }));
  });
  test('dates and person cannot be edited afterwards', async () => {
    await seedPending();
    await assertFails(decide('memA1', 'lv1', { endDate: '2026-12-31' }));
    await assertFails(decide('ldrA', 'lv1', { userId: 'memA2' }));
  });
  test('who can read leave', async () => {
    await seedPending();
    await assertSucceeds(getDocs(query(collection(as('memA1'), 'leaves'), where('userId', '==', 'memA1'))));
    await assertFails(getDocs(query(collection(as('memA1'), 'leaves'), where('teamId', '==', 'teamA'))));
    await assertFails(getDoc(doc(as('memA2'), 'leaves', 'lv1')));
    await assertSucceeds(getDocs(query(collection(as('ldrA'), 'leaves'), where('teamId', '==', 'teamA'))));
    await assertSucceeds(getDocs(query(collection(as('asstA'), 'leaves'), where('teamId', '==', 'teamA'))));
    await assertFails(getDocs(query(collection(as('ldrB'), 'leaves'), where('teamId', '==', 'teamA'))));
    await assertSucceeds(getDocs(collection(as('dir'), 'leaves')));
  });
  test('leave is never deleted', async () => {
    await seedPending();
    await assertFails(deleteDoc(doc(as('dir'), 'leaves', 'lv1')));
  });
  test('a request waiting for the Director can still be cancelled by the person', async () => {
    await seedPending();
    await assertSucceeds(decide('ldrA', 'lv1', leaderOk('ldrA')));
    await assertSucceeds(decide('memA1', 'lv1', { status: 'cancelled' }));
  });
  test('the new kinds of leave are accepted, unknown ones are not', async () => {
    for (const [i, type] of ['compassionate', 'marriage', 'hospitalization', 'sick'].entries()) {
      await assertSucceeds(createLeave('memA1', 'k' + i, leaveDoc('memA1', { type })));
    }
    await assertFails(createLeave('memA1', 'kx', leaveDoc('memA1', { type: 'holiday' })));
  });
});

// -------------------------------------------------------------------- HR

describe('HR', () => {
  const upd = (uid, target, data) => logged(uid, { path: `users/${target}`, kind: 'update', type: 'user', entityId: target, teamId: null, data });
  const leaveDoc = (uid, over = {}) => ({
    userId: uid, userName: uid, teamId: USERS[uid].teamIds[0], type: 'annual', startDate: '2026-12-01', endDate: '2026-12-03',
    half: 'full', reason: '', status: 'approved', requestedBy: uid, decidedBy: 'dir', decidedAt: new Date(), decisionNote: null,
    leaderBy: 'ldrA', leaderAt: new Date(), createdAt: new Date(), updatedAt: new Date(), lastLogId: 'seedlog', ...over
  });
  const act = (actor, lid, patch, teamId = 'teamA') => logged(actor, {
    path: `leaves/${lid}`, kind: 'update', type: 'leave', entityId: lid, teamId, data: { updatedAt: serverTimestamp(), ...patch }
  });
  const ack = (who) => ({ hrAckBy: who, hrAckAt: serverTimestamp() });
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'leaves', 'ap1'), leaveDoc('memA1'));
      await setDoc(doc(db, 'leaves', 'ap2'), leaveDoc('memB', { teamId: 'teamB' }));
      await setDoc(doc(db, 'leaves', 'pend1'), leaveDoc('memA1', { status: 'pending', decidedBy: null, decidedAt: null, leaderBy: null, leaderAt: null }));
    });
  });

  test('only a Director or Superuser switches HR on for someone', async () => {
    await assertSucceeds(upd('dir', 'memA2', { hr: true }));
    await assertSucceeds(upd('su', 'memA1', { hr: true }));
    await assertFails(upd('ldrA', 'memA1', { hr: true }));
    await assertFails(upd('mgrA', 'memA1', { hr: true }));
    await assertFails(upd('hrM', 'memA1', { hr: true }));              // HR cannot hand out HR either
  });
  test('nobody switches HR on for themselves', async () => {
    await assertFails(upd('memA1', 'memA1', { hr: true }));
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA1'), { hr: true }));
    await assertFails(updateDoc(doc(as('ldrA'), 'users', 'ldrA'), { hr: true }));
  });
  test('HR must be true or false, and a deactivated HR person has nothing', async () => {
    await assertFails(upd('dir', 'memA2', { hr: 'yes' }));
    await assertFails(getDocs(collection(as('hrGone'), 'leaves')));
  });

  test('HR reads every leave record in every team; others do not', async () => {
    await assertSucceeds(getDocs(collection(as('hrM'), 'leaves')));
    await assertSucceeds(getDoc(doc(as('hrM'), 'leaves', 'ap1')));
    await assertSucceeds(getDoc(doc(as('hrLdr'), 'leaves', 'ap2')));
    await assertSucceeds(getDocs(query(collection(as('hrM'), 'leaves'), where('endDate', '>=', '2026-01-01'), where('endDate', '<=', '2027-01-31'))));
    await assertFails(getDocs(collection(as('memA2'), 'leaves')));
    await assertFails(getDocs(collection(as('ldrA'), 'leaves')));
    await assertFails(getDocs(collection(as('memA1'), 'leaves')));
  });
  test('HR acknowledges approved leave, once, naming themselves with the server time', async () => {
    await assertSucceeds(act('hrM', 'ap1', ack('hrM')));
    await assertFails(act('hrLdr', 'ap1', ack('hrLdr')));              // already acknowledged
    await assertSucceeds(act('hrLdr', 'ap2', ack('hrLdr'), 'teamB'));
  });
  test('the acknowledgement must be genuine', async () => {
    await assertFails(act('hrM', 'ap1', { hrAckBy: 'ldrA', hrAckAt: serverTimestamp() }));            // not in someone else\'s name
    await assertFails(act('hrM', 'ap1', { hrAckBy: 'hrM', hrAckAt: new Date('2020-01-01') }));         // not a made-up time
  });
  test('only approved leave can be acknowledged', async () => {
    await assertFails(act('hrM', 'pend1', ack('hrM')));
  });
  test('nobody else acknowledges', async () => {
    await assertFails(act('dir', 'ap1', ack('dir')));
    await assertFails(act('ldrA', 'ap1', ack('ldrA')));
    await assertFails(act('su', 'ap1', ack('su')));
    await assertFails(act('memA1', 'ap1', ack('memA1')));
  });
  test('an acknowledgement changes nothing else', async () => {
    await assertFails(act('hrM', 'ap1', { ...ack('hrM'), status: 'cancelled' }));
    await assertFails(act('hrM', 'ap1', { ...ack('hrM'), endDate: '2026-12-31' }));
    await assertFails(act('hrM', 'ap1', { ...ack('hrM'), decidedBy: 'hrM' }));
  });
  test('HR does not approve, decline or cancel anyone\'s leave', async () => {
    const decline = { status: 'declined', decidedBy: 'hrM', decidedAt: serverTimestamp(), decisionNote: 'No' };
    await assertFails(act('hrM', 'pend1', { status: 'leader_ok', leaderBy: 'hrM', leaderAt: serverTimestamp() }));
    await assertFails(act('hrM', 'pend1', decline));
    await assertFails(act('hrM', 'ap1', { status: 'cancelled' }));
    await assertFails(act('hrLdr', 'pend1', { status: 'leader_ok', leaderBy: 'hrLdr', leaderAt: serverTimestamp() }, 'teamA'));   // a leader of another team
  });
  test('leave stays approved without any acknowledgement', async () => {
    await assertSucceeds(getDoc(doc(as('memA1'), 'leaves', 'ap1')));
    await assertSucceeds(act('memA1', 'ap1', { status: 'cancelled' }));   // the person may still cancel, acknowledged or not
  });
  test('HR keeps their own role: an HR Team Leader approves only their own team\'s step 1', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'leaves', 'pc'), leaveDoc('memC', { teamId: 'teamC', status: 'pending', decidedBy: null, decidedAt: null, leaderBy: null, leaderAt: null }));
    });
    await assertSucceeds(act('hrLdr', 'pc', { status: 'leader_ok', leaderBy: 'hrLdr', leaderAt: serverTimestamp() }, 'teamC'));
  });
});

// --------------------------------------------------- leave entitlements

describe('leave entitlements (HR)', () => {
  const policyDoc = (year = '2026', over = {}) => ({
    year, days: { annual: 14, sick: 14, hospitalization: 60, compassionate: 3, marriage: 3 }, overrides: { memA1: { annual: 18 } },
    updatedAt: serverTimestamp(), ...over
  });
  const save = (actor, year, data, kind = 'create') => logged(actor, {
    path: `leavePolicy/${year}`, kind, type: 'policy', entityId: year, teamId: null, data
  });

  test('HR creates and then updates the entitlements for a year', async () => {
    await assertSucceeds(save('hrM', '2026', policyDoc()));
    await assertSucceeds(save('hrLdr', '2026', policyDoc('2026', { days: { annual: 16 } }), 'update'));
  });
  test('nobody else writes them: not the Director, a Superuser, a leader or a member', async () => {
    for (const who of ['dir', 'su', 'ldrA', 'mgrA', 'asstA', 'memA1']) await assertFails(save(who, '2026', policyDoc()));
  });
  test('everyone signed in can read them, a deactivated person cannot', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'leavePolicy', '2026'), { ...policyDoc(), updatedAt: new Date(), lastLogId: 'seedlog' }); });
    for (const who of ['memA1', 'ldrA', 'dir', 'hrM']) await assertSucceeds(getDoc(doc(as(who), 'leavePolicy', '2026')));
    await assertFails(getDoc(doc(as('gone'), 'leavePolicy', '2026')));
  });
  test('the numbers are checked', async () => {
    await assertFails(save('hrM', '2026', policyDoc('2026', { days: { annual: -1 } })));
    await assertFails(save('hrM', '2026', policyDoc('2026', { days: { annual: 400 } })));
    await assertFails(save('hrM', '2026', policyDoc('2026', { days: { annual: 'many' } })));
    await assertFails(save('hrM', '2026', policyDoc('2026', { days: { training: 5 } })));        // only the five counted kinds
    await assertSucceeds(save('hrM', '2026', policyDoc('2026', { days: { annual: 7.5, sick: 0 } })));
  });
  test('the document must be for the year in its id, with a log entry', async () => {
    await assertFails(save('hrM', '2026', policyDoc('2027')));
    await assertFails(save('hrM', 'next', policyDoc('next')));
    await assertFails(save('hrM', '2026', policyDoc('2026', { overrides: 'none' })));
    await assertFails(setDoc(doc(as('hrM'), 'leavePolicy', '2026'), { ...policyDoc(), lastLogId: 'nolog' }));
  });
  test('entitlements are never deleted', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'leavePolicy', '2026'), { ...policyDoc(), updatedAt: new Date(), lastLogId: 'seedlog' }); });
    await assertFails(deleteDoc(doc(as('hrM'), 'leavePolicy', '2026')));
  });
});

// ---------------------------------------------------------------- holidays

describe('holidays', () => {
  const holidayDoc = (teamId) => ({ name: 'Day off', date: '2026-12-25', teamId, active: true, createdAt: serverTimestamp() });
  const createHoliday = (actor, hid, teamId) => logged(actor, {
    path: `holidays/${hid}`, kind: 'create', type: 'holiday', entityId: hid, teamId, data: holidayDoc(teamId)
  });
  test('everyone signed in reads holidays', async () => {
    await assertSucceeds(getDocs(collection(as('memA1'), 'holidays')));
    await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'holidays')));
  });
  test('the Director sets a holiday for everyone', async () => {
    await assertSucceeds(createHoliday('dir', 'h1', null));
  });
  test('a leader sets a holiday for their own team only', async () => {
    await assertSucceeds(createHoliday('ldrA', 'h2', 'teamA'));
    await assertFails(createHoliday('ldrA', 'h3', 'teamB'));
    await assertFails(createHoliday('ldrA', 'h4', null));
  });
  test('members cannot set holidays', async () => {
    await assertFails(createHoliday('memA1', 'h5', 'teamA'));
  });
  // The Malaysian import writes 8 holidays + 8 log entries per batch.
  const bulk = (actor, n, teamId = null) => {
    const db = as(actor), batch = writeBatch(db), role = USERS[actor].role;
    for (let i = 0; i < n; i++) {
      const hid = id('bulk'), logId = id('log');
      batch.set(doc(db, 'holidays', hid), { ...holidayDoc(teamId), lastLogId: logId });
      batch.set(doc(db, 'activityLog', logId), { ...logBody(actor, role, 'holiday', hid, teamId), action: 'holiday.create' });
    }
    return batch.commit();
  };
  test('the Director can import a batch of 8 holidays in one write', async () => {
    await assertSucceeds(bulk('dir', 8));
  });
  test('a leader cannot bulk-add holidays for everyone', async () => {
    await assertFails(bulk('ldrA', 8, null));
  });
  test('a holiday can be switched off (not deleted) by someone who may manage it', async () => {
    await createHoliday('ldrA', 'h6', 'teamA');
    await assertSucceeds(logged('ldrA', { path: 'holidays/h6', kind: 'update', type: 'holiday', entityId: 'h6', teamId: 'teamA', data: { active: false } }));
    await assertFails(deleteDoc(doc(as('dir'), 'holidays', 'h6')));
    await assertFails(logged('ldrB', { path: 'holidays/h6', kind: 'update', type: 'holiday', entityId: 'h6', teamId: 'teamA', data: { name: 'x' } }));
  });
});

// ------------------------------------------------------------ project owners
// memA1 (a plain member of team A) owns project "pOwned". Work in it is held by people in
// team B and team C, so the owner reaches across teams without being a leader there.

describe('project owners', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const project = (ownerId) => ({ name: 'P', teamId: 'teamA', description: '', active: true, ownerId, createdAt: new Date(), lastLogId: 'seedlog' });
      await setDoc(doc(db, 'projects', 'pOwned'), project('memA1'));
      await setDoc(doc(db, 'projects', 'pOther'), project('ldrA'));
      await setDoc(doc(db, 'projects', 'pOld'), { name: 'Old', teamId: 'teamA', description: '', active: true, createdAt: new Date(), lastLogId: 'seedlog' }); // no owner field
      await setDoc(doc(db, 'tasks', 'pB1'), taskDoc({ ownerId: 'memB', teamId: 'teamB', projectId: 'pOwned', createdBy: 'ldrB' }));
      await setDoc(doc(db, 'tasks', 'pBrev'), taskDoc({ ownerId: 'memB', teamId: 'teamB', projectId: 'pOwned', createdBy: 'ldrB', status: 'review', statusCategory: 'review' }));
      await setDoc(doc(db, 'tasks', 'pCrev'), taskDoc({ ownerId: 'memC', teamId: 'teamC', projectId: 'pOwned', createdBy: 'ldrB', status: 'review', statusCategory: 'review' }));
      await setDoc(doc(db, 'tasks', 'pOtherB'), taskDoc({ ownerId: 'memB', teamId: 'teamB', projectId: 'pOther', createdBy: 'ldrB' }));
      await setDoc(doc(db, 'tasks', 'pOldB'), taskDoc({ ownerId: 'memB', teamId: 'teamB', projectId: 'pOld', createdBy: 'ldrB' }));
      await setDoc(doc(db, 'tasks', 'ownReview'), taskDoc({ ownerId: 'memA1', teamId: 'teamA', projectId: 'pOwned', createdBy: 'ldrA', status: 'review', statusCategory: 'review' }));
    });
  });

  test('the owner reads every task in the project, in any team', async () => {
    await assertSucceeds(getDoc(doc(as('memA1'), 'tasks', 'pB1')));
    await assertSucceeds(getDoc(doc(as('memA1'), 'tasks', 'pCrev')));
  });
  test('the owner can list a project by project id (the query the app runs)', async () => {
    await assertSucceeds(getDocs(query(collection(as('memA1'), 'tasks'), where('projectId', '==', 'pOwned'),
      where('archived', '==', false), where('statusCategory', 'in', ['todo', 'active', 'review', 'paused']))));
    await assertSucceeds(getDocs(query(collection(as('memA1'), 'tasks'), where('projectId', '==', 'pOwned'), where('statusCategory', '==', 'done'))));
  });
  test('owning one project gives no view of another project or of a project without an owner', async () => {
    await assertFails(getDoc(doc(as('memA1'), 'tasks', 'pOtherB')));
    await assertFails(getDoc(doc(as('memA1'), 'tasks', 'pOldB')));
    await assertFails(getDocs(query(collection(as('memA1'), 'tasks'), where('projectId', '==', 'pOther'))));
  });
  test('someone who owns nothing cannot list a project they do not own', async () => {
    await assertFails(getDocs(query(collection(as('memA2'), 'tasks'), where('projectId', '==', 'pOwned'))));
  });
  test('a person reads the tasks they handed to someone in another team', async () => {
    await assertSucceeds(getDocs(query(collection(as('ldrB'), 'tasks'), where('createdBy', '==', 'ldrB'))));
    await assertFails(getDocs(query(collection(as('memA2'), 'tasks'), where('createdBy', '==', 'ldrB'))));
  });
  test('the owner reads and writes comments on tasks in the project', async () => {
    await assertSucceeds(getDocs(collection(as('memA1'), 'tasks', 'pB1', 'comments')));
    await assertFails(getDocs(collection(as('memA2'), 'tasks', 'pB1', 'comments')));
  });

  test('the owner gives a task in the project to a person in another team', async () => {
    await assertSucceeds(createTask('memA1', 'newX', { ownerId: 'memC', teamId: 'teamC', projectId: 'pOwned' }));
  });
  test('the person who gets it must be in the task\'s team', async () => {
    await assertFails(createTask('memA1', 'newY', { ownerId: 'memC', teamId: 'teamB', projectId: 'pOwned' }));
  });
  test('a member who does not own the project cannot give work to others', async () => {
    await assertFails(createTask('memA2', 'newZ', { ownerId: 'memC', teamId: 'teamC', projectId: 'pOwned' }));
    await assertFails(createTask('memA1', 'newW', { ownerId: 'memC', teamId: 'teamC', projectId: 'pOther' }));
  });
  test('the owner reassigns a task to another person and team', async () => {
    await assertSucceeds(updateTask('memA1', 'pB1', { ownerId: 'memC', teamId: 'teamC' }, 'teamB'));
  });
  test('the owner cannot move a task to a person outside the new team', async () => {
    await assertFails(updateTask('memA1', 'pB1', { ownerId: 'memC', teamId: 'teamB' }, 'teamB'));
  });
  test('the owner approves work that is in Review', async () => {
    await assertSucceeds(updateTask('memA1', 'pBrev', toDone, 'teamB'));
  });
  test('the owner sends work back from Review', async () => {
    await assertSucceeds(updateTask('memA1', 'pCrev', { status: 'inprogress', statusCategory: 'active', reworks: 1 }, 'teamC'));
  });
  test('the owner cannot finish work that is not in Review', async () => {
    await assertFails(updateTask('memA1', 'pB1', toDone, 'teamB'));
  });
  test('the owner cannot edit other people\'s details', async () => {
    await assertFails(updateTask('memA1', 'pB1', { title: 'Renamed' }, 'teamB'));
    await assertFails(updateTask('memA1', 'pB1', { dueDate: '2027-01-01' }, 'teamB'));
    await assertFails(updateTask('memA1', 'pB1', { priority: 'urgent' }, 'teamB'));
    await assertFails(updateTask('memA1', 'pB1', { archived: true }, 'teamB'));
    await assertFails(updateTask('memA1', 'pB1', { projectId: 'pOther' }, 'teamB'));
  });
  test('the owner cannot approve their own task', async () => {
    await assertFails(updateTask('memA1', 'ownReview', toDone, 'teamA'));
  });
  test('a person who is not the owner cannot use any of this', async () => {
    await assertFails(updateTask('memA2', 'pBrev', toDone, 'teamB'));
    await assertFails(updateTask('memA2', 'pB1', { ownerId: 'memC', teamId: 'teamC' }, 'teamB'));
  });

  test('a leader or above sets a project owner; a member cannot', async () => {
    await assertSucceeds(logged('ldrA', { path: 'projects/pOld', kind: 'update', type: 'project', entityId: 'pOld', teamId: 'teamA', data: { ownerId: 'memA2' } }));
    await assertFails(logged('memA1', { path: 'projects/pOwned', kind: 'update', type: 'project', entityId: 'pOwned', teamId: 'teamA', data: { ownerId: 'memA1' } }));
    await assertFails(logged('memA1', { path: 'projects/pOwned', kind: 'update', type: 'project', entityId: 'pOwned', teamId: 'teamA', data: { name: 'Mine now' } }));
  });
});


// ------------------------------------------------------------- superuser

describe('superuser', () => {
  const upd = (uid, target, data) => logged(uid, { path: `users/${target}`, kind: 'update', type: 'user', entityId: target, teamId: null, data });
  const newUser = (over = {}) => ({
    name: 'New', email: 'new@x.test', role: 'member', teamIds: ['teamA'], active: true,
    createdAt: serverTimestamp(), lastLoginAt: null, ...over
  });

  test('a Superuser reads every team\'s tasks although their role is Team Leader', async () => {
    await assertSucceeds(getDoc(doc(as('su'), 'tasks', 'tB1')));
    await assertSucceeds(getDoc(doc(as('su'), 'tasks', 'tC1')));
    await assertFails(getDoc(doc(as('ldrA'), 'tasks', 'tB1')));      // an ordinary Team Leader still cannot
    await assertFails(getDoc(doc(as('notSu'), 'tasks', 'tB1')));     // superuser: false means nothing
  });
  test('a Superuser changes work in any team; an ordinary leader only their own', async () => {
    await assertSucceeds(updateTask('su', 'tB1', { title: 'Changed' }, 'teamB'));
    await assertSucceeds(updateTask('su', 'tA1', { dueDate: '2027-01-01' }));
    await assertFails(updateTask('ldrA', 'tB1', { title: 'Changed' }, 'teamB'));
    await assertFails(updateTask('notSu', 'tB1', { title: 'Changed' }, 'teamB'));
  });
  test('a Superuser creates tasks in any team', async () => {
    await assertSucceeds(createTask('su', 'suNew', { ownerId: 'memB', teamId: 'teamB' }));
    await assertFails(createTask('ldrA', 'ldrNew', { ownerId: 'memB', teamId: 'teamB' }));
  });
  test('a Superuser runs people, teams, statuses and holidays like the Director', async () => {
    await assertSucceeds(logged('su', { path: 'users/u1', kind: 'create', type: 'user', entityId: 'u1', teamId: null, data: newUser() }));
    await assertSucceeds(upd('su', 'memA1', { role: 'asst_leader' }));
    await assertSucceeds(logged('su', { path: 'teams/teamB', kind: 'update', type: 'team', entityId: 'teamB', teamId: 'teamB', data: { name: 'B2' } }));
    await assertFails(logged('ldrA', { path: 'teams/teamB', kind: 'update', type: 'team', entityId: 'teamB', teamId: 'teamB', data: { name: 'B3' } }));
  });
  test('a Superuser reads the whole activity log', async () => {
    await assertSucceeds(getDoc(doc(as('su'), 'activityLog', 'oldB')));
    await assertFails(getDoc(doc(as('ldrA'), 'activityLog', 'oldB')));
  });

  test('only a Director or Superuser can switch Superuser on for someone', async () => {
    await assertSucceeds(upd('dir', 'memA2', { superuser: true }));
    await assertSucceeds(upd('su', 'memA1', { superuser: true }));
    await assertFails(upd('ldrA', 'memA1', { superuser: true }));
    await assertFails(upd('mgrA', 'memA1', { superuser: true }));
    await assertFails(upd('notSu', 'memA1', { superuser: true }));
  });
  test('nobody makes themselves a Superuser', async () => {
    await assertFails(upd('ldrA', 'ldrA', { superuser: true }));
    await assertFails(upd('memA1', 'memA1', { superuser: true }));
    await assertFails(updateDoc(doc(as('memA1'), 'users', 'memA1'), { superuser: true }));   // not even without a log entry
  });
  test('a person who is made a Superuser gets the powers straight away', async () => {
    await assertFails(getDoc(doc(as('memA2'), 'tasks', 'tB1')));
    await assertSucceeds(upd('dir', 'memA2', { superuser: true }));
    await assertSucceeds(getDoc(doc(as('memA2'), 'tasks', 'tB1')));
    await assertSucceeds(upd('dir', 'memA2', { superuser: false }));
    await assertFails(getDoc(doc(as('memA2'), 'tasks', 'tB1')));
  });
  test('Superuser must be true or false', async () => {
    await assertFails(upd('dir', 'memA2', { superuser: 'yes' }));
    await assertFails(upd('dir', 'memA2', { superuser: 1 }));
  });

  test('the first Director can become a Superuser and change their own role in one save', async () => {
    await assertSucceeds(upd('dir', 'dir', { superuser: true, role: 'leader', teamIds: ['teamA'] }));
  });
  test('but a Director cannot just drop their role: that would remove their own powers', async () => {
    await assertFails(upd('dir', 'dir', { role: 'leader', teamIds: ['teamA'] }));
    await assertFails(upd('dir', 'dir', { role: 'leader', superuser: false }));
    await assertFails(upd('dir', 'dir', { role: 'member' }));
  });
  test('a Superuser cannot switch off their own Superuser access or deactivate themselves', async () => {
    await assertFails(upd('su', 'su', { superuser: false }));
    await assertFails(upd('su', 'su', { active: false }));
    await assertSucceeds(upd('su', 'su', { teamIds: ['teamA', 'teamB'] }));         // other self edits are fine
  });
  test('another Superuser or Director can switch it off', async () => {
    await assertSucceeds(upd('dir', 'su', { superuser: false }));
    await assertFails(getDoc(doc(as('su'), 'tasks', 'tB1')));
  });
  test('a deactivated Superuser has no powers at all', async () => {
    await assertFails(getDoc(doc(as('suGone'), 'tasks', 'tA1')));
    await assertFails(upd('suGone', 'memA1', { role: 'leader' }));
  });
});

// ------------------------------------------------------ checklist helpers

describe('checklist steps given to people', () => {
  const step = (over = {}) => ({ id: 's1', text: 'Step', done: false, ...over });
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      // memA1 was given step 1; step 2 belongs to the whole team. memA2 owns the task.
      await setDoc(doc(db, 'tasks', 'tStep'), taskDoc({
        ownerId: 'memA2', checklist: [step({ assigneeId: 'memA1' }), step({ id: 's2', forTeam: true }), step({ id: 's3' })],
        checklistAssignees: ['memA1'], checklistForTeam: true
      }));
      await setDoc(doc(db, 'tasks', 'tOnlyPerson'), taskDoc({
        ownerId: 'memA2', checklist: [step({ assigneeId: 'memA1' })], checklistAssignees: ['memA1'], checklistForTeam: false
      }));
      await setDoc(doc(db, 'tasks', 'tLeaderOwns'), taskDoc({
        ownerId: 'ldrA', checklist: [step({ assigneeId: 'memA1' })], checklistAssignees: ['memA1'], checklistForTeam: false
      }));
      await setDoc(doc(db, 'tasks', 'tStepDone'), taskDoc({
        ownerId: 'memA2', status: 'done', statusCategory: 'done', completedAt: new Date(), completedDate: '2026-11-01',
        checklist: [step({ assigneeId: 'memA1', done: true })], checklistAssignees: ['memA1'], checklistForTeam: false
      }));
    });
  });
  const tick = (uid, taskId, extra = {}) => updateTask(uid, taskId, {
    checklist: [step({ assigneeId: 'memA1', done: true, doneBy: uid }), step({ id: 's2', forTeam: true }), step({ id: 's3' })], ...extra
  });

  test('the person a step was given to can tick it on someone else\'s task', async () => {
    await assertSucceeds(tick('memA1', 'tStep'));
    await assertSucceeds(updateTask('memA1', 'tOnlyPerson', { checklist: [step({ assigneeId: 'memA1', done: true, doneBy: 'memA1' })] }));
  });
  test('a step given to the whole team can be ticked by anyone in that team', async () => {
    await assertSucceeds(updateTask('asstA', 'tStep', { checklist: [step({ assigneeId: 'memA1' }), step({ id: 's2', forTeam: true, done: true, doneBy: 'asstA' })] }));
    await assertSucceeds(updateTask('memA1', 'tStep', { checklist: [step({ assigneeId: 'memA1' }), step({ id: 's2', forTeam: true, done: true, doneBy: 'memA1' })] }));
  });
  test('someone in another team cannot', async () => {
    await assertFails(updateTask('memB', 'tStep', { checklist: [step({ done: true })] }));
    await assertFails(updateTask('memC', 'tOnlyPerson', { checklist: [step({ done: true })] }));
  });
  test('a team member who was not given a step cannot tick when no step is for the team', async () => {
    await assertFails(updateTask('memA1', 'tA2', { checklist: [step({ done: true })] }));        // old task: no helper fields
    await assertFails(updateTask('memA2', 'tLeaderOwns', { checklist: [step({ assigneeId: 'memA1', done: true })] }));
  });
  test('a helper can change the checklist and nothing else', async () => {
    await assertFails(tick('memA1', 'tStep', { title: 'Renamed' }));
    await assertFails(tick('memA1', 'tStep', { status: 'inprogress', statusCategory: 'active' }));
    await assertFails(tick('memA1', 'tStep', { dueDate: '2027-02-02' }));
    await assertFails(tick('memA1', 'tStep', { ownerId: 'memA1' }));
    await assertFails(tick('memA1', 'tStep', { archived: true }));
  });
  test('a helper cannot give themselves or others more steps', async () => {
    await assertFails(updateTask('memA1', 'tStep', { checklistAssignees: ['memA1', 'memA2'] }));
    await assertFails(updateTask('memA1', 'tStep', { checklistForTeam: false }));
    await assertFails(updateTask('memA1', 'tA2', { checklistAssignees: ['memA1'], checklistForTeam: false }));
    await assertFails(updateTask('memA1', 'tA2', { checklistAssignees: ['memA1'], checklist: [step({ assigneeId: 'memA1', done: true })] }));
  });
  test('nothing can be ticked once the task is finished', async () => {
    await assertFails(updateTask('memA1', 'tStepDone', { checklist: [step({ assigneeId: 'memA1', done: false })] }));
  });
  test('the checklist still has a limit of 60 steps', async () => {
    await assertFails(updateTask('memA1', 'tOnlyPerson', { checklist: Array.from({ length: 61 }, (_, i) => step({ id: 'x' + i, assigneeId: 'memA1' })) }));
  });
  test('the owner and a leader can still edit the checklist and who it is given to', async () => {
    await assertSucceeds(updateTask('memA2', 'tStep', { checklist: [step({ assigneeId: 'memA1', done: true }), step({ id: 's2', forTeam: true }), step({ id: 's3' })] }));
    await assertSucceeds(updateTask('ldrA', 'tStep', { checklist: [step({ assigneeId: 'memA2' })], checklistAssignees: ['memA2'], checklistForTeam: false }));
  });
  test('a new task may carry the two summary fields, with the right types', async () => {
    await assertSucceeds(createTask('ldrA', 'withSteps', { checklist: [step({ assigneeId: 'memA1' })], checklistAssignees: ['memA1'], checklistForTeam: false }));
    await assertFails(createTask('ldrA', 'badSteps1', { checklistForTeam: 'yes' }));
    await assertFails(createTask('ldrA', 'badSteps2', { checklistAssignees: 'memA1' }));
  });
  test('an Assistant Team Leader can give a task to several people in their team, one task each', async () => {
    await assertSucceeds(createTask('asstA', 'copy1', { ownerId: 'memA1' }));
    await assertSucceeds(createTask('asstA', 'copy2', { ownerId: 'memA2' }));
    await assertFails(createTask('asstA', 'copy3', { ownerId: 'memB', teamId: 'teamB' }));
  });
  test('a plain member cannot give a task to someone else', async () => {
    await assertFails(createTask('memA1', 'memCopy', { ownerId: 'memA2' }));
  });
});

// ---------------------------------------------------------------- task extras and templates

describe('tags, waiting-for, and who gave the task', () => {
  test('a leader can create a task with tags, blockers and an assignment stamp', async () => {
    await assertSucceeds(createTask('ldrA', id('t'), { tags: ['admissions', 'event'], blockedBy: ['tA1'], assignedBy: 'ldrA', assignedAt: serverTimestamp() }));
  });
  test('more than 8 tags or 5 blockers is refused', async () => {
    await assertFails(createTask('ldrA', id('t'), { tags: Array.from({ length: 9 }, (_, i) => 't' + i) }));
    await assertFails(createTask('ldrA', id('t'), { blockedBy: ['a', 'b', 'c', 'd', 'e', 'f'] }));
  });
  test('tags must be a list and assignedBy a string', async () => {
    await assertFails(createTask('ldrA', id('t'), { tags: 'admissions' }));
    await assertFails(createTask('ldrA', id('t'), { assignedBy: 5 }));
    await assertFails(createTask('ldrA', id('t'), { assignedAt: 'yesterday' }));
  });
  test('a leader can edit tags and blockers on a task of their team', async () => {
    await assertSucceeds(updateTask('ldrA', 'tA1', { tags: ['qc'], blockedBy: ['tA2'] }));
  });
  test('a member cannot change tags or blockers, even on their own task', async () => {
    await assertFails(updateTask('memA1', 'tA1', { tags: ['sneaky'] }));
    await assertFails(updateTask('memA1', 'tA1', { blockedBy: ['tA2'] }));
  });
  test('a member still moves their own task along', async () => {
    await assertSucceeds(updateTask('memA1', 'tA1', { status: 'inprogress', statusCategory: 'active' }));
  });
  test('reassigning stamps the new owner; a member cannot reassign', async () => {
    await assertSucceeds(updateTask('ldrA', 'tA1', { ownerId: 'memA2', assignedBy: 'ldrA', assignedAt: serverTimestamp() }));
    await assertFails(updateTask('memA1', 'tA1', { ownerId: 'memA2', assignedBy: 'memA1', assignedAt: serverTimestamp() }));
  });
});

describe('task templates', () => {
  const tpl = (over = {}) => ({
    name: 'Monthly report', teamId: 'teamA', title: 'Report for {month}', description: '', priority: 'medium',
    ownerIds: ['memA1'], repeat: 'monthly', nextDate: '2026-12-01', active: true, dueInDays: 5, tags: ['report'],
    checklist: [{ id: 's1', text: 'Collect' }], createdBy: 'ldrA', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over
  });
  const makeTpl = (uid, tid, over = {}) => logged(uid, { path: `taskTemplates/${tid}`, kind: 'create', type: 'template', entityId: tid, teamId: over.teamId || 'teamA', data: tpl({ createdBy: uid, ...over }) });
  const seedTpl = (tid = 'tpl1', over = {}) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'taskTemplates', tid), { ...tpl(over), createdAt: new Date(), updatedAt: new Date(), lastLogId: 'seedlog' }));
  const editTpl = (uid, tid, patch, teamId = 'teamA') => logged(uid, { path: `taskTemplates/${tid}`, kind: 'update', type: 'template', entityId: tid, teamId, data: { updatedAt: serverTimestamp(), ...patch } });

  test('Team Leader, Manager, Director and Superuser can create one for their team', async () => {
    await assertSucceeds(makeTpl('ldrA', id('tpl')));
    await assertSucceeds(makeTpl('mgrA', id('tpl')));
    await assertSucceeds(makeTpl('dir', id('tpl')));
    await assertSucceeds(makeTpl('su', id('tpl')));
  });
  test('Assistant Team Leader, members and other teams\' leaders cannot', async () => {
    await assertFails(makeTpl('asstA', id('tpl')));
    await assertFails(makeTpl('memA1', id('tpl')));
    await assertFails(makeTpl('ldrB', id('tpl')));
    await assertFails(makeTpl('notSu', id('tpl'), { teamId: 'teamB' }));
  });
  test('a template needs its log entry', async () => {
    const db = as('ldrA');
    await assertFails(setDoc(doc(db, 'taskTemplates', id('tpl')), { ...tpl(), lastLogId: 'nothing' }));
  });
  test('bad shapes are refused', async () => {
    await assertFails(makeTpl('ldrA', id('tpl'), { repeat: 'daily' }));
    await assertFails(makeTpl('ldrA', id('tpl'), { ownerIds: [] }));
    await assertFails(makeTpl('ldrA', id('tpl'), { ownerIds: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    await assertFails(makeTpl('ldrA', id('tpl'), { dueInDays: 400 }));
    await assertFails(makeTpl('ldrA', id('tpl'), { priority: 'whenever' }));
    await assertFails(makeTpl('ldrA', id('tpl'), { name: '' }));
    await assertFails(makeTpl('ldrA', id('tpl'), { createdBy: 'memA1' }));
  });
  test('read: the team\'s leaders and assistants and the Director, not members or other teams', async () => {
    await seedTpl();
    await assertSucceeds(getDoc(doc(as('ldrA'), 'taskTemplates', 'tpl1')));
    await assertSucceeds(getDoc(doc(as('asstA'), 'taskTemplates', 'tpl1')));
    await assertSucceeds(getDoc(doc(as('dir'), 'taskTemplates', 'tpl1')));
    await assertFails(getDoc(doc(as('memA1'), 'taskTemplates', 'tpl1')));
    await assertFails(getDoc(doc(as('ldrB'), 'taskTemplates', 'tpl1')));
  });
  test('the exact queries the app runs', async () => {
    await seedTpl();
    await assertSucceeds(getDocs(query(collection(as('ldrA'), 'taskTemplates'), where('teamId', '==', 'teamA'))));
    await assertSucceeds(getDocs(collection(as('dir'), 'taskTemplates')));
    await assertFails(getDocs(collection(as('ldrA'), 'taskTemplates')));
  });
  test('edit and move the next date on (what the generator writes)', async () => {
    await seedTpl();
    await assertSucceeds(editTpl('ldrA', 'tpl1', { nextDate: '2027-01-01', lastRunDate: '2026-12-01' }));
    await assertSucceeds(editTpl('ldrA', 'tpl1', { active: false }));
    await assertFails(editTpl('asstA', 'tpl1', { active: false }));
    await assertFails(editTpl('ldrB', 'tpl1', { active: false }));
  });
  test('a template cannot be moved to a team the editor does not manage, or deleted', async () => {
    await seedTpl();
    await assertFails(editTpl('ldrA', 'tpl1', { teamId: 'teamB' }));
    await assertFails(deleteDoc(doc(as('dir'), 'taskTemplates', 'tpl1')));
  });
  test('the generator batch: tasks with fixed ids + template update + logs, in one write', async () => {
    await seedTpl('tplGen', { ownerIds: ['memA1', 'memA2'], nextDate: '2026-11-01' });
    const db = as('ldrA');
    const batch = writeBatch(db);
    const logs = [];
    for (const owner of ['memA1', 'memA2']) {
      const tid = `rec-tplGen-2026-11-01-${owner}`;
      const lid = id('log');
      batch.set(doc(db, 'tasks', tid), taskDoc({ ownerId: owner, createdBy: 'ldrA', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastLogId: lid, recurringId: 'tplGen', assignedBy: 'ldrA', assignedAt: serverTimestamp(), tags: ['report'] }));
      batch.set(doc(db, 'activityLog', lid), logBody('ldrA', 'leader', 'task', tid, 'teamA'));
      logs.push(lid);
    }
    const tl = id('log');
    batch.update(doc(db, 'taskTemplates', 'tplGen'), { nextDate: '2026-12-01', lastRunDate: '2026-11-01', updatedAt: serverTimestamp(), lastLogId: tl });
    batch.set(doc(db, 'activityLog', tl), logBody('ldrA', 'leader', 'template', 'tplGen', 'teamA'));
    await assertSucceeds(batch.commit());
  });
  test('a second attempt to make the same occurrence is refused (the task already exists)', async () => {
    await seedTpl('tplGen2', { ownerIds: ['memA1'], nextDate: '2026-11-01' });
    const make = async () => {
      const db = as('ldrA');
      const batch = writeBatch(db);
      const tid = 'rec-tplGen2-2026-11-01-memA1';
      const lid = id('log');
      batch.set(doc(db, 'tasks', tid), taskDoc({ ownerId: 'memA1', createdBy: 'ldrA', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastLogId: lid }));
      batch.set(doc(db, 'activityLog', lid), logBody('ldrA', 'leader', 'task', tid, 'teamA'));
      return batch.commit();
    };
    await assertSucceeds(make());
    await assertFails(make());
  });
});
