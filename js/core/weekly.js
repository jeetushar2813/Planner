// The weekly summary for Monday meetings. Pure functions (no screen, no database).
//
// It looks back at one week (last week, or this week so far) and forward at the next seven days:
//   finished and finished late, steps ticked, what is overdue, waiting for review, blocked or paused,
//   what is due in the next seven days (and whose owner will be away), and who is away.

import { wasOnTime, isOverdue, isOpenTask, pct } from './metrics.js';
import { isApproved, leaveWorkdays, dayStatus, weekStartsOn } from './calendar.js';
import { openBlockers } from './deps.js';
import { comingUp, whenText, KEY_CATEGORY_LABEL } from './keydates.js';
import { addDays, startOfWeek, daysBetween, toDate, toISO, fmtDate } from './util.js';

export const WEEK_CHOICES = [
  { value: 'last', label: 'Last week' },
  { value: 'this', label: 'This week so far' }
];

export function resolveWeek(kind, today) {
  const thisStart = startOfWeek(today, weekStartsOn());
  const from = kind === 'this' ? thisStart : addDays(thisStart, -7);
  const to = addDays(from, 6);
  return { kind, from, to, inProgress: to >= today, label: `${fmtDate(from)} to ${fmtDate(to)}` };
}

const dateOf = (value) => { const d = toDate(value); return d ? toISO(d) : null; };
const inRange = (iso, a, b) => !!iso && iso >= a && iso <= b;

export const KEY_AHEAD_DAYS = 14;

export function compileWeekly({ people, tasks, leaves, holidays, week, today, keyDates = [] }) {
  const ids = new Set(people.map((p) => p.id));
  const mine = tasks.filter((t) => ids.has(t.ownerId));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const personOf = new Map(people.map((p) => [p.id, p]));
  const last = week.inProgress && week.to > today ? today : week.to;     // this week counts up to today

  const done = mine.filter((t) => t.statusCategory === 'done' && inRange(t.completedDate, week.from, last))
    .sort((a, b) => a.completedDate.localeCompare(b.completedDate) || a.title.localeCompare(b.title));
  const finishedLate = done.filter((t) => !wasOnTime(t));
  const created = mine.filter((t) => t.statusCategory !== 'closed' && inRange(dateOf(t.createdAt), week.from, last));

  // Steps ticked in the week, credited to the person who ticked them.
  const steps = tasks.flatMap((t) => (t.checklist || [])
    .filter((s) => s.done === true && s.doneBy && ids.has(s.doneBy) && inRange(dateOf(s.doneAt), week.from, last))
    .map((s) => ({ task: t, step: s, by: s.doneBy })));

  const open = mine.filter(isOpenTask);
  const overdue = open.filter((t) => isOverdue(t, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const review = open.filter((t) => t.statusCategory === 'review').sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const blocked = open.filter((t) => t.statusCategory === 'paused' || openBlockers(t, (id) => byId.get(id)).open.length > 0)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const limit = addDays(today, 6);
  const upcoming = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= limit)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title))
    .map((t) => {
      const owner = personOf.get(t.ownerId);
      const s = owner ? dayStatus(owner, t.dueDate, leaves, holidays).state : 'available';
      return { task: t, away: s === 'leave' || s === 'half' };
    });

  // Leave that touches today or the next two weeks.
  const horizon = addDays(today, 13);
  const away = leaves.filter((l) => isApproved(l) && ids.has(l.userId) && l.endDate >= today && l.startDate <= horizon)
    .map((l) => {
      const clipped = { ...l, startDate: l.startDate < today ? today : l.startDate, endDate: l.endDate > horizon ? horizon : l.endDate };
      return { leave: l, person: personOf.get(l.userId), days: leaveWorkdays(clipped, personOf.get(l.userId), holidays) };
    })
    .filter((x) => x.days > 0)
    .sort((a, b) => a.leave.startDate.localeCompare(b.leave.startDate) || a.person.name.localeCompare(b.person.name));

  // Key dates (Semester starts, Exam week...) starting or under way in the next two weeks. The caller passes the
  // ones that apply to the chosen team(s) and to everyone.
  const keys = comingUp(keyDates, today, KEY_AHEAD_DAYS);

  const rows = people.map((p) => {
    const d = done.filter((t) => t.ownerId === p.id);
    return {
      person: p, done: d.length, late: d.filter((t) => !wasOnTime(t)).length,
      steps: steps.filter((s) => s.by === p.id).length,
      overdue: overdue.filter((t) => t.ownerId === p.id).length,
      review: review.filter((t) => t.ownerId === p.id).length
    };
  }).filter((r) => r.done || r.steps || r.overdue || r.review).sort((a, b) => b.done - a.done || a.person.name.localeCompare(b.person.name));

  const headline = {
    done: done.length, onTimeRate: done.length ? (done.length - finishedLate.length) / done.length : null, late: finishedLate.length,
    created: created.length, steps: steps.length,
    overdue: overdue.length, review: review.length, blocked: blocked.length, upcoming: upcoming.length, away: away.length, keys: keys.length
  };

  const model = { week, headline, rows, done, finishedLate, steps, overdue, review, blocked, upcoming, away, keys, names: personOf };
  model.glance = glance(model, today);
  return model;
}

