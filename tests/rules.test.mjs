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
  gone:  { role: 'member',      teamIds: ['teamA'], active: false }
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
