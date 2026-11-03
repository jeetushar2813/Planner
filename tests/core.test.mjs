// Tests for the calendar and productivity maths (no Firebase needed):  node --test tests/core.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWeekend, holidayFor, dayStatus, capacity, dayFlags, leaveWorkdays, ownerAwayOnDue, nextLeave
} from '../js/core/calendar.js';
import {
  lastWeeks, completedPerWeek, statusBreakdown, personStats, teamStats, isOverdue, wasOnTime, pct
} from '../js/core/metrics.js';
import { MY_KL_HOLIDAYS, MY_KL_YEARS } from '../js/data/holidays-my-kl.js';
import { dow, addDays } from '../js/core/util.js';
import { appSettings } from '../js/config.js';
import { resolvePeriod, bucketsFor, compileReport, compare } from '../js/core/report.js';
import { buildXlsx } from '../js/core/xlsx.js';
import { reportSheets } from '../js/core/reportExport.js';
import * as perm from '../js/core/perm.js';

// 2026-11-02 is a Monday.
const MON = '2026-11-02', TUE = '2026-11-03', WED = '2026-11-04', SAT = '2026-11-07', SUN = '2026-11-08', NEXT_MON = '2026-11-09';
const people = [
  { id: 'a', teamIds: ['t1'] }, { id: 'b', teamIds: ['t1'] }, { id: 'c', teamIds: ['t1'] }, { id: 'd', teamIds: ['t1'] }
];
const leave = (userId, startDate, endDate, over = {}) => ({ id: userId + startDate, userId, teamId: 't1', type: 'annual', startDate, endDate, half: 'full', status: 'approved', ...over });

describe('working days', () => {
  test('weekends', () => { assert.equal(isWeekend(SAT), true); assert.equal(isWeekend(SUN), true); assert.equal(isWeekend(MON), false); });
  test('a holiday applies to everyone or to one team', () => {
    const hol = [{ date: TUE, name: 'All', teamId: null, active: true }, { date: WED, name: 'T1 only', teamId: 't1', active: true }];
    assert.ok(holidayFor(TUE, 't9', hol));
    assert.ok(holidayFor(WED, 't1', hol));
    assert.equal(holidayFor(WED, 't2', hol), null);
  });
  test('removed holidays are ignored', () => {
    assert.equal(holidayFor(TUE, 't1', [{ date: TUE, teamId: null, active: false }]), null);
  });
});

describe('availability', () => {
  test('only approved leave counts', () => {
    const leaves = [leave('a', TUE, TUE), leave('b', TUE, TUE, { status: 'pending' }), leave('c', TUE, TUE, { status: 'declined' })];
    assert.equal(dayStatus(people[0], TUE, leaves, []).state, 'leave');
    assert.equal(dayStatus(people[1], TUE, leaves, []).state, 'available');
    assert.equal(dayStatus(people[2], TUE, leaves, []).state, 'available');
  });
  test('half day counts as half', () => {
    const cap = capacity(people, TUE, [leave('a', TUE, TUE, { half: 'am' })], []);
    assert.deepEqual([cap.expected, cap.away, cap.half, cap.available], [4, 0, 1, 3.5]);
  });
  test('weekend and holiday: nobody is expected', () => {
    assert.equal(capacity(people, SAT, [], []).expected, 0);
    assert.equal(capacity(people, TUE, [], [{ date: TUE, teamId: null, active: true }]).expected, 0);
  });
  test('warnings: short-staffed, heavy, nobody', () => {
    const half = capacity(people, TUE, [leave('a', TUE, TUE), leave('b', TUE, TUE)], []);
    assert.deepEqual(dayFlags(half, 0), ['short']);
    const one = capacity(people, TUE, [leave('a', TUE, TUE)], []);
    assert.deepEqual(dayFlags(one, 0), []);
    assert.deepEqual(dayFlags(capacity(people, TUE, [], []), 12), ['heavy']);
    assert.deepEqual(dayFlags(capacity(people, TUE, [], []), 11), []);
    const none = capacity(people, TUE, people.map((p) => leave(p.id, TUE, TUE)), []);
    assert.ok(dayFlags(none, 1).includes('nobody'));
  });
});

describe('leave length', () => {
  test('weekends are not counted', () => {
    assert.equal(leaveWorkdays(leave('a', WED, NEXT_MON), people[0], []), 4); // Wed Thu Fri + Mon
  });
  test('holidays are not counted', () => {
    assert.equal(leaveWorkdays(leave('a', MON, WED), people[0], [{ date: TUE, teamId: null, active: true }]), 2);
  });
  test('half day is 0.5', () => {
    assert.equal(leaveWorkdays(leave('a', TUE, TUE, { half: 'pm' }), people[0], []), 0.5);
  });
  test('all weekend = 0', () => {
    assert.equal(leaveWorkdays(leave('a', SAT, SUN), people[0], []), 0);
  });
  test('next leave and owner-away', () => {
    const leaves = [leave('a', WED, WED), leave('a', NEXT_MON, NEXT_MON), leave('a', MON, MON, { status: 'pending' })];
    assert.equal(nextLeave('a', TUE, leaves).startDate, WED);
    assert.ok(ownerAwayOnDue({ dueDate: WED }, people[0], leaves, []));
    assert.equal(ownerAwayOnDue({ dueDate: TUE }, people[0], leaves, []), null);
  });
});

describe('productivity numbers', () => {
  const today = TUE;
  const open = [
    { id: 1, ownerId: 'a', dueDate: MON, statusCategory: 'active', status: 'in_progress', archived: false },
    { id: 2, ownerId: 'a', dueDate: WED, statusCategory: 'review', status: 'in_review', archived: false },
    { id: 3, ownerId: 'b', dueDate: null, statusCategory: 'todo', status: 'pending', archived: false },
    { id: 4, ownerId: 'a', dueDate: MON, statusCategory: 'done', status: 'completed', archived: false } // finished, not open
  ];
  const fin = [
    { id: 10, ownerId: 'a', statusCategory: 'done', dueDate: TUE, completedDate: MON, reworks: 1 },
    { id: 11, ownerId: 'a', statusCategory: 'done', dueDate: MON, completedDate: TUE, reworks: 0 },
    { id: 12, ownerId: 'b', statusCategory: 'done', dueDate: null, completedDate: TUE, reworks: 0 }
  ];
  test('overdue only counts open tasks', () => {
    assert.equal(isOverdue(open[0], today), true);
    assert.equal(isOverdue(open[3], today), false);
    assert.equal(isOverdue(open[2], today), false);
  });
  test('on time, late, and no due date', () => {
    assert.equal(wasOnTime(fin[0]), true);
    assert.equal(wasOnTime(fin[1]), false);
    assert.equal(wasOnTime(fin[2]), true);
  });
  test('person and team stats', () => {
    const s = personStats({ id: 'a' }, open.filter((t) => t.statusCategory !== 'done'), fin, today, MON);
    assert.equal(s.open, 2); assert.equal(s.overdue, 1); assert.equal(s.onTrack, 1); assert.equal(s.inReview, 1);
    assert.equal(s.done, 2); assert.equal(s.onTimeRate, 0.5); assert.equal(s.rework, 1);
    const t = teamStats(open.filter((x) => x.statusCategory !== 'done'), fin, today, MON);
    assert.equal(t.done, 3); assert.equal(pct(t.onTimeRate), '67%'); assert.equal(pct(null), '–');
  });
  test('weekly buckets split on time and late', () => {
    const weeks = lastWeeks(2, today, 1);
    assert.equal(weeks[1].start, MON);
    const per = completedPerWeek(fin, weeks);
    assert.deepEqual([per[1].onTime, per[1].late, per[1].total], [2, 1, 3]);
    assert.equal(per[0].total, 0);
  });
  test('status breakdown keeps status order and drops empty ones', () => {
    const statuses = [{ id: 'pending', name: 'Pending', category: 'todo' }, { id: 'in_progress', name: 'In Progress', category: 'active' }, { id: 'completed', name: 'Completed', category: 'done' }];
    const rows = statusBreakdown(open.filter((t) => t.statusCategory !== 'done'), statuses);
    assert.deepEqual(rows.map((r) => [r.name, r.count]), [['Pending', 1], ['In Progress', 1], ['in_review', 1]]);
  });
});