// A few plain sentences for the top of the page, in meeting order.
function glance(m, today) {
  const h = m.headline, lines = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const when = m.week.inProgress ? 'so far this week' : 'last week';
  lines.push(h.done
    ? `${plural(h.done, 'task was', 'tasks were')} finished ${when}, ${pct(h.onTimeRate)} on time${h.late ? ` (${h.late} late)` : ''}.`
    : `No tasks were finished ${when}.`);
  if (h.steps) lines.push(`${plural(h.steps, 'checklist step was', 'checklist steps were')} ticked off.`);
  if (h.overdue) {
    const count = new Map();
    for (const t of m.overdue) count.set(t.ownerId, (count.get(t.ownerId) || 0) + 1);
    const [id, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    const who = m.names.get(id)?.name;
    const oldest = m.overdue[0];
    lines.push(`${plural(h.overdue, 'task is', 'tasks are')} overdue${count.size > 1 && who ? `, most with ${who} (${n})` : ''}. The oldest has been late ${daysBetween(oldest.dueDate, today)} days.`);
  } else lines.push('Nothing is overdue.');
  if (h.review) lines.push(`${plural(h.review, 'task is', 'tasks are')} waiting for review.`);
  if (h.blocked) lines.push(`${plural(h.blocked, 'task is', 'tasks are')} blocked or paused.`);
  const awayDue = m.upcoming.filter((u) => u.away).length;
  lines.push(h.upcoming
    ? `${plural(h.upcoming, 'task is', 'tasks are')} due in the next 7 days${awayDue ? `, ${awayDue} of them when the owner is away` : ''}.`
    : 'Nothing is due in the next 7 days.');
  if (m.keys.length) {
    const first = m.keys[0];
    lines.push(`${plural(m.keys.length, 'key date', 'key dates')} in the next ${KEY_AHEAD_DAYS} days. First: ${first.kd.title} (${whenText(first)}).`);
  }
  return lines;
}

// The same summary as plain text, to paste into a chat or an email.
export function weeklyText(m, { scope, nameOf, today }) {
  const out = [];
  const line = (s = '') => out.push(s);
  const task = (t) => `- ${t.title} (${nameOf(t.ownerId)}${t.dueDate ? `, due ${fmtDate(t.dueDate)}` : ''})`;
  line(`WEEKLY SUMMARY: ${scope}`);
  line(`${m.week.inProgress ? 'This week so far' : 'Last week'}: ${m.week.label}. Prepared ${fmtDate(today)}.`);
  line();
  m.glance.forEach((g) => line(g));
  const section = (title, items, fmt) => { if (!items.length) return; line(); line(`${title} (${items.length})`); items.forEach((i) => line(fmt(i))); };
  section('Finished', m.done, (t) => `${task(t)}${wasOnTime(t) ? '' : ' - late'}`);
  section('Overdue now', m.overdue, (t) => `${task(t)} - ${daysBetween(t.dueDate, today)} days late`);
  section('Waiting for review', m.review, task);
  section('Blocked or paused', m.blocked, task);
  section('Due in the next 7 days', m.upcoming, (u) => `${task(u.task)}${u.away ? ' - owner away' : ''}`);
  section(`Key dates in the next ${KEY_AHEAD_DAYS} days`, m.keys, (o) => `- ${o.kd.title}: ${fmtDate(o.startDate)}${o.endDate !== o.startDate ? ' to ' + fmtDate(o.endDate) : ''} (${whenText(o)}, ${KEY_CATEGORY_LABEL[o.kd.category] || 'Other'})`);
  section('Away in the next 2 weeks', m.away, (a) => `- ${a.person.name}: ${fmtDate(a.leave.startDate)} to ${fmtDate(a.leave.endDate)} (${a.days} working day${a.days === 1 ? '' : 's'})`);
  return out.join('\n');
}

