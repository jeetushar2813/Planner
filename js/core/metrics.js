// Productivity numbers for the Team Overview. Pure functions over task lists.
//
// What the numbers mean (shown in the page too):
//  - Overdue: open task whose due date is before today.
//  - Completed: a task that reached a Done status, counted on the date it was completed.
//  - On time: completed on or before its due date (a task with no due date counts as on time).
//  - Rework: how many times a task was sent back with "Returned for Rework".

import { OPEN_CATEGORIES } from './model.js';
import { addDays, daysBetween, startOfWeek, toISO, toDate } from './util.js';

export const isOpenTask = (t) => !t.archived && OPEN_CATEGORIES.includes(t.statusCategory);
export const isOverdue = (t, today) => isOpenTask(t) && !!t.dueDate && t.dueDate < today;
export const isDueWithin = (t, today, days) => isOpenTask(t) && !!t.dueDate && t.dueDate >= today && t.dueDate <= addDays(today, days);
export const wasOnTime = (t) => !t.dueDate || (t.completedDate || '') <= t.dueDate;

// The last `n` weeks, oldest first, the last one being the week that contains `today`.
export function lastWeeks(n, today, weekStartsOn = 1) {
  const thisWeek = startOfWeek(today, weekStartsOn);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addDays(thisWeek, -7 * i);
    out.push({ start, end: addDays(start, 6) });
  }
  return out;
}

// Completed tasks per week, split into on time and late.
export function completedPerWeek(finished, weeks) {
  return weeks.map((w) => {
    const inWeek = finished.filter((t) => t.statusCategory === 'done' && t.completedDate >= w.start && t.completedDate <= w.end);
    const onTime = inWeek.filter(wasOnTime).length;
    return { ...w, onTime, late: inWeek.length - onTime, total: inWeek.length };
  });
}

// Open tasks by status, in the order the statuses are set up.
export function statusBreakdown(open, statuses) {
  const counts = new Map();
  for (const t of open) counts.set(t.status, (counts.get(t.status) || 0) + 1);
  const rows = [];
  for (const s of statuses) {
    if (!OPEN_CATEGORIES.includes(s.category)) continue;
    if (counts.has(s.id)) { rows.push({ id: s.id, name: s.name, category: s.category, count: counts.get(s.id) }); counts.delete(s.id); }
  }
  for (const [id, count] of counts) rows.push({ id, name: id, category: 'todo', count }); // status removed since
  return rows;
}

// Everything the roster and workload chart need, for one person.
export function personStats(person, open, finished, today, periodStart) {
  const mine = open.filter((t) => t.ownerId === person.id);
  const done = finished.filter((t) => t.ownerId === person.id && t.statusCategory === 'done' && t.completedDate >= periodStart);
  const overdue = mine.filter((t) => isOverdue(t, today));
  const onTime = done.filter(wasOnTime);
  const cycle = done.map((t) => {
    const created = toDate(t.createdAt);
    return created && t.completedDate ? Math.max(0, daysBetween(toISO(created), t.completedDate)) : null;
  }).filter((x) => x !== null);
  return {
    open: mine.length,
    overdue: overdue.length,
    onTrack: mine.length - overdue.length,
    dueSoon: mine.filter((t) => isDueWithin(t, today, 7)).length,
    inReview: mine.filter((t) => t.statusCategory === 'review').length,
    paused: mine.filter((t) => t.statusCategory === 'paused').length,
    done: done.length,
    onTimeRate: done.length ? onTime.length / done.length : null,
    rework: done.reduce((n, t) => n + (t.reworks || 0), 0) + mine.reduce((n, t) => n + (t.reworks || 0), 0),
    avgCycleDays: cycle.length ? cycle.reduce((a, b) => a + b, 0) / cycle.length : null,
    hours: mine.reduce((n, t) => n + (Number(t.estimateHours) || 0), 0)
  };
}

export function teamStats(open, finished, today, periodStart) {
  const done = finished.filter((t) => t.statusCategory === 'done' && t.completedDate >= periodStart);
  const onTime = done.filter(wasOnTime);
  return {
    open: open.length,
    overdue: open.filter((t) => isOverdue(t, today)).length,
    dueSoon: open.filter((t) => isDueWithin(t, today, 7)).length,
    inReview: open.filter((t) => t.statusCategory === 'review').length,
    paused: open.filter((t) => t.statusCategory === 'paused').length,
    done: done.length,
    onTimeRate: done.length ? onTime.length / done.length : null
  };
}

export const pct = (rate) => (rate === null || rate === undefined ? '–' : Math.round(rate * 100) + '%');