describe('bundled Malaysian (Kuala Lumpur) holidays', () => {
  const all = MY_KL_YEARS.flatMap((y) => MY_KL_HOLIDAYS[y]);
  test('dates are valid, in the right year, in order, and not repeated', () => {
    for (const y of MY_KL_YEARS) {
      const list = MY_KL_HOLIDAYS[y];
      assert.ok(list.length >= 18, `${y} looks too short`);
      for (const i of list) assert.match(i.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(list.every((i) => i.date.startsWith(String(y))), `${y}: a date is in another year`);
      assert.deepEqual(list.map((i) => i.date), list.map((i) => i.date).sort(), `${y}: out of order`);
      const keys = list.map((i) => i.date + i.name);
      assert.equal(new Set(keys).size, keys.length, `${y}: duplicate entry`);
    }
  });
  test('names fit the 100 character limit and kinds are known', () => {
    for (const i of all) { assert.ok(i.name.length > 0 && i.name.length <= 100); assert.ok(['federal', 'kl', 'replacement'].includes(i.kind)); }
  });
  test('every replacement day follows a holiday that falls on a Sunday (or another replacement)', () => {
    const dates = new Set(all.map((i) => i.date));
    for (const r of all.filter((i) => i.kind === 'replacement')) {
      assert.notEqual(dow(r.date), 0, r.name + ' is on a Sunday');
      assert.notEqual(dow(r.date), 6, r.name + ' is on a Saturday');
      let back = addDays(r.date, -1);
      while (dates.has(back) && dow(back) !== 0) back = addDays(back, -1);
      assert.equal(dow(back), 0, `${r.name}: no Sunday holiday before it`);
    }
  });
  test('Federal Territory Day is on 1 February every year', () => {
    for (const y of MY_KL_YEARS) assert.ok(MY_KL_HOLIDAYS[y].some((i) => i.date === `${y}-02-01` && i.name === 'Federal Territory Day'));
  });
});

describe('report periods', () => {
  const T = '2026-11-03'; // a Tuesday
  test('this and last month', () => {
    const m = resolvePeriod('this_month', T);
    assert.deepEqual([m.from, m.to, m.asOf, m.inProgress], ['2026-11-01', '2026-11-30', T, true]);
    assert.deepEqual([m.prev.from, m.prev.to], ['2026-10-01', '2026-10-31']);
    const l = resolvePeriod('last_month', T);
    assert.deepEqual([l.from, l.to, l.asOf, l.inProgress, l.prev.from], ['2026-10-01', '2026-10-31', '2026-10-31', false, '2026-09-01']);
  });
  test('quarters (calendar year)', () => {
    const q = resolvePeriod('this_quarter', T);
    assert.deepEqual([q.from, q.to, q.name], ['2026-10-01', '2026-12-31', 'Q4 2026']);
    const l = resolvePeriod('last_quarter', T);
    assert.deepEqual([l.from, l.to, l.name, l.prev.from, l.prev.to], ['2026-07-01', '2026-09-30', 'Q3 2026', '2026-04-01', '2026-06-30']);
    const jan = resolvePeriod('last_quarter', '2026-01-15');
    assert.deepEqual([jan.from, jan.to, jan.name], ['2025-10-01', '2025-12-31', 'Q4 2025']);
  });
  test('years', () => {
    const y = resolvePeriod('this_year', T), l = resolvePeriod('last_year', T);
    assert.deepEqual([y.from, y.to, y.name, l.from, l.to, l.prev.from], ['2026-01-01', '2026-12-31', '2026', '2025-01-01', '2025-12-31', '2024-01-01']);
  });
  test('weeks start on Monday by default', () => {
    const w = resolvePeriod('this_week', T), l = resolvePeriod('last_week', T);
    assert.deepEqual([w.from, w.to, l.from, l.to], ['2026-11-02', '2026-11-08', '2026-10-26', '2026-11-01']);
  });
  test('custom dates: swapped dates are fixed and the previous period is as long', () => {
    const c = resolvePeriod('custom', T, { from: '2026-10-10', to: '2026-10-01' });
    assert.deepEqual([c.from, c.to, c.days, c.prev.from, c.prev.to], ['2026-10-01', '2026-10-10', 10, '2026-09-21', '2026-09-30']);
  });
  test('a financial year that starts in April', () => {
    appSettings.fiscalYearStartMonth = 4;
    try {
      const q = resolvePeriod('this_quarter', T), y = resolvePeriod('this_year', T), l = resolvePeriod('last_quarter', T);
      assert.deepEqual([q.from, q.to, q.name], ['2026-10-01', '2026-12-31', 'Q3 FY2027']);
      assert.deepEqual([y.from, y.to, y.name], ['2026-04-01', '2027-03-31', 'FY2027']);
      assert.deepEqual([l.from, l.to, l.name], ['2026-07-01', '2026-09-30', 'Q2 FY2027']);
    } finally { delete appSettings.fiscalYearStartMonth; }
  });
  test('chart buckets: days, weeks or months by length', () => {
    assert.equal(bucketsFor(resolvePeriod('this_week', T)).length, 7);
    const m = bucketsFor(resolvePeriod('last_month', T));
    assert.equal(m[0].start, '2026-10-01'); assert.equal(m.at(-1).end, '2026-10-31'); assert.ok(m.every((b) => b.unit === 'week'));
    assert.equal(bucketsFor(resolvePeriod('last_year', T)).length, 12);
    assert.equal(bucketsFor(resolvePeriod('last_quarter', T)).length, 14);
  });
  test('comparison text', () => {
    assert.deepEqual(compare(8, 5), { text: '+3 vs last period', tone: 'good' });
    assert.deepEqual(compare(2, 5, { lowerIsBetter: true }), { text: '−3 vs last period', tone: 'good' });
    assert.equal(compare(5, 5).tone, '');
    assert.equal(compare(5, null).text, 'no earlier figure');
  });
});

describe('report numbers', () => {
  const T = '2026-11-03';
  const period = resolvePeriod('last_month', T);                  // October 2026
  const people = [{ id: 'a', name: 'Ann', teamIds: ['t1'] }, { id: 'b', name: 'Bob', teamIds: ['t1'] }];
  const mk = (id, ownerId, over = {}) => ({ id, title: id, ownerId, teamId: 't1', projectId: 'p1', status: 'done', statusCategory: 'done', archived: false,
    createdAt: new Date('2026-10-01T09:00:00'), dueDate: null, completedDate: null, reworks: 0, ...over });
  const tasks = [
    mk('d1', 'a', { dueDate: '2026-10-10', completedDate: '2026-10-09' }),                       // on time
    mk('d2', 'a', { dueDate: '2026-10-10', completedDate: '2026-10-12', reworks: 1 }),           // late
    mk('d3', 'b', { completedDate: '2026-10-20', createdAt: new Date('2026-10-10T09:00:00') }),  // no due date: on time
    mk('d4', 'b', { completedDate: '2026-09-15', createdAt: new Date('2026-09-01T09:00:00') }),  // previous period
    mk('o1', 'a', { status: 'in_progress', statusCategory: 'active', dueDate: '2026-10-30', createdAt: new Date('2026-10-25T09:00:00') }), // overdue today
    mk('o2', 'b', { status: 'pending', statusCategory: 'todo', dueDate: '2026-12-01', createdAt: new Date('2026-08-01T09:00:00') }),
    mk('x1', 'zz', { completedDate: '2026-10-05' })                                                // not in scope
  ];
  const leaves = [
    { id: 'l1', userId: 'a', teamId: 't1', type: 'annual', startDate: '2026-10-28', endDate: '2026-11-03', half: 'full', status: 'approved' }, // Oct 28 to Nov 3, clipped to Oct 28-30 and 31 is Sat
    { id: 'l2', userId: 'b', teamId: 't1', type: 'sick', startDate: '2026-10-06', endDate: '2026-10-06', half: 'am', status: 'approved' },
    { id: 'l3', userId: 'b', teamId: 't1', type: 'annual', startDate: '2026-10-07', endDate: '2026-10-07', half: 'full', status: 'pending' }
  ];
  const holidays = [{ date: '2026-10-29', name: 'Test holiday', teamId: null, active: true }];
  const model = compileReport({ period, tasks, people, leaves, holidays, today: T, projects: [{ id: 'p1', name: 'Proj' }], teamIds: ['t1'] });

  test('headline figures', () => {
    const h = model.headline;
    assert.equal(h.completed, 3); assert.equal(h.completedPrev, 1);
    assert.equal(h.late, 1); assert.equal(Math.round(h.onTimeRate * 100), 67);
    assert.equal(h.created, 4); // d1, d2, o1, d3
    assert.equal(h.rework, 1);
    assert.equal(h.openNow, 2); assert.equal(h.overdueNow, 1);
    assert.equal(h.avgDays, (8 + 11 + 10) / 3);
  });
  test('leave counts approved working days inside the period only', () => {
    // Ann: 28, 29 (holiday, not counted), 30 -> 2 days. Bob: half-day sick = 0.5. Pending leave is ignored.
    assert.equal(model.headline.leaveDays, 2.5);
    const ann = model.people.find((p) => p.person.id === 'a');
    assert.equal(ann.leaveDays, 2); assert.equal(model.people.find((p) => p.person.id === 'b').leaveByType.sick, 0.5);
  });
  test('people and projects', () => {
    const ann = model.people.find((p) => p.person.id === 'a');
    assert.deepEqual([ann.done, ann.late, ann.rework, ann.openNow, ann.overdueNow], [2, 1, 1, 1, 1]);
    assert.deepEqual(model.projects.map((p) => [p.name, p.done, p.openNow, p.overdueNow]), [['Proj', 3, 2, 1]]);
  });
  test('lists are sorted and only hold what belongs', () => {
    assert.deepEqual(model.completed.map((t) => t.id), ['d1', 'd2', 'd3']);
    assert.deepEqual(model.open.map((t) => t.id), ['o1', 'o2']);
    assert.deepEqual(model.holidays.map((x) => x.name), ['Test holiday']);
  });
  test('weekly buckets add up to the totals', () => {
    assert.equal(model.buckets.reduce((n, b) => n + b.total, 0), 3);
    assert.equal(model.buckets.reduce((n, b) => n + b.created, 0), 4);
    assert.equal(model.busiest.total, 1);
  });
  test('a person with nothing yet does not break the numbers', () => {
    const empty = compileReport({ period, tasks: [], people, leaves: [], holidays: [], today: T });
    assert.equal(empty.headline.completed, 0); assert.equal(empty.headline.onTimeRate, null); assert.equal(empty.headline.avgDays, null);
    assert.equal(empty.busiest, null);
  });
  test('the Excel workbook builds with every sheet', () => {
    const sheets = reportSheets(model, { user: (id) => id, team: (id) => id, status: (id) => id, project: (id) => id, today: T, scope: 'Test', by: 'Tester' });
    assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'People', 'Projects', 'Over time', 'Completed', 'Open today', 'Leave', 'Holidays']);
    const bytes = buildXlsx(sheets);
    assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
    assert.ok(bytes.length > 2000);
  });
});

