// Report maths for the Reports page. Pure functions: no screen, no database, so the page, the
// Excel file and the tests all use the same numbers.
//
// What the numbers mean (also shown on the report):
//  - Completed: a task that reached a Done status, counted on the day it was completed.
//  - On time: completed on or before its due date (no due date counts as on time).
//  - Steps done: checklist steps ticked in the period, credited to the person who ticked them
//    (on their own task or someone else's). Steps waiting: steps given to a person, not yet done.
//  - Due in the period: tasks whose due date falls in the period (cancelled ones left out). Each one is
//    sorted by what happened, judged at the end of the period (or today, if it is still running):
//    done on time, done late, done only after the period ended, overdue, or not yet due.
//  - Backlog: tasks past their due date and not finished. "Brought in" = due before the period began and
//    not finished before it began. "Backlog at the end" = brought in and still not finished, plus tasks
//    due in the period that were not finished by its end. It is worked out from due and completed dates,
//    so it is exact for tasks that stayed in their status, but a task that was reopened or cancelled
//    later cannot be placed exactly (the app keeps no history of status changes).
//  - Created: tasks added in the period. Tasks that were cancelled ("closed") are not included.
//  - Open now / Overdue now: the position today. The app does not keep history, so this is
//    never "as at the end of the period".
//  - Leave days: approved working days inside the period (weekends and holidays excluded).

import { appSettings } from '../config.js';
import { OPEN_CATEGORIES, LEAVE_TYPES } from './model.js';
import { wasOnTime, isOverdue, isOpenTask } from './metrics.js';
import { leaveWorkdays, isApproved, weekStartsOn } from './calendar.js';
import {
  addDays, addMonths, endOfMonth, startOfMonth, startOfWeek, daysBetween, eachDay, toISO, toDate, fmtDate, parseISO
} from './util.js';

