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