describe('project owners', () => {
  const statuses = [
    { id: 'pending', category: 'todo' }, { id: 'in_review', category: 'review' },
    { id: 'rework', category: 'active' }, { id: 'completed', category: 'done' }
  ];
  // Pat is a plain member of team A who owns project P; Sam (team B) holds tasks in P.
  const pat = { id: 'pat', role: 'member', teamIds: ['A'], ownedProjectIds: ['P'] };
  const task = (over = {}) => ({ id: 't', title: 'x', teamId: 'B', projectId: 'P', ownerId: 'sam', createdBy: 'lee', statusCategory: 'in_progress', status: 'in_progress', ...over });

  test('an owner sees every task in the project, even in another team', () => {
    assert.equal(perm.canViewTask(pat, task()), true);
    assert.equal(perm.canViewTask(pat, task({ projectId: 'Q' })), false);
  });
  test('a person sees tasks they handed to someone else', () => {
    assert.equal(perm.canViewTask({ id: 'lee', role: 'leader', teamIds: ['A'] }, task({ projectId: null })), true);
  });
  test('an owner can reassign but not edit details or deadlines', () => {
    assert.equal(perm.canReassign(pat, task()), true);
    assert.equal(perm.canEditDetails(pat, task()), false);
    assert.equal(perm.canChangeDeadline(pat, task()), false);
    assert.equal(perm.canArchive(pat, task()), false);
    assert.equal(perm.canEditAnything(pat, task(), statuses, null), true);
  });
  test('an owner approves or returns only work that is in Review', () => {
    assert.deepEqual(perm.allowedStatuses(pat, task({ statusCategory: 'active' }), statuses, null), []);
    assert.equal(perm.allowedStatuses(pat, task({ statusCategory: 'review', status: 'in_review' }), statuses, null).some((s) => s.id === 'completed'), true);
  });
  test('an owner cannot approve their own task', () => {
    const own = task({ ownerId: 'pat', teamId: 'A', statusCategory: 'review', status: 'in_review' });
    assert.equal(perm.allowedStatuses(pat, own, statuses, { approvalGate: true }).some((s) => s.category === 'done'), false);
    assert.equal(perm.canReassign(pat, own), false);
  });
  test('someone who owns nothing gets no extra reach', () => {
    const sam2 = { id: 'x', role: 'member', teamIds: ['A'] };
    assert.equal(perm.canReassign(sam2, task()), false);
    assert.equal(perm.canViewTask(sam2, task()), false);
    assert.equal(perm.canSeeProjects(sam2), false);
    assert.equal(perm.canSeeReports(sam2), false);
  });
  test('reports and the projects page open for owners', () => {
    assert.equal(perm.canSeeReports(pat), true);
    assert.equal(perm.canSeeTeamReports(pat), false);
    assert.equal(perm.canSeeProjects(pat), true);
  });
  test('a project report spans teams and leaves out leave', () => {
    const T = '2026-11-03';
    const period = resolvePeriod('this_month', T);
    const tasks = [
      { id: '1', ownerId: 'sam', teamId: 'B', projectId: 'P', statusCategory: 'done', completedDate: '2026-11-02', dueDate: '2026-11-05', createdAt: new Date('2026-10-30'), reworks: 0, archived: false, title: 'a', status: 'completed' },
      { id: '2', ownerId: 'amy', teamId: 'A', projectId: 'P', statusCategory: 'active', dueDate: '2026-11-01', createdAt: new Date('2026-11-01'), reworks: 0, archived: false, title: 'b', status: 'in_progress' }
    ];
    const people2 = [{ id: 'sam', name: 'Sam', teamIds: ['B'] }, { id: 'amy', name: 'Amy', teamIds: ['A'] }];
    const model = compileReport({ period, tasks, people: people2, leaves: [], holidays: [], today: T, projects: [{ id: 'P', name: 'Proj' }] });
    model.scopeKind = 'project'; model.peopleInvolved = 2;
    assert.equal(model.headline.completed, 1); assert.equal(model.headline.overdueNow, 1);
    const names = reportSheets(model, { user: (i) => i, team: (i) => i, status: (i) => i, project: (i) => i, today: T, scope: 'Project: Proj', by: 'Pat' }).map((s) => s.name);
    assert.deepEqual(names, ['Summary', 'People', 'Projects', 'Over time', 'Completed', 'Open today']);
  });
});

