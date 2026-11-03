// Team Overview: how a team (or one person) is doing, what needs attention, and who is
// available. For Team Leaders, Assistant Team Leaders, Managers and the Director.
//
// Reads stay low: each team's open tasks, finished tasks for the chosen period and upcoming
// leave are loaded together, kept for 5 minutes, and then filtered on screen. Changing the
// team or person filter never reads from Firebase again; only a new period or Refresh does.

import {
  h, add, clear, todayISO, addDays, fmtDate, fmtWeekday, fmtAgo, toDate, eachDay, startOfWeek
} from '../core/util.js';
import { roleLabel, LEAVE_TYPE_LABEL, OPEN_CATEGORIES } from '../core/model.js';
import * as perm from '../core/perm.js';
import {
  weekStartsOn, dayStatus, capacity, dayFlags, FLAG_TEXT, ownerAwayOnDue, nextLeave, leaveWorkdays, isApproved
} from '../core/calendar.js';
import {
  lastWeeks, completedPerWeek, statusBreakdown, personStats, teamStats, isOverdue, pct
} from '../core/metrics.js';
import {
  state, myTeams, userById, userName, statusById, teamName, loadOpenTasks, loadFinished, loadTeamLeave, loadHolidays
} from '../core/store.js';
import { toast, errorMessage, statusChip, emptyState, spinner, select, avatar } from './components.js';
import { openTaskPanel } from './taskform.js';
import { dueLabel } from './tasks.js';
import { hbars, stackedHbars, columns, legend, tableView, noData } from './charts.js';

const CACHE_MINUTES = 5;
let cache = null;                         // { key, at, data }
let memory = { teamId: '', personId: '', weeks: 8 };
let memoryUser = null;

const FRESH = () => ({ teamId: '', personId: '', weeks: 8 });

