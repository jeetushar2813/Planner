// Weekly summary: one page to run the Monday team meeting from. Read it on screen, copy it as
// text for a chat or email, or save it as PDF (the browser's print window).
//
// Reads stay low: each team's open tasks, the tasks finished since the week began, and leave are
// loaded once and kept for 5 minutes. The team filter is applied on screen without reading again.

import { h, add, clear, todayISO, fmtDate, fmtDateLong, daysBetween } from '../core/util.js';
import { roleLabel } from '../core/model.js';
import * as perm from '../core/perm.js';
import { compileWeekly, resolveWeek, weeklyText, WEEK_CHOICES, KEY_AHEAD_DAYS } from '../core/weekly.js';
import { whenText, KEY_CATEGORY_LABEL } from '../core/keydates.js';
import { wasOnTime, pct } from '../core/metrics.js';
import { state, myTeams, userName, statusName, loadOpenTasks, loadFinished, loadTeamLeave, loadHolidays, loadKeyDates } from '../core/store.js';
import { toast, errorMessage, emptyState, spinner, select } from './components.js';
import { openTaskPanel } from './taskform.js';

const CACHE_MINUTES = 5;
let cache = null;                               // { key, at, data }
let memory = { teamId: '', week: 'last', user: null };

export function renderWeekly(container) {
  const user = state.user;
  if (memory.user !== user.id) memory = { teamId: '', week: 'last', user: user.id };
  const f = memory;
  const teams = myTeams();
  if (f.teamId && !teams.some((t) => t.id === f.teamId)) f.teamId = '';

  let data = null, loading = true, failure = null, model = null, scopeText = '';
  const controls = h('div', { class: 'toolbar report-controls' });
  const body = h('div', { class: 'report-doc' });
  const notes = h('textarea', { rows: 4, 'aria-label': 'Notes for the meeting', placeholder: 'Notes for the meeting (not saved; they print with the page)' });
  add(container,
    h('div', { class: 'page-head row-head report-head' },
      h('div', null,
        h('h1', null, 'Weekly summary'),
        h('p', { class: 'muted' }, 'What happened last week and what is coming, in the order you would talk about it. For your Monday meeting.')),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: copyText }, 'Copy as text'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: printPdf, title: 'Opens the print window: choose “Save as PDF”' }, 'Save as PDF'))),
    controls, body);

  const week = () => resolveWeek(f.week, todayISO());

  async function load(force = false) {
    const key = `${user.id}|${week().from}`;
    if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MINUTES * 60000) {
      data = cache.data; loading = false; failure = null; paint(); return;
    }
    loading = true; failure = null; paint();
    try {
      const today = todayISO();
      const w = week();
      const perTeam = await Promise.all(teams.map(async (t) => {
        const [open, fin, leaves] = await Promise.all([
          loadOpenTasks({ teamId: t.id }), loadFinished({ teamId: t.id, fromISO: w.from }), loadTeamLeave(t.id, today)
        ]);
        return { open, fin, leaves };
      }));
      const uniq = (lists) => [...new Map(lists.flat().map((x) => [x.id, x])).values()];
      data = { tasks: uniq(perTeam.flatMap((x) => [x.open, x.fin])), leaves: uniq(perTeam.map((x) => x.leaves)), holidays: await loadHolidays(today), keyDates: await loadKeyDates().catch(() => []), at: Date.now() };
      cache = { key, at: data.at, data };
    } catch (err) { failure = err; toast(errorMessage(err), 'error'); }
    loading = false; paint();
  }

  function drawControls() {
    clear(controls);
    add(controls,
      select(WEEK_CHOICES, f.week, { 'aria-label': 'Week', onchange: (e) => { f.week = e.target.value; load(); } }),
      teams.length > 1 || perm.isDirector(user)
        ? select([{ value: '', label: perm.isDirector(user) ? 'All teams' : 'All my teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))], f.teamId,
          { 'aria-label': 'Team', onchange: (e) => { f.teamId = e.target.value; paint(); } }) : null);
  }

  function scope() {
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)));
    const text = f.teamId ? teams.find((t) => t.id === f.teamId)?.name
      : perm.isDirector(user) ? 'All teams' : (teams.length === 1 ? teams[0].name : 'All my teams');
    return { scopeIds, people, text };
  }

  function paint() {
    drawControls();
    clear(body);
    model = null;
    if (loading) { body.append(spinner('Preparing the summary')); return; }
    if (failure || !data) { body.append(emptyState('Could not prepare the summary', errorMessage(failure))); return; }
    if (!teams.length) { body.append(emptyState('No team yet', 'You are not in a team, so there is nothing to show.')); return; }
    // Tasks edited in the side panel: take their new values from the shared cache.
    data.tasks = data.tasks.map((t) => state.tasks.get(t.id) || t);

    const today = todayISO();
    const { scopeIds, people, text } = scope();
    scopeText = text;
    model = compileWeekly({
      people, tasks: data.tasks.filter((t) => scopeIds.includes(t.teamId)), leaves: data.leaves.filter((l) => scopeIds.includes(l.teamId)),
      holidays: data.holidays, week: week(), today,
      keyDates: (data.keyDates || []).filter((k) => !k.teamId || scopeIds.includes(k.teamId))
    });
    const hd = model.headline;

    add(body,
      h('header', { class: 'report-title' },
        h('p', { class: 'report-kicker' }, 'Weekly summary'),
        h('h2', null, model.week.label, ' · ', text),
        h('p', { class: 'muted' }, model.week.inProgress ? 'This week so far, and the 7 days ahead' : 'Last week, and the 7 days ahead'),
        h('p', { class: 'muted small' }, `Prepared ${fmtDateLong(today)} by ${user.name} (${roleLabel(user)})`)),
      tiles(hd),
      section('At a glance', h('ul', { class: 'glance' }, ...model.glance.map((g) => h('li', null, g)))),
      section('People', peopleTable()),
      section(`Finished (${hd.done})`, taskTable(model.done, ['Task', 'Owner', 'Due', 'Finished', 'On time'],
        (t) => [titleCell(t), userName(t.ownerId), t.dueDate ? fmtDate(t.dueDate) : '–', fmtDate(t.completedDate), wasOnTime(t) ? 'Yes' : `Late by ${daysBetween(t.dueDate, t.completedDate)}d`],
        'Nothing was finished in this week.')),
      section(`Overdue now (${hd.overdue})`, taskTable(model.overdue, ['Task', 'Owner', 'Was due', 'Late by', 'Status'],
        (t) => [titleCell(t), userName(t.ownerId), fmtDate(t.dueDate), `${daysBetween(t.dueDate, today)}d`, statusName(t.status)], 'Nothing is overdue.')),
      section(`Waiting for review (${hd.review})`, taskTable(model.review, ['Task', 'Owner', 'Due'],
        (t) => [titleCell(t), userName(t.ownerId), t.dueDate ? fmtDate(t.dueDate) : '–'], 'Nothing is waiting for review.')),
      section(`Blocked or paused (${hd.blocked})`, taskTable(model.blocked, ['Task', 'Owner', 'Status', 'Note'],
        (t) => [titleCell(t), userName(t.ownerId), statusName(t.status), t.statusNote || (t.blockedBy?.length ? 'Waiting for another task' : '–')], 'Nothing is blocked or paused.')),
      section(`Due in the next 7 days (${hd.upcoming})`, taskTable(model.upcoming, ['Task', 'Owner', 'Due', 'Heads up'],
        (u) => [titleCell(u.task), userName(u.task.ownerId), fmtDate(u.task.dueDate), u.away ? 'Owner is away that day' : '–'], 'Nothing is due in the next 7 days.')),
      section(`★ Key dates in the next ${KEY_AHEAD_DAYS} days (${hd.keys})`, taskTable(model.keys, ['Key date', 'When', 'Dates', 'Type'],
        (o) => [h('a', { href: '#/calendar' }, o.kd.title), whenText(o), `${fmtDate(o.startDate)}${o.endDate !== o.startDate ? ' to ' + fmtDate(o.endDate) : ''}`, KEY_CATEGORY_LABEL[o.kd.category] || 'Other'], 'No key dates in the next two weeks.')),
      section(`Away in the next 2 weeks (${hd.away})`, taskTable(model.away, ['Person', 'From', 'To', 'Working days'],
        (a) => [a.person.name, fmtDate(a.leave.startDate), fmtDate(a.leave.endDate), a.days], 'Nobody is away.')),
      section('Notes', notes),
      h('section', { class: 'card-block report-method' },
        h('h2', null, 'How these numbers are worked out'),
        h('ul', null,
          h('li', null, 'Finished: tasks that reached a Done status, counted on the day they were finished. On time means on or before the due date; no due date counts as on time.'),
          h('li', null, 'Steps ticked: checklist steps ticked in the week, credited to the person who ticked them.'),
          h('li', null, 'Overdue, waiting for review, blocked and due soon are the position today. The app does not keep history, so they are not “as at” the end of the week.'),
          h('li', null, 'Blocked or paused: tasks in a paused status, or waiting for another task that is not finished.'),
          h('li', null, 'Key dates: dates marked on the calendar for the chosen team(s) and for everyone, starting or under way in the next 14 days.'),
          h('li', null, 'Away: approved leave only, in working days (weekends and public holidays are not counted).'))));
  }

  const section = (title, content) => h('section', { class: 'card-block report-section' }, h('h2', null, title), content);
  const titleCell = (t) => h('button', { type: 'button', class: 'task-link-plain', onclick: () => openTaskPanel({ task: t, onSaved: () => paint() }) }, t.title);

  function tiles(hd) {
    const tile = (label, value, note, tone = '') => h('div', { class: 'tile' },
      h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, String(value)),
      h('span', { class: 'tile-note' + (tone ? ' cmp-' + tone : ' muted') }, note));
    return h('div', { class: 'tiles report-tiles' },
      tile('Finished', hd.done, hd.created ? `${hd.created} new tasks` : 'no new tasks'),
      tile('On time', pct(hd.onTimeRate), hd.late ? `${hd.late} late` : (hd.done ? 'none late' : 'nothing finished'), hd.late ? 'bad' : ''),
      tile('Steps ticked', hd.steps, 'checklist steps'),
      tile('Overdue now', hd.overdue, hd.overdue ? 'need attention' : 'nothing overdue', hd.overdue ? 'bad' : 'good'),
      tile('Waiting for review', hd.review, 'for a leader to check'),
      tile('Blocked or paused', hd.blocked, 'cannot move yet'),
      tile('Due in 7 days', hd.upcoming, 'next week ahead'),
      tile('People away', hd.away, 'leave in next 2 weeks'));
  }

  function peopleTable() {
    if (!model.rows.length) return h('p', { class: 'muted' }, 'Nobody finished anything, ticked a step, or has overdue or review work.');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact report-table' },
      h('thead', null, h('tr', null, ['Person', 'Finished', 'Late', 'Steps ticked', 'Overdue now', 'In review'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', null, model.rows.map((r) => h('tr', null,
        h('td', null, r.person.name), h('td', { class: 'num' }, r.done), h('td', { class: 'num' }, r.late), h('td', { class: 'num' }, r.steps),
        h('td', { class: 'num' }, r.overdue ? h('span', { class: 'due due-overdue' }, r.overdue) : 0), h('td', { class: 'num' }, r.review))))));
  }

  function taskTable(list, headers, cells, emptyText) {
    if (!list.length) return h('p', { class: 'muted' }, emptyText);
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact report-table report-tasks' },
      h('thead', null, h('tr', null, headers.map((x) => h('th', null, x)))),
      h('tbody', null, list.map((item) => h('tr', null, cells(item).map((c, i) => h('td', { class: i === 0 ? 'task-cell' : '' }, c)))))));
  }

  async function copyText() {
    if (!model) return;
    const text = weeklyText(model, { scope: scopeText, nameOf: userName, today: todayISO() });
    try { await navigator.clipboard.writeText(text); toast('Summary copied. Paste it into a chat or an email.', 'success'); }
    catch { toast('Your browser did not allow copying. Use Save as PDF instead.', 'error'); }
  }

  function printPdf() {
    if (!model) return;
    const before = document.title;
    document.title = `Weekly summary ${model.week.from} ${scopeText}`;       // becomes the suggested PDF file name
    const restore = () => { document.title = before; window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore);
    setTimeout(() => window.print(), 60);
  }

  load(false);
}