describe('colour themes and passwords', () => {
  test('theme list, css and security rules name the same themes', async () => {
    const { THEMES, isTheme } = await import('../js/core/theme.js');
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../css/themes.css', import.meta.url), 'utf8');
    const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
    const ids = THEMES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      if (id !== 'auto') assert.ok(css.includes(`:root[data-theme="${id}"]`), `css missing ${id}`);
      assert.ok(rules.includes(`'${id}'`), `rules missing ${id}`);
    }
    for (const m of css.matchAll(/:root\[data-theme="(\w+)"\]/g)) assert.ok(ids.includes(m[1]), `unlisted css theme ${m[1]}`);
    assert.equal(isTheme('neon'), false);
    assert.equal(isTheme(undefined), false);
  });
  test('every theme sets every colour it needs', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../css/themes.css', import.meta.url), 'utf8');
    const blocks = css.split(/\n(?=\/\* \w+:)/).slice(1);
    assert.equal(blocks.length, 9);
    for (const b of blocks) {
      for (const v of ['--bg', '--surface', '--surface-2', '--text', '--muted', '--border', '--accent', '--accent-soft', '--accent-ink',
        '--danger', '--good', '--warn', '--viz-1', '--viz-2', '--viz-3', '--cal-off', 'color-scheme']) {
        assert.ok(b.includes(v + ':'), `${b.split('\n')[0]} lacks ${v}`);
      }
    }
  });
  test('new password rules', async () => {
    const { validateNewPassword } = await import('../js/core/store.js');
    assert.match(validateNewPassword('', 'Abcdefg1', 'Abcdefg1'), /current password/);
    assert.match(validateNewPassword('old', 'Abc1', 'Abc1'), /at least 8/);
    assert.match(validateNewPassword('old', 'abcdefghij', 'abcdefghij'), /number/);
    assert.match(validateNewPassword('Abcdefg1', 'Abcdefg1', 'Abcdefg1'), /different/);
    assert.match(validateNewPassword('old', 'Abcdefg1', 'Abcdefg2'), /do not match/);
    assert.equal(validateNewPassword('old', 'Abcdefg1', 'Abcdefg1'), null);
  });
});

// ------------------------------------------------------------ superuser and steps

import { deriveStepFields, cleanSteps, dropOutsiders, stepsForUser, hasSteps } from '../js/core/steps.js';
import { roleLabel } from '../js/core/model.js';

describe('superuser', () => {
  const su = { id: 'su', role: 'leader', teamIds: ['t1'], superuser: true };
  const leader = { id: 'l', role: 'leader', teamIds: ['t1'] };
  const falseSu = { id: 'f', role: 'leader', teamIds: ['t1'], superuser: false };
  const taskB = { id: 'x', teamId: 't2', ownerId: 'someone', createdBy: 'z', status: 'pending', statusCategory: 'todo' };

  test('a Superuser has Director powers, whatever the role', () => {
    assert.equal(perm.isDirector(su), true);
    assert.equal(perm.isLeaderUp(su), true);
    assert.equal(perm.canManageUsers(su), true);
    assert.equal(perm.canViewTask(su, taskB), true);
    assert.equal(perm.canEditDetails(su, taskB), true);
    assert.equal(perm.canChangeDeadline(su, taskB), true);
    assert.equal(perm.canArchive(su, taskB), true);
    assert.equal(perm.visibleTeams(su, [{ id: 't1' }, { id: 't2' }]).length, 2);
  });
  test('an ordinary Team Leader is unchanged', () => {
    for (const u of [leader, falseSu]) {
      assert.equal(perm.isDirector(u), false);
      assert.equal(perm.canManageUsers(u), false);
      assert.equal(perm.canViewTask(u, taskB), false);
      assert.equal(perm.canEditDetails(u, taskB), false);
      assert.equal(perm.visibleTeams(u, [{ id: 't1' }, { id: 't2' }]).length, 1);
    }
  });
  test('only a real flag counts', () => {
    assert.equal(perm.isSuperuser({ role: 'member', superuser: 'true' }), false);
    assert.equal(perm.isSuperuser({ role: 'member', superuser: 1 }), false);
    assert.equal(perm.isDirector({ role: 'member', superuser: true }), true);
    assert.equal(perm.isMember({ role: 'member', superuser: true }), false);
  });
  test('the role label tells you', () => {
    assert.equal(roleLabel(su), 'Team Leader · Superuser');
    assert.equal(roleLabel(leader), 'Team Leader');
    assert.equal(roleLabel({ role: 'director' }), 'Director');
  });
});

