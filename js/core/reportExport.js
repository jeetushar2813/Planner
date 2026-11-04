// Turns a compiled report (js/core/report.js) into the sheets of an Excel workbook.
// `lookup` supplies names: { user, team, status, project, today, scope, by }.

import { LEAVE_TYPE_LABEL } from './model.js';
import { wasOnTime } from './metrics.js';
import { daysBetween } from './util.js';
import { daysToFinish, OUTCOME_LABEL } from './report.js';

const head = (cells) => cells.map((v) => ({ v, s: 'head' }));
const planDone = (p) => (p ? p.finishedByEnd : null);
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

export function reportSheets(model, lookup) {
  const { period, headline: h } = model;
  const sheets = [];

  // ---- Summary
  const change = (now, before, digits = 1) => (now === null || before === null || now === undefined || before === undefined ? null : Math.round((now - before) * 10 ** digits) / 10 ** digits);
  const line = (label, now, before, s) => [label, s ? { v: now, s } : now, s ? { v: before, s } : before,
    s === 'pct' ? (change(now, before, 3) === null ? null : { v: change(now, before, 3), s: 'pct' }) : change(now, before)];
  sheets.push({
    name: 'Summary', widths: [34, 16, 18, 14],
    rows: [
      [{ v: `${period.title}: ${period.name}`, s: 'title' }],
      ['For', lookup.scope],
      ['Period', period.label + (period.inProgress ? ` (still running; figures are up to ${period.asOf})` : '')],
      ['Compared with', `${period.prev.from} to ${period.prev.to}`],
      ['Prepared', `${lookup.today} by ${lookup.by}`],
      [],
      [],
      head(['Measure', 'This period', 'Previous period', 'Change']),
      line('Tasks due in the period', h.due, h.duePrev),
      line('...done by the end of the period', h.dueDone, planDone(model.planPrev)),
      line('...of those, done on time', h.dueOnTime, model.planPrev?.onTime),
      line('Share of due tasks done', h.completionRate, h.completionRatePrev, 'pct'),
      ['Backlog brought in', h.backlogIn, null, null],
      ['Backlog cleared in the period', h.backlogCleared, null, null],
      line(model.period.inProgress ? 'Backlog today' : 'Backlog at the end of the period', h.backlogEnd, h.backlogEndPrev),
      line('Tasks completed', h.completed, h.completedPrev),
      line('Finished on time', h.onTimeRate, h.onTimeRatePrev, 'pct'),
      line('Checklist steps done', h.steps, h.stepsPrev),
      line('Tasks created', h.created, h.createdPrev),
      line('Average days to finish', round1(h.avgDays), round1(h.avgDaysPrev), 'dec'),
      line('Times sent back for rework', h.rework, h.reworkPrev),
      ...(model.scopeKind === 'project' ? [['People involved', model.peopleInvolved, null, null]] : [line('Leave taken (working days)', h.leaveDays, h.leaveDaysPrev)]),
      ['Open tasks today', h.openNow, null, null],
      ['Overdue tasks today', h.overdueNow, null, null],
      [],
      model.busiest ? ['Busiest', `${model.busiest.label} (${model.busiest.total} completed)`] : [],
      model.quietest ? ['Quietest', `${model.quietest.label} (${model.quietest.total} completed)`] : [],
      [],
      [{ v: 'How the numbers are worked out', s: 'bold' }],
      ['Due in the period: tasks whose due date is in the period (cancelled tasks left out), judged at the end of the period, or today if it is still running.'],
      ['Backlog: past their due date and not finished. Brought in = due before the period and not finished before it. At the end = brought in and still not finished, plus tasks due in the period not finished by its end.'],
      ['Backlog is worked out from due and completed dates; the app keeps no history of status changes, so a task reopened or cancelled later cannot be placed exactly.'],
      ['Completed: tasks that reached a Done status, counted on the day they were completed.'],
      ['On time: completed on or before the due date. A task with no due date counts as on time.'],
      ['Steps done: checklist steps ticked in the period, credited to the person who ticked them (on their own task or someone else\'s).'],
      ['Created: tasks added in the period. Cancelled tasks are not included.'],
      ['Open and overdue are the position today. The app does not keep history, so they are not as at the end of the period.'],
      model.scopeKind === 'project' ? ['People involved: everyone who owns a task in the project, in any team.']
        : ['Leave: approved working days inside the period. Weekends and public holidays are not counted.']
    ]
  });

  // ---- People
  sheets.push({
    name: 'People', widths: [24, 10, 10, 12, 10, 10, 8, 14, 10, 12, 12, 12, 10, 11, 12, 12, 10, 10, 10], header: 0,
    rows: [
      head(['Person', 'Due in period', 'Done of due', 'Backlog at end', 'Completed', 'On time', 'Late', 'Finished on time', 'Avg days to finish', 'Steps done', 'Steps on others tasks', 'Steps waiting', 'Rework', 'Created',
        'Open today', 'Overdue today', ...(model.scopeKind === 'project' ? [] : ['Leave days', 'Sick days', 'Annual days'])]),
      ...model.people.map((r) => [r.person.name, r.due, r.dueDone, r.backlogEnd, r.done, r.onTime, r.late, { v: r.rate, s: 'pct' }, { v: round1(r.avgDays), s: 'dec' },
        r.stepsDone, r.stepsHelped, r.stepsWaiting,
        r.rework, r.created, r.openNow, r.overdueNow,
        ...(model.scopeKind === 'project' ? [] : [r.leaveDays, r.leaveByType.sick || 0, r.leaveByType.annual || 0])])
    ]
  });

  // ---- Projects
  sheets.push({
    name: 'Projects', widths: [30, 12, 10, 12, 14], header: 0,
    rows: [head(['Project', 'Completed', 'On time', 'Open today', 'Overdue today']),
      ...model.projects.map((p) => [p.name, p.done, p.onTime, p.openNow, p.overdueNow])]
  });

  // ---- Over time
  sheets.push({
    name: 'Over time', widths: [16, 16, 10, 11, 10, 8], header: 0,
    rows: [head(['From', 'To', 'Created', 'Completed', 'On time', 'Late']),
      ...model.buckets.map((b) => [{ v: b.start, s: 'date' }, { v: b.end, s: 'date' }, b.created, b.total, b.onTime, b.late])]
  });

  // ---- Due in the period
  sheets.push({
    name: 'Due in period', widths: [48, 20, 18, 22, 14, 24, 14], header: 0,
    rows: [head(['Task', 'Owner', 'Team', 'Project', 'Due date', 'What happened', 'Completed']),
      ...model.plan.dueItems.map((x) => [x.task.title, lookup.user(x.task.ownerId), lookup.team(x.task.teamId), lookup.project(x.task.projectId),
        { v: x.task.dueDate, s: 'date' }, OUTCOME_LABEL[x.outcome], { v: x.task.statusCategory === 'done' ? x.task.completedDate : null, s: 'date' }])]
  });

  // ---- Backlog
  sheets.push({
    name: 'Backlog', widths: [48, 20, 18, 22, 14, 20, 20, 16], header: 0,
    rows: [head(['Task', 'Owner', 'Team', 'Project', 'Due date', 'Days late at the end', 'From', 'Finished?']),
      ...model.plan.endItems.map((x) => [x.task.title, lookup.user(x.task.ownerId), lookup.team(x.task.teamId), lookup.project(x.task.projectId),
        { v: x.task.dueDate, s: 'date' }, x.daysLate, x.origin === 'before' ? 'Before the period' : 'Due in the period',
        x.stillOpen ? 'Still open' : `Yes, ${x.task.completedDate}`])]
  });

  // ---- Completed
  sheets.push({
    name: 'Completed', widths: [48, 20, 18, 22, 14, 14, 10, 12, 8], header: 0,
    rows: [head(['Task', 'Owner', 'Team', 'Project', 'Due date', 'Completed', 'On time', 'Days to finish', 'Rework']),
      ...model.completed.map((t) => [t.title, lookup.user(t.ownerId), lookup.team(t.teamId), lookup.project(t.projectId),
        { v: t.dueDate || null, s: 'date' }, { v: t.completedDate, s: 'date' }, wasOnTime(t) ? 'Yes' : 'No', daysToFinish(t), t.reworks || 0])]
  });

  // ---- Steps
  sheets.push({
    name: 'Steps done', widths: [44, 44, 20, 20, 14], header: 0,
    rows: [head(['Step', 'Task', 'Done by', 'Task owner', 'Done on']),
      ...model.steps.map((x) => [x.step.text, x.task.title, lookup.user(x.by), lookup.user(x.task.ownerId), { v: x.date, s: 'date' }])]
  });

  // ---- Open today
  sheets.push({
    name: 'Open today', widths: [48, 20, 18, 22, 18, 14, 14], header: 0,
    rows: [head(['Task', 'Owner', 'Team', 'Project', 'Status', 'Due date', 'Days overdue']),
      ...model.open.map((t) => [t.title, lookup.user(t.ownerId), lookup.team(t.teamId), lookup.project(t.projectId), lookup.status(t.status),
        { v: t.dueDate || null, s: 'date' }, t.dueDate && t.dueDate < lookup.today ? daysBetween(t.dueDate, lookup.today) : null])]
  });

  // ---- Leave and holidays (a project report spans teams, so leave is left out)
  if (model.scopeKind !== 'project') sheets.push({
    name: 'Leave', widths: [24, 18, 18, 14, 14, 14, 12], header: 0,
    rows: [head(['Person', 'Team', 'Type', 'From', 'To', 'Working days in period', 'Half day']),
      ...model.leaveRows.map(({ leave: l, days }) => [l.userName || lookup.user(l.userId), lookup.team(l.teamId), LEAVE_TYPE_LABEL[l.type] || l.type,
        { v: l.startDate, s: 'date' }, { v: l.endDate, s: 'date' }, days, l.half && l.half !== 'full' ? l.half.toUpperCase() : null])]
  });
  if (model.scopeKind !== 'project') sheets.push({
    name: 'Holidays', widths: [16, 40, 22], header: 0,
    rows: [head(['Date', 'Holiday', 'Applies to']),
      ...model.holidays.map((x) => [{ v: x.date, s: 'date' }, x.name, x.teamId ? lookup.team(x.teamId) : 'Everyone'])]
  });

  return sheets;
}

export const reportFileName = (model, scope) =>
  `${model.period.title.replace(/ report$/i, '')} report - ${model.period.name} - ${scope}`
    .replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