export function renderOverview(container) {
  const user = state.user;
  if (memoryUser !== user.id) { memory = FRESH(); memoryUser = user.id; }
  const f = memory;
  const teams = myTeams();
  if (f.teamId && !teams.some((t) => t.id === f.teamId)) f.teamId = '';

  let data = null;           // { open, fin, leaves, holidays, at }
  let loading = true;
  let failure = null;
  const expanded = new Set();

  const filters = h('div', { class: 'toolbar overview-filters' });
  const body = h('div');
  add(container,
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'Team overview'),
        h('p', { class: 'muted' }, 'Workload, productivity, deadlines and who is available. Pick a team or one person to focus.')),
      h('div', { class: 'head-actions' },
        h('span', { class: 'muted small', id: 'updated-at' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh'))),
    filters, body);

  // ------------------------------------------------------------------ loading
  async function load(force = false) {
    const key = `${user.id}|${f.weeks}`;
    if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MINUTES * 60000) {
      data = cache.data; loading = false; failure = null; paint(); return;
    }
    loading = true; failure = null; paint();
    try {
      const today = todayISO();
      const since = addDays(startOfWeek(today, weekStartsOn()), -7 * (f.weeks - 1));
      const perTeam = await Promise.all(teams.map(async (t) => {
        const [open, fin, leaves] = await Promise.all([
          loadOpenTasks({ teamId: t.id }), loadFinished({ teamId: t.id, fromISO: since }), loadTeamLeave(t.id, today)
        ]);
        return { open, fin, leaves };
      }));
      const holidays = await loadHolidays(today);
      const uniq = (lists) => [...new Map(lists.flat().map((x) => [x.id, x])).values()];
      data = {
        open: uniq(perTeam.map((x) => x.open)), fin: uniq(perTeam.map((x) => x.fin)),
        leaves: uniq(perTeam.map((x) => x.leaves)), holidays, at: Date.now()
      };
      cache = { key, at: data.at, data };
    } catch (err) { failure = err; toast(errorMessage(err), 'error'); }
    loading = false; paint();
  }

  // After a task is edited in the side panel, take its new values from the shared cache.
  function syncFromState() {
    if (!data) return;
    const fresh = (list) => list.map((t) => state.tasks.get(t.id) || t);
    data.open = fresh(data.open).filter((t) => !t.archived && OPEN_CATEGORIES.includes(t.statusCategory));
    const nowDone = [...state.tasks.values()].filter((t) => t.statusCategory === 'done' && t.completedDate
      && !data.fin.some((x) => x.id === t.id) && teams.some((tm) => tm.id === t.teamId));
    data.fin = fresh(data.fin).concat(nowDone);
  }

  // ------------------------------------------------------------------ filters
  function drawFilters() {
    clear(filters);
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const people = state.ref.users.filter((u) => u.active !== false && (u.teamIds || []).some((id) => scopeIds.includes(id)));
    if (f.personId && !people.some((p) => p.id === f.personId)) f.personId = '';
    add(filters,
      teams.length > 1 || perm_isDirector() ? select([{ value: '', label: perm_isDirector() ? 'All teams' : 'All my teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))], f.teamId,
        { 'aria-label': 'Team', onchange: (e) => { f.teamId = e.target.value; f.personId = ''; drawFilters(); paint(); } }) : null,
      select([{ value: '', label: 'Everyone' }, ...people.map((p) => ({ value: p.id, label: p.name }))], f.personId,
        { 'aria-label': 'Person', onchange: (e) => { f.personId = e.target.value; paint(); } }),
      select([4, 8, 12].map((n) => ({ value: n, label: `Last ${n} weeks` })), f.weeks,
        { 'aria-label': 'Period', onchange: (e) => { f.weeks = Number(e.target.value); load(); } }));
  }
  const perm_isDirector = () => perm.isDirector(user);

  // ------------------------------------------------------------------- paint
  function paint() {
    drawFilters();
    clear(body);
    const stamp = container.querySelector('#updated-at');
    if (stamp) stamp.textContent = data ? `Updated ${fmtAgo(data.at)}` : '';
    if (loading) { body.append(spinner('Loading team')); return; }
    if (failure || !data) { body.append(emptyState('Could not load the overview', errorMessage(failure))); return; }
    if (!teams.length) { body.append(emptyState('No team yet', 'You are not in a team, so there is nothing to show.')); return; }

    const today = todayISO();
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const inScope = (t) => scopeIds.includes(t.teamId);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const byPerson = (t) => !f.personId || t.ownerId === f.personId;

    const teamOpen = data.open.filter(inScope);
    const teamFin = data.fin.filter(inScope);
    const open = teamOpen.filter(byPerson);
    const fin = teamFin.filter(byPerson);
    const leaves = data.leaves.filter((l) => scopeIds.includes(l.teamId));
    const weeks = lastWeeks(f.weeks, today, weekStartsOn());
    const periodStart = weeks[0].start;
    const stats = teamStats(open, fin, today, periodStart);

    add(body,
      tiles(stats, f.weeks, fin),
      h('div', { class: 'overview-grid' },
        card('Open tasks by status', statusCard(open)),
        card('Workload per person', workloadCard(people, teamOpen, teamFin, leaves, today, periodStart)),
        card(`Completed per week, last ${f.weeks} weeks`, weeklyCard(fin, weeks)),
        card('Availability, next 14 days', availabilityCard(people, leaves, teamOpen, today))),
      h('div', { class: 'overview-grid' },
        card('Needs attention', attentionCard(open, leaves, today)),
        card('Deadlines, next 7 days', upcomingCard(open, people, leaves, today))),
      card('Team members', rosterCard(people, teamOpen, teamFin, leaves, today, periodStart), true),
      h('details', { class: 'viz-table method' },
        h('summary', null, 'How these numbers are worked out'),
        h('ul', null,
          h('li', null, 'Overdue: an open task whose due date is before today.'),
          h('li', null, 'Completed: a task that reached a Done status, counted on the day it was completed.'),
          h('li', null, 'On time: completed on or before its due date. A task with no due date counts as on time.'),
          h('li', null, 'Availability: weekends, public holidays and approved leave. Waiting or declined leave is not counted.'),
          h('li', null, 'Warnings on the calendar and here: “short-staffed” means half the team or more is away; “heavy” means three or more deadlines for each person who is in.'),
          h('li', null, 'Rework: how many times tasks were sent back as “Returned for Rework”.'))));
  }

  const card = (title, content, wide = false) => h('section', { class: 'card-block' + (wide ? ' wide' : '') }, h('h2', null, title), content);

  // -------------------------------------------------------------------- tiles
  function tiles(stats, weeksN, fin) {
    const onTimeDone = fin.filter((t) => t.statusCategory === 'done').length;
    const tile = (label, value, note, tone) => h('div', { class: 'tile' + (tone ? ' tile-' + tone : '') },
      h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, String(value)), h('span', { class: 'tile-note muted' }, note));
    return h('div', { class: 'tiles tiles-6' },
      tile('Open tasks', stats.open, f.personId ? userName(f.personId) : 'across the team'),
      tile('Overdue', stats.overdue, stats.overdue ? 'need attention' : 'all on time', stats.overdue ? 'bad' : 'good'),
      tile('Due in 7 days', stats.dueSoon, 'including today'),
      tile('In review', stats.inReview, 'waiting for a check'),
      tile('Completed', stats.done, `last ${weeksN} weeks`),
      tile('Finished on time', pct(stats.onTimeRate), onTimeDone ? `of ${stats.done} completed` : 'nothing completed yet',
        stats.onTimeRate === null ? '' : stats.onTimeRate >= 0.8 ? 'good' : stats.onTimeRate < 0.5 ? 'bad' : ''));
  }

  // ---------------------------------------------------------- status breakdown
  function statusCard(open) {
    if (!open.length) return noData('No open tasks.');
    const rows = statusBreakdown(open, state.ref.statuses).map((r) => ({ label: r.name, value: r.count }));
    return h('div', null,
      hbars({ rows, ariaLabel: 'Open tasks by status' }),
      tableView(['Status', 'Open tasks'], rows.map((r) => [r.label, r.value])));
  }

  // ------------------------------------------------------------------ workload
  function workloadCard(people, teamOpen, teamFin, leaves, today, periodStart) {
    const shown = f.personId ? people.filter((p) => p.id === f.personId) : people;
    const rows = shown.map((p) => ({ p, s: personStats(p, teamOpen, teamFin, today, periodStart) }))
      .sort((a, b) => b.s.open - a.s.open || a.p.name.localeCompare(b.p.name));
    if (!rows.length || rows.every((r) => r.s.open === 0)) return noData('Nobody has open tasks.');
    const end = addDays(today, 13);
    const awayDays = (p) => {
      let n = 0;
      for (const d of eachDay(today, end)) {
        const st = dayStatus(p, d, leaves, data.holidays);
        if (st.state === 'leave') n += 1; else if (st.state === 'half') n += 0.5;
      }
      return n;
    };
    const chartRows = rows.map(({ p, s }) => {
      const away = awayDays(p);
      return {
        label: p.name,
        parts: [{ value: s.onTrack, color: 'var(--viz-1)', name: 'On track' }, { value: s.overdue, color: 'var(--viz-2)', name: 'Overdue' }],
        tail: away ? `· away ${away}d` : '',
        note: `${s.hours ? s.hours + ' estimated hours. ' : ''}${away ? `Away ${away} working day(s) in the next 14 days.` : ''}`.trim()
      };
    });
    return h('div', null,
      legend([{ name: 'On track', color: 'var(--viz-1)' }, { name: 'Overdue', color: 'var(--viz-2)' }]),
      stackedHbars({ rows: chartRows, ariaLabel: 'Open tasks per person' }),
      tableView(['Person', 'On track', 'Overdue', 'Open', 'Estimated hours'], rows.map(({ p, s }) => [p.name, s.onTrack, s.overdue, s.open, s.hours])));
  }

  // -------------------------------------------------------------------- weekly
  function weeklyCard(fin, weeks) {
    const per = completedPerWeek(fin, weeks);
    if (per.every((w) => w.total === 0)) return noData('No tasks were completed in this period.');
    return columns({
      weeks: per.map((w) => ({
        label: fmtDate(w.start).replace(/ \d{4}$/, ''), a: w.onTime, b: w.late,
        tip: `Week of ${fmtDate(w.start)}: ${w.total} completed (${w.onTime} on time, ${w.late} late)`
      })),
      aName: 'On time', bName: 'Late', ariaLabel: 'Tasks completed per week, on time and late'
    });
  }

  // -------------------------------------------------------------- availability
  function availabilityCard(people, leaves, teamOpen, today) {
    if (!people.length) return noData('No people in this view.');
    const days = eachDay(today, addDays(today, 13));
    const dueOn = (d) => teamOpen.filter((t) => t.dueDate === d).length;
    const head = h('tr', null, h('th', { class: 'sticky-col' }, ''),
      days.map((d) => h('th', { class: 'day-col' + (d === today ? ' day-today' : '') }, h('div', null, fmtWeekday(d).slice(0, 1)), h('div', { class: 'day-num' }, String(Number(d.slice(8)))))));
    const capRow = h('tr', { class: 'cap-row' }, h('th', { class: 'sticky-col', scope: 'row' }, 'Available'),
      days.map((d) => {
        const c = capacity(people, d, leaves, data.holidays);
        const flags = dayFlags(c, dueOn(d));
        if (!c.expected) return h('td', { class: 'cap-off' }, '');
        const cell = h('td', { class: 'cap' + (flags.length ? ' cap-warn' : ''), title: flags.length ? flags.map((x) => FLAG_TEXT[x]).join('. ') : `${c.available} of ${c.expected} available` },
          String(c.available), flags.length ? h('span', { class: 'flag', 'aria-label': flags.map((x) => FLAG_TEXT[x]).join('. ') }, '!') : null);
        return cell;
      }));
    const rows = people.map((p) => h('tr', null, h('th', { class: 'sticky-col', scope: 'row' }, p.name),
      days.map((d) => {
        const st = dayStatus(p, d, leaves, data.holidays);
        const due = teamOpen.filter((t) => t.ownerId === p.id && t.dueDate === d).length;
        const dueBadge = due ? h('span', { class: 'due-dot', title: `${due} due` }, String(due)) : null;
        if (st.state === 'weekend') return h('td', { class: 'av av-off', title: 'Weekend' }, dueBadge);
        if (st.state === 'holiday') return h('td', { class: 'av av-holiday', title: st.holiday.name }, 'H', dueBadge);
        if (st.state === 'leave') return h('td', { class: 'av av-leave', title: `${LEAVE_TYPE_LABEL[st.leave.type]}${st.leave.reason ? ': ' + st.leave.reason : ''}` }, LEAVE_TYPE_LABEL[st.leave.type][0], dueBadge);
        if (st.state === 'half') return h('td', { class: 'av av-half', title: `Half day (${LEAVE_TYPE_LABEL[st.leave.type]})` }, '½', dueBadge);
        return h('td', { class: 'av' }, dueBadge);
      })));
    return h('div', null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'avail', 'aria-label': 'Availability for the next 14 days' }, h('thead', null, head), h('tbody', null, capRow, rows))),
      h('ul', { class: 'viz-legend avail-key' },
        h('li', null, h('span', { class: 'key-box av-leave' }, 'A'), 'Leave (A annual, S sick, T training, O other)'),
        h('li', null, h('span', { class: 'key-box av-half' }, '½'), 'Half day'),
        h('li', null, h('span', { class: 'key-box av-holiday' }, 'H'), 'Holiday'),
        h('li', null, h('span', { class: 'due-dot' }, '2'), 'Tasks due that day'),
        h('li', null, h('span', { class: 'flag' }, '!'), 'Clash: short-staffed or heavy day')));
  }

  // ------------------------------------------------------------- needs attention
  function taskItem(t, extra) {
    return h('li', null, h('button', { type: 'button', class: 'task-link', onclick: () => openTaskPanel({ task: t, onSaved: () => { syncFromState(); paint(); } }) },
      h('span', { class: 'task-link-title' }, t.title),
      h('span', { class: 'task-link-meta' }, h('span', { class: 'muted' }, userName(t.ownerId)), dueLabel(t), statusChip(statusById(t.status)), extra || null)));
  }

  function group(key, title, tone, items, render, emptyText) {
    const limit = 5;
    const show = expanded.has(key) ? items : items.slice(0, limit);
    return h('div', { class: 'attn-group' },
      h('h3', null, title, h('span', { class: 'count' + (tone === 'bad' && items.length ? ' count-bad' : '') }, items.length)),
      items.length ? h('ul', { class: 'task-list' }, show.map(render)) : h('p', { class: 'muted small' }, emptyText),
      items.length > limit ? h('button', { type: 'button', class: 'link-btn', onclick: () => { expanded.has(key) ? expanded.delete(key) : expanded.add(key); paint(); } },
        expanded.has(key) ? 'Show fewer' : `Show all ${items.length}`) : null);
  }

  function attentionCard(open, leaves, today) {
    const overdue = open.filter((t) => isOverdue(t, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const paused = open.filter((t) => t.statusCategory === 'paused').sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9'));
    const review = open.filter((t) => t.statusCategory === 'review').sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9'));
    const horizon = addDays(today, 14);
    const away = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= horizon && ownerAwayOnDue(t, userById(t.ownerId), leaves, data.holidays))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return h('div', null,
      group('overdue', 'Overdue', 'bad', overdue, (t) => taskItem(t), 'Nothing is overdue.'),
      group('paused', 'Blocked or on hold', 'bad', paused,
        (t) => taskItem(t, t.statusNote ? h('span', { class: 'sub' }, `“${t.statusNote}”`) : null), 'Nothing is blocked.'),
      group('review', 'Waiting for review', '', review, (t) => taskItem(t), 'No reviews waiting.'),
      group('away', 'Due while the owner is on leave', 'bad', away,
        (t) => taskItem(t, h('span', { class: 'chip chip-lv chip-lv-pending' }, 'Owner away')), 'No clashes with leave.'));
  }

  // ----------------------------------------------------------------- upcoming
  function upcomingCard(open, people, leaves, today) {
    const days = eachDay(today, addDays(today, 6));
    const anyDue = open.some((t) => t.dueDate && t.dueDate >= today && t.dueDate <= days[6]);
    if (!anyDue) return noData('No deadlines in the next 7 days.');
    const teamAll = data.open.filter((t) => (f.teamId ? t.teamId === f.teamId : true));
    return h('div', null, days.map((d) => {
      const list = open.filter((t) => t.dueDate === d);
      if (!list.length) return null;
      const c = capacity(people, d, leaves, data.holidays);
      const flags = dayFlags(c, teamAll.filter((t) => t.dueDate === d).length);
      return h('div', { class: 'attn-group' },
        h('h3', null, d === today ? 'Today' : `${fmtWeekday(d, true)}, ${fmtDate(d)}`,
          c.expected ? h('span', { class: 'muted small' }, ` · ${c.available} of ${c.expected} available`) : h('span', { class: 'muted small' }, ' · day off'),
          flags.map((x) => h('span', { class: 'chip chip-lv chip-lv-pending', title: FLAG_TEXT[x] }, x === 'short' ? 'Short-staffed' : x === 'heavy' ? 'Heavy day' : 'Nobody in'))),
        h('ul', { class: 'task-list' }, list.map((t) => taskItem(t,
          ownerAwayOnDue(t, userById(t.ownerId), leaves, data.holidays) ? h('span', { class: 'chip chip-lv chip-lv-pending' }, 'Owner away') : null))));
    }));
  }

  // ------------------------------------------------------------------- roster
  function rosterCard(people, teamOpen, teamFin, leaves, today, periodStart) {
    if (!people.length) return noData('No people in this view.');
    const loginLevel = (u) => {
      const d = toDate(u.lastLoginAt);
      if (!d) return { text: 'Never', cls: 'bad' };
      const days = (Date.now() - d.getTime()) / 86400000;
      return days < 1 ? { text: 'Today', cls: 'good' } : days < 7 ? { text: fmtAgo(u.lastLoginAt), cls: 'ok' } : { text: fmtAgo(u.lastLoginAt), cls: 'bad' };
    };
    const used = people.filter((p) => { const d = toDate(p.lastLoginAt); return d && Date.now() - d.getTime() < 7 * 86400000; }).length;
    const todayChip = (p) => {
      const st = dayStatus(p, today, leaves, data.holidays);
      const map = { available: ['In', 'good'], leave: ['On leave', 'bad'], half: ['Half day', 'ok'], holiday: ['Holiday', ''], weekend: ['Weekend', ''] };
      const [text, cls] = map[st.state];
      return h('span', { class: 'chip usage-' + (cls || 'plain') }, text);
    };
    const rows = people.map((p) => ({ p, s: personStats(p, teamOpen, teamFin, today, periodStart) }));
    const nextOf = (p) => nextLeave(p.id, today, leaves);
    return h('div', null,
      h('p', { class: 'muted small' }, `${used} of ${people.length} signed in during the last 7 days. Select a name to focus on that person.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact roster' },
        h('thead', null, h('tr', null,
          [['Person', ''], ['Today', ''], ['Open', 'Open tasks'], ['Overdue', 'Open tasks past their due date'], ['Due 7d', 'Open tasks due in the next 7 days'], ['Review', 'Tasks waiting for a check'], ['Done', 'Completed in the chosen period'], ['On time', 'Share of completed tasks finished by their due date'], ['Rework', 'Times tasks were sent back'], ['Avg days', 'Average days from creation to completion'], ['Next leave', ''], ['Signed in', 'Last sign-in']]
            .map(([c, tip], i) => h('th', { class: i >= 2 && i <= 9 ? 'num' : '', title: tip || null }, c)))),
        h('tbody', null, rows.map(({ p, s }) => {
          const nl = nextOf(p);
          const lv = loginLevel(p);
          return h('tr', { class: f.personId === p.id ? 'row-selected' : '' },
            h('td', null, h('button', { type: 'button', class: 'link-btn person-btn', onclick: () => { f.personId = f.personId === p.id ? '' : p.id; paint(); } },
              avatar(p.name, 22), ' ', p.name), h('div', { class: 'sub muted' }, roleLabel(p))),
            h('td', null, todayChip(p)),
            h('td', { class: 'num' }, s.open),
            h('td', { class: 'num' }, s.overdue ? h('span', { class: 'due due-overdue' }, String(s.overdue)) : '0'),
            h('td', { class: 'num' }, s.dueSoon),
            h('td', { class: 'num' }, s.inReview),
            h('td', { class: 'num' }, s.done),
            h('td', { class: 'num' }, pct(s.onTimeRate)),
            h('td', { class: 'num' }, s.rework),
            h('td', { class: 'num' }, s.avgCycleDays === null ? '–' : s.avgCycleDays.toFixed(1)),
            h('td', null, nl ? `${fmtDate(nl.startDate)}${nl.endDate !== nl.startDate ? ' to ' + fmtDate(nl.endDate) : ''}` : h('span', { class: 'muted' }, '–')),
            h('td', null, h('span', { class: 'chip usage-' + lv.cls }, lv.text)));
        })))),
      tableView(['Person', 'Open', 'Overdue', 'Completed', 'On time'], rows.map(({ p, s }) => [p.name, s.open, s.overdue, s.done, pct(s.onTimeRate)])));
  }

  load();
  return () => {};
}

export { leaveWorkdays, isApproved, teamName };