describe('checklist steps given to people', () => {
  const steps = [
    { id: '1', text: 'a', done: false, assigneeId: 'u1' },
    { id: '2', text: 'b', done: false, forTeam: true },
    { id: '3', text: 'c', done: true, assigneeId: 'u1', doneBy: 'u1', doneAt: '2026-11-03T01:00:00Z' },
    { id: '4', text: 'd', done: false }
  ];
  const task = { id: 't', teamId: 't1', ownerId: 'o', statusCategory: 'active', checklist: steps };

  test('summary fields for the rules', () => {
    assert.deepEqual(deriveStepFields(steps), { checklistAssignees: ['u1'], checklistForTeam: true });
    assert.deepEqual(deriveStepFields([{ id: '1', text: 'x', done: false }]), { checklistAssignees: [], checklistForTeam: false });
    assert.deepEqual(deriveStepFields(undefined), { checklistAssignees: [], checklistForTeam: false });
  });
  test('cleanSteps keeps only valid keys and never leaves undefined', () => {
    const out = cleanSteps([
      { id: '1', text: 'x'.repeat(300), done: false, assigneeId: '', forTeam: false, doneBy: 'zz', extra: 1 },
      { id: '2', text: 'y', done: true, forTeam: true, assigneeId: 'u9', doneBy: 'u9', doneAt: 't' }
    ]);
    assert.equal(out[0].text.length, 200);
    assert.deepEqual(Object.keys(out[0]), ['id', 'text', 'done']);
    assert.deepEqual(out[1], { id: '2', text: 'y', done: true, assigneeId: 'u9', doneBy: 'u9', doneAt: 't' }); // a person wins over "team"
    assert.ok(!JSON.stringify(out).includes('undefined'));
  });
  test('key order never counts as a change', () => {
    const stored = [{ done: false, id: '1', text: 'a', assigneeId: 'u1' }];
    assert.equal(JSON.stringify(cleanSteps(stored)), JSON.stringify(cleanSteps(cleanSteps(stored))));
  });
  test('moving a task to another team drops helpers who are not in it', () => {
    const teams = { u1: ['t1'], u2: ['t2'] };
    const r = dropOutsiders([{ id: '1', text: 'a', done: false, assigneeId: 'u1' }, { id: '2', text: 'b', done: false, assigneeId: 'u2' }, { id: '3', text: 'c', done: false, forTeam: true }], 't2', (id) => teams[id] || []);
    assert.equal(r.dropped, 1);
    assert.equal(r.steps[0].assigneeId, undefined);
    assert.equal(r.steps[1].assigneeId, 'u2');
    assert.equal(r.steps[2].forTeam, true);
  });
  test('steps still waiting for a person', () => {
    assert.deepEqual(stepsForUser(task, { id: 'u1', teamIds: ['t1'] }).map((s) => s.id), ['1', '2']);   // 3 is done
    assert.deepEqual(stepsForUser(task, { id: 'u2', teamIds: ['t1'] }).map((s) => s.id), ['2']);        // team step only
    assert.deepEqual(stepsForUser(task, { id: 'u3', teamIds: ['t9'] }), []);                              // other team: nothing
    assert.equal(hasSteps(task), true);
    assert.equal(hasSteps({ checklist: [{ id: '1', text: 'x', done: false }] }), false);
  });
  test('who may tick what', () => {
    const helper = { id: 'u1', role: 'member', teamIds: ['t1'] };
    const mate = { id: 'u2', role: 'member', teamIds: ['t1'] };
    const stranger = { id: 'u9', role: 'member', teamIds: ['t2'] };
    assert.equal(perm.canTickItem(helper, task, steps[0]), true);
    assert.equal(perm.canTickItem(helper, task, steps[3]), false);   // not given to them
    assert.equal(perm.canTickItem(mate, task, steps[1]), true);      // whole-team step
    assert.equal(perm.canTickItem(mate, task, steps[0]), false);
    assert.equal(perm.canTickItem(stranger, task, steps[1]), false); // other team
    assert.equal(perm.canTickChecklist(mate, task), true);
    assert.equal(perm.canTickChecklist(stranger, task), false);
    assert.equal(perm.canEditAnything(mate, task, [], null), true);  // Save appears for a helper
    // the owner and leaders can tick any step; a finished task locks the helpers
    assert.equal(perm.canTickItem({ id: 'o', role: 'member', teamIds: ['t1'] }, task, steps[3]), true);
    assert.equal(perm.canTickItem({ id: 'l', role: 'leader', teamIds: ['t1'] }, task, steps[3]), true);
    assert.equal(perm.canTickItem(helper, { ...task, statusCategory: 'done' }, steps[0]), false);
  });
  test('steps are given out by people who can edit details', () => {
    assert.equal(perm.canAssignSteps({ id: 'a', role: 'asst_leader', teamIds: ['t1'] }, task), true);
    assert.equal(perm.canAssignSteps({ id: 'u1', role: 'member', teamIds: ['t1'] }, task), false);
    assert.equal(perm.canAssignSteps({ id: 'x', role: 'leader', teamIds: ['t2'] }, task), false);
  });
});

// ------------------------------------------------------- HR, entitlements, approval steps

import { entitlementFor, groupLeaves, daysInYear, personBalance, balances, parseDays, buildPolicy, dayText } from '../js/core/entitlement.js';
import { ENTITLED_TYPES, LEAVE_STATUS_LABEL, LEAVE_TYPE_LABEL } from '../js/core/model.js';

