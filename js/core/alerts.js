// Alerts for the signed-in person, worked out from the tasks the app already holds (their own
// open tasks are kept up to date live), so there are no extra database reads or writes.
//   assigned  someone else gave you a task after you last cleared the alerts
//   overdue   your open tasks past their due date
//   dueSoon   your open tasks due today or within the next 2 days
//   mentions  comments that name you with @ and that you have not marked read
//   steps     checklist steps someone gave you (on any task) after you last cleared the alerts
// "Seen" is remembered in this browser only.

import { OPEN_CATEGORIES } from './model.js';
import { toDate, addDays, todayISO } from './util.js';
import { newStepsFor } from './steps.js';

export const DUE_SOON_DAYS = 2;

export function computeAlerts(tasks, user, { seenAt = 0, today = todayISO(), mentions = [] } = {}) {
  const limit = addDays(today, DUE_SOON_DAYS);
  const allTasks = [...tasks];
  const mine = allTasks.filter((t) => t.ownerId === user.id && !t.archived && OPEN_CATEGORIES.includes(t.statusCategory));
  const giver = (t) => t.assignedBy || t.createdBy;
  const when = (t) => (toDate(t.assignedAt || t.createdAt)?.getTime?.() || 0);
  const assigned = mine.filter((t) => giver(t) && giver(t) !== user.id && when(t) > seenAt)
    .sort((a, b) => when(b) - when(a));
  const overdue = mine.filter((t) => t.dueDate && t.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const dueSoon = mine.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= limit).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const steps = newStepsFor(allTasks, user, seenAt, (t) => OPEN_CATEGORIES.includes(t.statusCategory));
  // Mentions stay until the person marks them read (they are stored as read: false/true).
  const named = [...mentions].filter((m) => m.read !== true && m.toId === user.id)
    .sort((a, b) => (toDate(b.createdAt)?.getTime?.() || 0) - (toDate(a.createdAt)?.getTime?.() || 0));
  const ids = new Set([...assigned, ...overdue, ...dueSoon, ...steps.map((s) => s.task)].map((t) => t.id));
  return { assigned, overdue, dueSoon, steps, mentions: named, count: ids.size + named.length };
}

// "Seen" time per person, in this browser.
const key = (uid) => `planner-alerts-seen-v1-${uid}`;
export function getSeen(uid) {
  try {
    const v = Number(localStorage.getItem(key(uid)));
    if (v) return v;
    localStorage.setItem(key(uid), String(Date.now()));  // first time: start from now, no flood of old tasks
  } catch { /* storage blocked: nothing is remembered */ }
  return Date.now();
}
export function markSeen(uid) {
  try { localStorage.setItem(key(uid), String(Date.now())); } catch { /* ignore */ }
}