export const PERIOD_KINDS = [
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'last_year', label: 'Last year' },
  { value: 'custom', label: 'Custom dates' }
];

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtFull = (iso) => { const d = parseISO(iso); return `${d.getDate()} ${MONTHS_LONG[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
export const rangeLabel = (from, to) => `${fmtFull(from)} to ${fmtFull(to)}`;

// The company's year may not start in January: appSettings.fiscalYearStartMonth (1 to 12).
export const fiscalStartMonth = () => {
  const m = Number(appSettings.fiscalYearStartMonth);
  return m >= 1 && m <= 12 ? m : 1;
};

// First day of the fiscal quarter that contains `iso`, and the fiscal year label it belongs to.
function quarterOf(iso, startMonth = fiscalStartMonth()) {
  const d = parseISO(iso);
  const monthsIntoYear = (d.getMonth() + 1 - startMonth + 12) % 12;
  const q = Math.floor(monthsIntoYear / 3);
  const from = toISO(new Date(d.getFullYear(), d.getMonth() - (monthsIntoYear % 3), 1));
  const yearStart = toISO(new Date(d.getFullYear(), d.getMonth() - monthsIntoYear, 1));
  const yearEndsIn = Number(addMonths(yearStart, 11).slice(0, 4));
  return { from, to: endOfMonth(addMonths(from, 2)), q: q + 1, fy: startMonth === 1 ? Number(yearStart.slice(0, 4)) : yearEndsIn };
}

function yearOf(iso, startMonth = fiscalStartMonth()) {
  const d = parseISO(iso);
  const monthsIntoYear = (d.getMonth() + 1 - startMonth + 12) % 12;
  const from = toISO(new Date(d.getFullYear(), d.getMonth() - monthsIntoYear, 1));
  const to = endOfMonth(addMonths(from, 11));
  return { from, to, fy: startMonth === 1 ? Number(from.slice(0, 4)) : Number(to.slice(0, 4)) };
}

// One natural period of `kind` that contains `iso`.
function natural(kind, iso) {
  if (kind === 'week') {
    const from = startOfWeek(iso, weekStartsOn());
    return { from, to: addDays(from, 6), name: `Week of ${fmtFull(from).replace(/ \d{4}$/, '')}`, title: 'Weekly report' };
  }
  if (kind === 'month') {
    const from = startOfMonth(iso);
    const d = parseISO(iso);
    return { from, to: endOfMonth(from), name: `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`, title: 'Monthly report' };
  }
  if (kind === 'quarter') {
    const q = quarterOf(iso);
    const name = fiscalStartMonth() === 1 ? `Q${q.q} ${q.fy}` : `Q${q.q} FY${q.fy}`;
    return { from: q.from, to: q.to, name, title: 'Quarterly report' };
  }
  const y = yearOf(iso);
  return { from: y.from, to: y.to, name: fiscalStartMonth() === 1 ? String(y.fy) : `FY${y.fy}`, title: 'Annual report' };
}

// kind: this_week ... custom. Returns the period, the one before it (for "vs last time"),
// and the last day that counts (today, if the period is not over yet).
export function resolvePeriod(kind, today, custom = {}) {
  let p;
  if (kind === 'custom') {
    let from = custom.from || today, to = custom.to || today;
    if (to < from) [from, to] = [to, from];
    const days = daysBetween(from, to) + 1;
    p = { from, to, name: `${fmtFull(from)} to ${fmtFull(to)}`, title: 'Progress report' };
    p.prev = { from: addDays(from, -days), to: addDays(from, -1) };
  } else {
    const [when, unit] = kind.split('_');
    const base = natural(unit, today);
    const target = when === 'last' ? natural(unit, addDays(base.from, -1)) : base;
    p = { ...target };
    p.prev = natural(unit, addDays(target.from, -1));
  }
  p.kind = kind;
  p.asOf = p.to < today ? p.to : today;           // progress counts up to today at most
  p.inProgress = p.to > today;
  p.days = daysBetween(p.from, p.to) + 1;
  p.label = rangeLabel(p.from, p.to);
  return p;
}

// Chart buckets: days for a short period, weeks for up to about four months, otherwise months.
export function bucketsFor(period) {
  const out = [];
  const clip = (start, end) => ({ start: start < period.from ? period.from : start, end: end > period.to ? period.to : end });
  if (period.days <= 14) {
    for (const d of eachDay(period.from, period.to)) out.push({ start: d, end: d, unit: 'day' });
  } else if (period.days <= 125) {
    for (let s = startOfWeek(period.from, weekStartsOn()); s <= period.to; s = addDays(s, 7)) out.push({ ...clip(s, addDays(s, 6)), unit: 'week' });
  } else {
    for (let s = startOfMonth(period.from); s <= period.to; s = addMonths(s, 1)) out.push({ ...clip(s, endOfMonth(s)), unit: 'month' });
  }
  return out;
}

export function bucketLabel(b) {
  const d = parseISO(b.start);
  if (b.unit === 'month') return MONTHS_LONG[d.getMonth()].slice(0, 3);
  return `${d.getDate()} ${MONTHS_LONG[d.getMonth()].slice(0, 3)}`;
}

const dateOf = (value) => { const d = toDate(value); return d ? toISO(d) : null; };
const inRange = (iso, from, to) => !!iso && iso >= from && iso <= to;
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

export const daysToFinish = (t) => {
  const created = dateOf(t.createdAt);
  return created && t.completedDate ? Math.max(0, daysBetween(created, t.completedDate)) : null;
};

// Approved leave clipped to a period, in working days.
function leaveInRange(leaves, from, to, people, holidays) {
  const personById = new Map(people.map((p) => [p.id, p]));
  const rows = [];
  for (const l of leaves) {
    if (!isApproved(l) || l.endDate < from || l.startDate > to) continue;
    const clipped = { ...l, startDate: l.startDate < from ? from : l.startDate, endDate: l.endDate > to ? to : l.endDate };
    const days = leaveWorkdays(clipped, personById.get(l.userId), holidays);
    if (days > 0) rows.push({ leave: l, days });
  }
  return rows;
}

export const OUTCOME_LABEL = {
  onTime: 'Done on time', late: 'Done late', doneAfter: 'Done after the period', overdue: 'Overdue', notYetDue: 'Not yet due'
};

// Planned work and backlog for a list of tasks over one period. See the notes at the top of this file.
export function planOf(list, period, today) {
  const { from, to } = period;
  const cutoff = period.asOf;
  const isDone = (t) => t.statusCategory === 'done';
  const live = list.filter((t) => isDone(t) || isOpenTask(t));                // cancelled and archived-while-open tasks are left out
  const existed = (t) => { const c = dateOf(t.createdAt); return !c || c <= cutoff; };
  const outcomeOf = (t) => {
    if (isDone(t)) {
      const c = t.completedDate || '';
      if (c > cutoff) return 'doneAfter';
      return c <= t.dueDate ? 'onTime' : 'late';
    }
    return t.dueDate < today ? 'overdue' : 'notYetDue';
  };

  const dueItems = live.filter((t) => t.dueDate && inRange(t.dueDate, from, to) && existed(t))
    .map((t) => ({ task: t, outcome: outcomeOf(t) }));
  const count = (k) => dueItems.filter((x) => x.outcome === k).length;

  // Due before the period began and not finished before it began.
  const broughtIn = live.filter((t) => t.dueDate && t.dueDate < from && existed(t) && !(isDone(t) && (t.completedDate || '') < from));
  const cleared = broughtIn.filter((t) => isDone(t) && (t.completedDate || '') <= cutoff);
  const stuck = broughtIn.filter((t) => !cleared.includes(t));

  const endItems = [
    ...stuck.map((t) => ({ task: t, origin: 'before' })),
    ...dueItems.filter((x) => x.outcome === 'doneAfter' || x.outcome === 'overdue').map((x) => ({ task: x.task, origin: 'period' }))
  ].map((x) => ({ ...x, daysLate: daysBetween(x.task.dueDate, cutoff), stillOpen: !isDone(x.task) }))
    .sort((a, b) => a.task.dueDate.localeCompare(b.task.dueDate) || a.task.title.localeCompare(b.task.title));

  const finishedByEnd = count('onTime') + count('late');
  return {
    due: dueItems.length, onTime: count('onTime'), late: count('late'), doneAfter: count('doneAfter'),
    overdue: count('overdue'), notYetDue: count('notYetDue'),
    finishedByEnd,
    finishedBefore: dueItems.filter((x) => x.task.statusCategory === 'done' && (x.task.completedDate || '') < from).length,   // finished before the period began
    completionRate: dueItems.length ? finishedByEnd / dueItems.length : null,
    onTimeRate: dueItems.length ? count('onTime') / dueItems.length : null,
    broughtIn: broughtIn.length, cleared: cleared.length,
    backlogEnd: endItems.length,
    backlogFromBefore: stuck.length, backlogFromPeriod: endItems.length - stuck.length,
    dueItems: dueItems.sort((a, b) => a.task.dueDate.localeCompare(b.task.dueDate) || a.task.title.localeCompare(b.task.title)),
    endItems
  };
}

// Everything on the report, for one scope. `tasks` is every task loaded for the scope
// (open ones and those finished since the previous period began), unique by id.
export function compileReport({ period, tasks, people, leaves, holidays, today, projects = [], teamIds = [] }) {
  const { from, to, prev } = period;
  const personIds = new Set(people.map((p) => p.id));
  const mine = tasks.filter((t) => personIds.has(t.ownerId));
  const done = (a, b) => mine.filter((t) => t.statusCategory === 'done' && inRange(t.completedDate, a, b));
  const created = (a, b) => mine.filter((t) => inRange(dateOf(t.createdAt), a, b));

  const doneNow = done(from, to), donePrev = done(prev.from, prev.to);
  const onTimeNow = doneNow.filter(wasOnTime), onTimePrev = donePrev.filter(wasOnTime);
  const cycleNow = doneNow.map(daysToFinish).filter((x) => x !== null);
  const cyclePrev = donePrev.map(daysToFinish).filter((x) => x !== null);
  const reworkOf = (list) => list.reduce((n, t) => n + (t.reworks || 0), 0);

  const leaveNow = leaveInRange(leaves, from, to, people, holidays);
  const leavePrev = leaveInRange(leaves, prev.from, prev.to, people, holidays);
  const sumDays = (rows) => rows.reduce((n, r) => n + r.days, 0);

  const open = mine.filter(isOpenTask);
  const overdue = open.filter((t) => isOverdue(t, today));

  // Checklist steps count for the person who ticked them, whoever owns the task. The day is the
  // person's local day, like the completed date of a task.
  const stepsIn = (a, b) => tasks.flatMap((t) => (t.checklist || [])
    .filter((s) => s.done === true && s.doneBy && personIds.has(s.doneBy) && inRange(dateOf(s.doneAt), a, b))
    .map((s) => ({ task: t, step: s, by: s.doneBy, date: dateOf(s.doneAt) })));
  const stepsNow = stepsIn(from, to), stepsPrev = stepsIn(prev.from, prev.to);
  // Steps given to a person that are still waiting, on tasks that are still open.
  const stepsWaiting = (id) => tasks.filter(isOpenTask)
    .reduce((n, t) => n + (t.checklist || []).filter((s) => !s.done && s.assigneeId === id).length, 0);

  // Planned work (due in the period) and backlog
  const plan = planOf(mine, period, today);
  const planPrev = planOf(mine, { ...prev, asOf: prev.to }, today);
  // What the completed tasks were: due in the period, old backlog cleared, or finished ahead of their due date / with no due date.
  const completedMix = {
    dueInPeriod: doneNow.filter((t) => t.dueDate && inRange(t.dueDate, from, to)).length,
    backlog: doneNow.filter((t) => t.dueDate && t.dueDate < from).length,
    ahead: doneNow.filter((t) => !t.dueDate || t.dueDate > to).length
  };

  // Per bucket
  const buckets = bucketsFor(period).map((b) => {
    const d = doneNow.filter((t) => t.completedDate >= b.start && t.completedDate <= b.end);
    const on = d.filter(wasOnTime).length;
    return { ...b, label: bucketLabel(b), onTime: on, late: d.length - on, total: d.length, created: created(b.start, b.end).length };
  });
  const active = buckets.filter((b) => b.total > 0 || b.start <= period.asOf);
  const busiest = active.length && Math.max(...active.map((b) => b.total)) > 0
    ? active.reduce((best, b) => (b.total > best.total ? b : best)) : null;
  const quietest = active.length > 1 && busiest
    ? active.filter((b) => b.end <= period.asOf).reduce((q, b) => (!q || b.total < q.total ? b : q), null) : null;

  // Per person
  const peopleRows = people.map((p) => {
    const d = doneNow.filter((t) => t.ownerId === p.id);
    const on = d.filter(wasOnTime).length;
    const cyc = d.map(daysToFinish).filter((x) => x !== null);
    const myOpen = open.filter((t) => t.ownerId === p.id);
    const myLeave = leaveNow.filter((r) => r.leave.userId === p.id);
    const myPlan = planOf(mine.filter((t) => t.ownerId === p.id), period, today);
    const byType = Object.fromEntries(LEAVE_TYPES.map((k) => [k, myLeave.filter((r) => r.leave.type === k).reduce((n, r) => n + r.days, 0)]));
    return {
      person: p, done: d.length, onTime: on, late: d.length - on, rate: d.length ? on / d.length : null,
      avgDays: mean(cyc), rework: reworkOf(d), created: created(from, to).filter((t) => t.ownerId === p.id).length,
      openNow: myOpen.length, overdueNow: myOpen.filter((t) => isOverdue(t, today)).length,
      stepsDone: stepsNow.filter((x) => x.by === p.id).length,
      stepsHelped: stepsNow.filter((x) => x.by === p.id && x.task.ownerId !== p.id).length,   // on someone else's task
      stepsWaiting: stepsWaiting(p.id),
      due: myPlan.due, dueDone: myPlan.finishedByEnd, dueOnTime: myPlan.onTime, backlogEnd: myPlan.backlogEnd, backlogIn: myPlan.broughtIn,
      leaveDays: sumDays(myLeave), leaveByType: byType
    };
  }).sort((a, b) => a.person.name.localeCompare(b.person.name));

  // Per project
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const keys = new Set([...doneNow, ...open].map((t) => t.projectId || ''));
  const projectRows = [...keys].map((id) => {
    const d = doneNow.filter((t) => (t.projectId || '') === id);
    const o = open.filter((t) => (t.projectId || '') === id);
    return {
      id, name: id ? (projectName.get(id) || 'Unknown project') : 'No project', done: d.length,
      onTime: d.filter(wasOnTime).length, openNow: o.length, overdueNow: o.filter((t) => isOverdue(t, today)).length
    };
  }).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));

  // Leave and holidays
  const leaveByType = LEAVE_TYPES.map((k) => ({ type: k, days: leaveNow.filter((r) => r.leave.type === k).reduce((n, r) => n + r.days, 0) }));
  const hols = (holidays || [])
    .filter((x) => x.active !== false && inRange(x.date, from, to) && (!x.teamId || teamIds.length === 0 || teamIds.includes(x.teamId)))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sortByDone = (a, b) => (a.completedDate || '').localeCompare(b.completedDate || '') || a.title.localeCompare(b.title);
  return {
    period,
    headline: {
      completed: doneNow.length, completedPrev: donePrev.length,
      onTimeRate: doneNow.length ? onTimeNow.length / doneNow.length : null,
      onTimeRatePrev: donePrev.length ? onTimePrev.length / donePrev.length : null,
      late: doneNow.length - onTimeNow.length,
      created: created(from, to).length, createdPrev: created(prev.from, prev.to).length,
      avgDays: mean(cycleNow), avgDaysPrev: mean(cyclePrev),
      rework: reworkOf(doneNow), reworkPrev: reworkOf(donePrev),
      leaveDays: sumDays(leaveNow), leaveDaysPrev: sumDays(leavePrev),
      openNow: open.length, overdueNow: overdue.length,
      steps: stepsNow.length, stepsPrev: stepsPrev.length,
      due: plan.due, dueDone: plan.finishedByEnd, dueOnTime: plan.onTime, dueLate: plan.late,
      dueNotDone: plan.doneAfter + plan.overdue + plan.notYetDue,
      completionRate: plan.completionRate, completionRatePrev: planPrev.completionRate, duePrev: planPrev.due,
      backlogIn: plan.broughtIn, backlogCleared: plan.cleared, backlogEnd: plan.backlogEnd, backlogEndPrev: planPrev.backlogEnd
    },
    plan, planPrev, completedMix,
    steps: stepsNow.sort((a, b) => a.date.localeCompare(b.date) || a.step.text.localeCompare(b.step.text)),
    buckets, busiest, quietest,
    people: peopleRows, projects: projectRows,
    completed: doneNow.sort(sortByDone),
    open: open.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title)),
    overdue: overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    leaveByType, leaveRows: leaveNow.sort((a, b) => a.leave.startDate.localeCompare(b.leave.startDate)),
    holidays: hols
  };
}

// "+3 (up from 12)" style comparison text. `unit` is appended to the change; lowerIsBetter
// flips which direction counts as good.
export function compare(now, before, { unit = '', digits = 0, lowerIsBetter = false } = {}) {
  if (now === null || now === undefined || before === null || before === undefined) return { text: 'no earlier figure', tone: '' };
  const diff = Math.round((now - before) * 10 ** digits) / 10 ** digits;
  if (diff === 0) return { text: 'same as last period', tone: '' };
  const sign = diff > 0 ? '+' : '−';
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  return { text: `${sign}${Math.abs(diff)}${unit} vs last period`, tone: good ? 'good' : 'bad' };
}

export { fmtDate };