describe('leave approval in two steps', () => {
  const member = { id: 'm', role: 'member', teamIds: ['t1'] };
  const leader = { id: 'l', role: 'leader', teamIds: ['t1'] };
  const otherLeader = { id: 'l2', role: 'leader', teamIds: ['t2'] };
  const director = { id: 'd', role: 'director', teamIds: [] };
  const hr = { id: 'h', role: 'member', teamIds: ['t3'], hr: true };
  const leave = (status, over = {}) => ({ id: 'x', userId: 'm', teamId: 't1', status, ...over });

  test('step 1 is the Team Leader of the team, step 2 only the Director', () => {
    assert.equal(perm.canApproveLeave(leader, leave('pending')), true);
    assert.equal(perm.canApproveLeave(otherLeader, leave('pending')), false);
    assert.equal(perm.canApproveLeave(member, leave('pending')), false);
    assert.equal(perm.canApproveLeave(leader, leave('leader_ok')), false);      // a Team Leader cannot give the final approval
    assert.equal(perm.canApproveLeave(director, leave('leader_ok')), true);
    assert.equal(perm.canApproveLeave({ ...leader, superuser: true }, leave('leader_ok')), true);
  });
  test('nothing is decided twice, and nobody approves their own request (except the Director)', () => {
    for (const st of ['approved', 'declined', 'cancelled']) assert.equal(perm.canApproveLeave(director, leave(st)), false);
    assert.equal(perm.canApproveLeave(leader, leave('pending', { userId: 'l' })), false);
    assert.equal(perm.canApproveLeave(director, leave('pending', { userId: 'd' })), true);
  });
  test('HR does not approve, cannot cancel, and is not made a Director by the switch', () => {
    assert.equal(perm.canApproveLeave(hr, leave('pending')), false);
    assert.equal(perm.canApproveLeave(hr, leave('leader_ok')), false);
    assert.equal(perm.canCancelLeave(hr, leave('approved')), false);
    assert.equal(perm.isDirector(hr), false);
    assert.equal(perm.isLeaderUp(hr), false);
  });
  test('a request waiting on someone counts as waiting; the person can cancel it', () => {
    assert.equal(perm.isPendingLeave(leave('pending')), true);
    assert.equal(perm.isPendingLeave(leave('leader_ok')), true);
    assert.equal(perm.isPendingLeave(leave('approved')), false);
    assert.equal(perm.canCancelLeave(member, leave('leader_ok')), true);
    assert.equal(perm.leaveStep(leave('pending')), 'leader');
    assert.equal(perm.leaveStep(leave('leader_ok')), 'director');
    assert.equal(perm.leaveStep(leave('approved')), null);
  });
  test('Director and Superuser do not get HR powers; only the HR switch does', () => {
    for (const u of [director, { id: 's', role: 'leader', teamIds: ['t1'], superuser: true }, leader]) {
      assert.equal(perm.canSeeHr(u), false);
      assert.equal(perm.canSetEntitlements(u), false);
      assert.equal(perm.canAcknowledgeLeave(u, leave('approved')), false);
    }
    assert.equal(perm.canSeeHr(hr), true);
    assert.equal(perm.canSetEntitlements(hr), true);
    assert.equal(perm.canAcknowledgeLeave(hr, leave('approved')), true);
    assert.equal(perm.canAcknowledgeLeave(hr, leave('approved', { hrAckBy: 'h' })), false);   // only once
    assert.equal(perm.canAcknowledgeLeave(hr, leave('pending')), false);                       // only approved leave
    assert.equal(perm.isHr({ hr: 'true' }), false);
  });
  test('labels', () => {
    assert.match(LEAVE_STATUS_LABEL.leader_ok, /Director/);
    assert.equal(LEAVE_TYPE_LABEL.sick, 'Medical leave');
    assert.deepEqual(ENTITLED_TYPES, ['annual', 'sick', 'hospitalization', 'compassionate', 'marriage']);
    assert.equal(roleLabel({ role: 'leader', hr: true }), 'Team Leader · HR');
  });
});

describe('leave entitlements and balances', () => {
  const policy = { year: '2026', days: { annual: 14, sick: 14, marriage: 3 }, overrides: { b: { annual: 18 } } };
  const A = { id: 'a', name: 'Aa', teamIds: ['t1'] }, B = { id: 'b', name: 'Bb', teamIds: ['t1'] };
  const lv = (id, userId, type, startDate, endDate, status, over = {}) =>
    ({ id, userId, userName: userId, teamId: 't1', type, startDate, endDate, half: 'full', status, ...over });

  test('an exception beats the company number; unset kinds are not tracked', () => {
    assert.equal(entitlementFor(policy, 'a', 'annual'), 14);
    assert.equal(entitlementFor(policy, 'b', 'annual'), 18);
    assert.equal(entitlementFor(policy, 'b', 'sick'), 14);          // exception only changes annual
    assert.equal(entitlementFor(policy, 'a', 'compassionate'), null);
    assert.equal(entitlementFor(policy, 'a', 'training'), null);    // never counted
    assert.equal(entitlementFor(null, 'a', 'annual'), null);
    assert.equal(entitlementFor({ days: { annual: 0 } }, 'a', 'annual'), 0);   // zero is a real number
  });
  test('copies of one request in two teams count once', () => {
    const g = groupLeaves([lv('1', 'a', 'annual', '2026-03-02', '2026-03-03', 'approved'), lv('2', 'a', 'annual', '2026-03-02', '2026-03-03', 'approved', { teamId: 't2' })]);
    assert.equal(g.length, 1);
    assert.equal(g[0].status, 'approved');
    assert.equal(g[0].docs.length, 2);
    const half = groupLeaves([lv('1', 'a', 'annual', '2026-03-02', '2026-03-03', 'approved'), lv('2', 'a', 'annual', '2026-03-02', '2026-03-03', 'leader_ok', { teamId: 't2' })]);
    assert.equal(half[0].status, 'pending');                          // one team has not finished approving
    const dead = groupLeaves([lv('1', 'a', 'annual', '2026-03-02', '2026-03-03', 'declined')]);
    assert.equal(dead[0].status, 'ignore');
  });
  test('taken, waiting and left; weekends and holidays are not used', () => {
    // 2026-03-02 is a Monday.
    const leaves = [
      lv('1', 'a', 'annual', '2026-03-02', '2026-03-06', 'approved'),       // 5 working days taken
      lv('2', 'a', 'annual', '2026-04-06', '2026-04-07', 'leader_ok'),      // 2 waiting
      lv('3', 'a', 'annual', '2026-05-04', '2026-05-04', 'declined'),       // ignored
      lv('4', 'a', 'sick', '2026-06-01', '2026-06-01', 'approved', { half: 'am' })   // half a day
    ];
    const b = personBalance({ person: A, groups: groupLeaves(leaves), policy, holidays: [], year: 2026 });
    assert.deepEqual(b.annual, { entitled: 14, used: 5, pending: 2, left: 7 });
    assert.deepEqual(b.sick, { entitled: 14, used: 0.5, pending: 0, left: 13.5 });
    assert.deepEqual(b.compassionate, { entitled: null, used: 0, pending: 0, left: null });
    const withHoliday = personBalance({ person: A, groups: groupLeaves(leaves), policy, holidays: [{ date: '2026-03-04', name: 'H', teamId: null, active: true }], year: 2026 });
    assert.equal(withHoliday.annual.used, 4);
  });
  test('a leave over New Year only counts the days inside the year', () => {
    // Thu 2026-12-31 and Fri 2027-01-01: one working day in each year.
    const g = groupLeaves([lv('1', 'a', 'annual', '2026-12-31', '2027-01-04', 'approved')]);
    assert.equal(daysInYear(g[0], A, [], 2026), 1);
    assert.equal(daysInYear(g[0], A, [], 2027), 2);   // Fri 1 Jan and Mon 4 Jan
  });
  test('one table for everyone', () => {
    const rows = balances({ people: [A, B], leaves: [lv('1', 'b', 'annual', '2026-03-02', '2026-03-02', 'approved')], policy, holidays: [], year: 2026 });
    assert.equal(rows[0].byType.annual.left, 14);
    assert.equal(rows[1].byType.annual.entitled, 18);
    assert.equal(rows[1].byType.annual.left, 17);
  });
  test('what HR types is checked', () => {
    assert.deepEqual(parseDays('14'), { ok: true, value: 14 });
    assert.deepEqual(parseDays(' 7.5 '), { ok: true, value: 7.5 });
    assert.deepEqual(parseDays(''), { ok: true, value: null });
    for (const bad of ['-1', '367', 'abc', '1.3', '1e9', 'NaN']) assert.equal(parseDays(bad).ok, false, bad);
    assert.equal(dayText(null), '–');
    assert.equal(dayText(7.5), '7.5');
  });
  test('the saved document holds only numbers that were set', () => {
    const doc = buildPolicy(2026, { annual: 14, sick: undefined, marriage: 3 }, { u1: { annual: 20, sick: undefined }, u2: {} });
    assert.deepEqual(doc, { year: '2026', days: { annual: 14, marriage: 3 }, overrides: { u1: { annual: 20 } } });
  });
});

