// Workload: how much work falls due in a period compared with the working time a person has.
// Pure functions (no screen, no database), so the page and the tests use the same numbers.
//
//  - Capacity: working days in the period (no weekends, no public holidays, no approved leave;
//    a half day of leave counts 0.5) times the hours in a working day (appSettings.workHoursPerDay, 8).
//  - Load: the estimated hours of open tasks due in the period or already overdue. A task due after
//    the period, or with no due date, is listed but not counted. A task with no estimate counts 0
//    hours and is flagged, so the figure is never silently too low.
//  - Steps waiting for a person are counted and listed, but not turned into hours (steps have no estimate).

import { appSettings } from '../config.js';
import { OPEN_CATEGORIES } from './model.js';
import { dayStatus } from './calendar.js';
import { addDays, eachDay, startOfWeek, startOfMonth, endOfMonth } from './util.js';
import { weekStartsOn } from './calendar.js';

export const hoursPerDay = () => {
  const n = Number(appSettings.workHoursPerDay);
  return n > 0 && n <= 24 ? n : 8;
};

export const WINDOWS = [
  { value: 'week', label: 'Rest of this week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'two_weeks', label: 'Next 2 weeks' },
  { value: 'month', label: 'Rest of this month' }
];

export function resolveWindow(kind, today) {
  const weekStart = startOfWeek(today, weekStartsOn());
  let from = today, to;
  if (kind === 'next_week') { from = addDays(weekStart, 7); to = addDays(from, 6); }
  else if (kind === 'two_weeks') to = addDays(today, 13);
  else if (kind === 'month') to = endOfMonth(startOfMonth(today));
  else to = addDays(weekStart, 6);
  if (to < from) to = from;
  return { kind, from, to };
}

export const UTIL_STATUS = {
  away: { label: 'No working days', tone: 'bad' },
  over: { label: 'Overloaded', tone: 'bad' },
  full: { label: 'Full', tone: 'warn' },
  ok: { label: 'Balanced', tone: 'good' },
  light: { label: 'Room for more', tone: 'good' },
  idle: { label: 'Nothing due', tone: '' }
};

export function statusFor(capacityHours, loadHours) {
  if (capacityHours <= 0) return loadHours > 0 ? 'away' : 'idle';
  const u = Math.round((loadHours / capacityHours) * 10000) / 10000;   // 19.2 of 24 is exactly 80%, not 79.999...
  if (u > 1) return 'over';
  if (u >= 0.8) return 'full';
  if (loadHours === 0) return 'idle';
  return u < 0.4 ? 'light' : 'ok';
}

const isOpen = (t) => !t.archived && OPEN_CATEGORIES.includes(t.statusCategory);

export function compileWorkload({ people, tasks, leaves, holidays, window, today, perDay = hoursPerDay() }) {
  const { from, to } = window;
  const days = eachDay(from, to);
  const open = tasks.filter(isOpen);

  const rows = people.map((p) => {
    const capDays = days.reduce((n, d) => {
      const s = dayStatus(p, d, leaves, holidays).state;
      return n + (s === 'available' ? 1 : s === 'half' ? 0.5 : 0);
    }, 0);
    const mine = open.filter((t) => t.ownerId === p.id);
    const due = mine.filter((t) => t.dueDate && t.dueDate <= to);
    const later = mine.filter((t) => t.dueDate && t.dueDate > to);
    const undated = mine.filter((t) => !t.dueDate);
    const hoursOf = (t) => (Number(t.estimateHours) > 0 ? Number(t.estimateHours) : 0);
    const load = due.reduce((n, t) => n + hoursOf(t), 0);
    const steps = open.flatMap((t) => (t.checklist || [])
      .filter((s) => !s.done && s.assigneeId === p.id)
      .map((s) => ({ task: t, step: s })));
    const capacityHours = capDays * perDay;
    return {
      person: p, capacityDays: capDays, capacityHours, loadHours: load, freeHours: Math.max(0, capacityHours - load),
      utilisation: capacityHours > 0 ? load / capacityHours : null,
      status: statusFor(capacityHours, load),
      due: due.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title)),
      later: later.sort((a, b) => a.dueDate.localeCompare(b.dueDate)), undated,
      overdue: due.filter((t) => t.dueDate < today).length,
      noEstimate: due.filter((t) => hoursOf(t) === 0).length,
      openCount: mine.length, steps
    };
  }).sort((a, b) => a.person.name.localeCompare(b.person.name));

  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const withCapacity = rows.filter((r) => r.capacityHours > 0);
  return {
    window, days: days.length, perDay, rows,
    totals: {
      capacityHours: sum('capacityHours'), loadHours: sum('loadHours'), freeHours: sum('freeHours'),
      overloaded: rows.filter((r) => r.status === 'over' || r.status === 'away').length,
      noEstimate: sum('noEstimate'), overdue: sum('overdue'),
      stepsWaiting: rows.reduce((n, r) => n + r.steps.length, 0)
    },
    // Who has the most room, for deciding who to ask.
    mostRoom: withCapacity.length ? [...withCapacity].sort((a, b) => b.freeHours - a.freeHours || a.person.name.localeCompare(b.person.name)).slice(0, 3) : []
  };
}

// Hours shown with at most one decimal and no trailing ".0".
export const fmtHours = (n) => `${Math.round(n * 10) / 10}`;