// ------------------------------------------------------------------ task extras
import { nextOccurrence, dueOccurrence, occurrenceTaskId, dueDateFor } from '../js/core/recurrence.js';
import { cleanTag, cleanTags, tagCounts } from '../js/core/tags.js';
import { openBlockers, wouldLoop } from '../js/core/deps.js';
import { missingForNew, requiredHints, availabilityWarnings, DEFAULT_TASK_RULES } from '../js/core/taskrules.js';
import { computeAlerts } from '../js/core/alerts.js';

describe('recurring tasks', () => {
  test('weekly and fortnightly steps', () => {
    assert.equal(nextOccurrence('2026-11-02', 'weekly'), '2026-11-09');
    assert.equal(nextOccurrence('2026-12-28', 'fortnightly'), '2027-01-11');
    assert.equal(nextOccurrence('2026-11-02', 'none'), null);
  });
  test('monthly keeps the day of the month and uses the last day of short months', () => {
    assert.equal(nextOccurrence('2026-01-31', 'monthly', 31), '2026-02-28');
    assert.equal(nextOccurrence('2026-02-28', 'monthly', 31), '2026-03-31');
    assert.equal(nextOccurrence('2028-01-31', 'monthly', 31), '2028-02-29');
    assert.equal(nextOccurrence('2026-11-15', 'quarterly'), '2027-02-15');
    assert.equal(nextOccurrence('2028-02-29', 'yearly', 29), '2029-02-28');
    assert.equal(nextOccurrence('2026-12-15', 'monthly'), '2027-01-15');
  });
  test('nothing is due before its date, or when paused or manual', () => {
    const t = { repeat: 'weekly', nextDate: '2026-11-10', active: true };
    assert.equal(dueOccurrence(t, '2026-11-09'), null);
    assert.equal(dueOccurrence({ ...t, active: false }, '2026-11-20'), null);
    assert.equal(dueOccurrence({ ...t, repeat: 'none' }, '2026-11-20'), null);
    assert.equal(dueOccurrence({ ...t, nextDate: null }, '2026-11-20'), null);
  });
  test('due on the day: one task and the next date moves on', () => {
    assert.deepEqual(dueOccurrence({ repeat: 'weekly', nextDate: '2026-11-10', active: true }, '2026-11-10'),
      { date: '2026-11-10', next: '2026-11-17', skipped: 0 });
  });
  test('after a long gap only the latest occurrence is made', () => {
    const r = dueOccurrence({ repeat: 'weekly', nextDate: '2026-10-01', active: true }, '2026-11-12');
    assert.deepEqual(r, { date: '2026-11-12', next: '2026-11-19', skipped: 6 });
    const m = dueOccurrence({ repeat: 'monthly', nextDate: '2026-01-31', anchorDay: 31, active: true }, '2026-11-03');
    assert.equal(m.date, '2026-10-31');
    assert.equal(m.next, '2026-11-30');
  });
  test('task ids are fixed so a second attempt cannot make a duplicate', () => {
    assert.equal(occurrenceTaskId('tpl1', '2026-11-10', 'mei'), 'rec-tpl1-2026-11-10-mei');
    assert.equal(occurrenceTaskId('tpl1', '2026-11-10', 'mei'), occurrenceTaskId('tpl1', '2026-11-10', 'mei'));
  });
  test('due date is counted from the day the task is made', () => {
    assert.equal(dueDateFor({ dueInDays: 5 }, '2026-11-10'), '2026-11-15');
    assert.equal(dueDateFor({ dueInDays: 0 }, '2026-11-10'), '2026-11-10');
    assert.equal(dueDateFor({ dueInDays: null }, '2026-11-10'), null);
    assert.equal(dueDateFor({}, '2026-11-10'), null);
  });
});

describe('tags', () => {
  test('a tag is lower case, short, with no hash or spaces', () => {
    assert.equal(cleanTag('#Admissions'), 'admissions');
    assert.equal(cleanTag('  Open Day! '), 'open-day');
    assert.equal(cleanTag('x'.repeat(40)).length, 24);
    assert.equal(cleanTag('###'), '');
  });
  test('duplicates go, at most 8 stay', () => {
    assert.deepEqual(cleanTags(['A', 'a', '#a', 'b']), ['a', 'b']);
    assert.equal(cleanTags(Array.from({ length: 12 }, (_, i) => 't' + i)).length, 8);
    assert.deepEqual(cleanTags(undefined), []);
  });
  test('counts are most used first', () => {
    assert.deepEqual(tagCounts([{ tags: ['a', 'b'] }, { tags: ['b'] }, {}]), [['b', 2], ['a', 1]]);
  });
});

describe('waiting for other tasks', () => {
  const tasks = { a: { id: 'a', blockedBy: ['b'], statusCategory: 'todo' }, b: { id: 'b', blockedBy: ['c'], statusCategory: 'active' }, c: { id: 'c', statusCategory: 'done' }, d: { id: 'd', statusCategory: 'todo', archived: true } };
  const look = (id) => tasks[id] || null;
  test('only unfinished blockers count; unknown ones are reported', () => {
    assert.deepEqual(openBlockers({ blockedBy: ['b', 'c', 'd', 'zzz'] }, look).open.map((t) => t.id), ['b']);
    assert.equal(openBlockers({ blockedBy: ['b', 'zzz'] }, look).unknown, 1);
    assert.deepEqual(openBlockers({}, look), { open: [], unknown: 0 });
  });
  test('loops are caught, also through a chain', () => {
    assert.equal(wouldLoop('c', 'a', look), true);   // a -> b -> c, so c cannot wait for a
    assert.equal(wouldLoop('a', 'c', look), false);
    assert.equal(wouldLoop('b', 'b', look), true);
    assert.equal(wouldLoop(null, 'a', look), false);
  });
});

describe('what a new task must have', () => {
  test('the default is a due date and nothing else', () => {
    assert.equal(DEFAULT_TASK_RULES.requireDueDate, true);
    assert.deepEqual(missingForNew({ title: 'x', priority: 'urgent' }), ['Please set a due date.']);
    assert.deepEqual(missingForNew({ title: 'x', priority: 'low', dueDate: '2026-11-10' }), []);
  });
  test('estimate can be needed for every task or from a priority up', () => {
    const base = { dueDate: '2026-11-10', priority: 'medium' };
    assert.deepEqual(missingForNew(base, { requireEstimate: true }), ['Please give an estimate in hours.']);
    assert.deepEqual(missingForNew(base, { requireEstimateFrom: 'high' }), []);
    assert.equal(missingForNew({ ...base, priority: 'high' }, { requireEstimateFrom: 'high' }).length, 1);
    assert.equal(missingForNew({ ...base, priority: 'high', estimateHours: 0 }, { requireEstimateFrom: 'high' }).length, 0);
  });
  test('project and description', () => {
    assert.equal(missingForNew({ dueDate: 'x', projectId: '' }, { requireProject: true }).length, 1);
    assert.equal(missingForNew({ dueDate: 'x', description: '  ' }, { requireDescription: true }).length, 1);
    assert.deepEqual(requiredHints({ priority: 'urgent' }, { requireDueDate: true, requireEstimateFrom: 'high' }),
      { dueDate: true, estimate: true, project: false, description: false });
  });
});

describe('warnings for the due date', () => {
  const mei = { id: 'mei', name: 'Mei Ling', teamIds: ['t1'] };
  const raj = { id: 'raj', name: 'Raj Singh', teamIds: ['t1'] };
  const data = { leaves: [leave('mei', WED, WED), leave('raj', WED, WED, { half: 'am' }), leave('mei', TUE, TUE, { status: 'pending' })], holidays: [{ name: 'Founders Day', date: NEXT_MON, teamId: null, active: true }] };
  const OK = (iso) => iso; // dates in the test are in the future of "today" only if today is earlier; make them safe:
  test('leave, half-day leave, weekend and holiday are named; the leave type never is', () => {
    const far = (iso) => addDays(iso, 4004);                       // 4004 = 572 weeks: keeps the weekday, puts every date in the future
    const farData = {
      leaves: data.leaves.map((l) => ({ ...l, startDate: far(l.startDate), endDate: far(l.endDate) })),
      holidays: data.holidays.map((h) => ({ ...h, date: far(h.date) }))
    };
    assert.match(availabilityWarnings([mei, raj], far(WED), farData).join(' '), /Mei Ling is on leave/);
    assert.match(availabilityWarnings([mei, raj], far(WED), farData).join(' '), /Raj Singh is on half-day leave/);
    assert.deepEqual(availabilityWarnings([mei], far(TUE), farData), []);                  // pending leave does not count
    assert.match(availabilityWarnings([mei], far(SAT), farData)[0], /weekend/);
    assert.match(availabilityWarnings([mei, raj], far(NEXT_MON), farData)[0], /Founders Day/);
    assert.equal(availabilityWarnings([mei, raj], far(NEXT_MON), farData).length, 1);      // one holiday line for everybody
    assert.ok(!/annual/i.test(availabilityWarnings([mei], far(WED), farData).join(' ')));
    assert.deepEqual(availabilityWarnings([mei], '', farData), []);
    assert.deepEqual(availabilityWarnings([mei], '2020-01-01', farData), []);              // dates in the past are not checked
    assert.ok(OK(MON));
  });
});

describe('alerts', () => {
  const me = { id: 'me' };
  const at = (d) => new Date(d);
  const task = (id, over = {}) => ({ id, ownerId: 'me', statusCategory: 'todo', archived: false, createdBy: 'boss', createdAt: at('2026-11-03T08:00:00Z'), dueDate: null, ...over });
  const seenAt = at('2026-11-03T09:00:00Z').getTime();
  const today = '2026-11-10';
  test('given to you after you last looked', () => {
    const r = computeAlerts([task('new', { assignedBy: 'boss', assignedAt: at('2026-11-03T10:00:00Z') }), task('old'), task('mine', { createdBy: 'me', createdAt: at('2026-11-03T11:00:00Z') })], me, { seenAt, today });
    assert.deepEqual(r.assigned.map((t) => t.id), ['new']);
    assert.equal(r.count, 1);
  });
  test('a task handed over later counts again', () => {
    const t = task('re', { createdAt: at('2026-10-01T00:00:00Z'), assignedBy: 'lead', assignedAt: at('2026-11-04T00:00:00Z') });
    assert.equal(computeAlerts([t], me, { seenAt, today }).assigned.length, 1);
  });
  test('overdue and due within two days', () => {
    const r = computeAlerts([task('o', { dueDate: '2026-11-09' }), task('t', { dueDate: '2026-11-10' }), task('s', { dueDate: '2026-11-12' }), task('l', { dueDate: '2026-11-13' })], me, { seenAt: Date.now(), today });
    assert.deepEqual(r.overdue.map((t) => t.id), ['o']);
    assert.deepEqual(r.dueSoon.map((t) => t.id), ['t', 's']);
    assert.equal(r.count, 3);
  });
  test('finished, archived and other people\'s tasks are ignored; a task is counted once', () => {
    const r = computeAlerts([
      task('done', { statusCategory: 'done', dueDate: '2026-11-01' }), task('arch', { archived: true, dueDate: '2026-11-01' }),
      task('other', { ownerId: 'x', dueDate: '2026-11-01' }),
      task('both', { dueDate: '2026-11-11', assignedBy: 'boss', assignedAt: at('2026-11-05T00:00:00Z') })
    ], me, { seenAt, today });
    assert.equal(r.count, 1);
    assert.equal(r.assigned.length, 1);
    assert.equal(r.dueSoon.length, 1);
  });
});
