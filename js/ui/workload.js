// Workload: hours due against working time, per person, for a period you pick.
// For a Team Leader, Assistant Team Leader, Manager or Director deciding who to give work to.

import { h, add, clear, todayISO, fmtDate } from '../core/util.js';
import { OPEN_CATEGORIES } from '../core/model.js';
import * as perm from '../core/perm.js';
import { compileWorkload, resolveWindow, WINDOWS, UTIL_STATUS, fmtHours } from '../core/workload.js';
import { state, myTeams, userName, statusName, teamName, loadOpenTasks, loadTeamLeave, loadHolidays } from '../core/store.js';
import { toast, errorMessage, emptyState, spinner, select } from './components.js';
import { openTaskPanel } from './taskform.js';

const CACHE_MINUTES = 5;
let cache = null;                               // { user, at, data }
let memory = { teamId: '', window: 'week', user: null };

export function renderWorkload(container) {
  const user = state.user;
  if (memory.user !== user.id) memory = { teamId: '', window: 'week', user: user.id };
  const f = memory;
  const teams = myTeams();
  if (f.teamId && !teams.some((t) => t.id === f.teamId)) f.teamId = '';

  let data = null, loading = true, failure = null;
  const expanded = new Set();
  const filters = h('div', { class: 'toolbar' });
  const body = h('div');
  add(container,
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'Workload'),
        h('p', { class: 'muted' }, 'Hours due in the period compared with each person’s working time, after weekends, holidays and approved leave. Use it to decide who to give new work to.')),
      h('div', { class: 'head-actions' },
        h('span', { class: 'muted small', id: 'wl-updated' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh'))),
    filters, body);

  async function load(force = false) {
    if (!force && cache && cache.user === user.id && Date.now() - cache.at < CACHE_MINUTES * 60000) {
      data = cache.data; loading = false; failure = null; paint(); return;
    }
    loading = true; failure = null; paint();
    try {
      const today = todayISO();
      const perTeam = await Promise.all(teams.map(async (t) => {
        const [tasks, leaves] = await Promise.all([loadOpenTasks({ teamId: t.id }), loadTeamLeave(t.id, today)]);
        return { tasks, leaves };
      }));
      const holidays = await loadHolidays(today);
      const uniq = (lists) => [...new Map(lists.flat().map((x) => [x.id, x])).values()];
      data = { tasks: uniq(perTeam.map((x) => x.tasks)), leaves: uniq(perTeam.map((x) => x.leaves)), holidays, at: Date.now() };
      cache = { user: user.id, at: data.at, data };
    } catch (err) { failure = err; toast(errorMessage(err), 'error'); }
    loading = false; paint();
  }

  // After a task is edited in the side panel, take its new values from the shared cache.
  function syncFromState() {
    if (!data) return;
    data.tasks = data.tasks.map((t) => state.tasks.get(t.id) || t).filter((t) => !t.archived && OPEN_CATEGORIES.includes(t.statusCategory));
  }

  function drawFilters() {
    clear(filters);
    add(filters,
      teams.length > 1 || perm.isDirector(user)
        ? select([{ value: '', label: perm.isDirector(user) ? 'All teams' : 'All my teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))], f.teamId,
          { 'aria-label': 'Team', onchange: (e) => { f.teamId = e.target.value; paint(); } }) : null,
      select(WINDOWS, f.window, { 'aria-label': 'Period', onchange: (e) => { f.window = e.target.value; paint(); } }));
  }

  function paint() {
    drawFilters();
    clear(body);
    const stamp = container.querySelector('#wl-updated');
    if (stamp) stamp.textContent = data ? `Loaded ${new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    if (loading) { body.append(spinner('Loading workload')); return; }
    if (failure || !data) { body.append(emptyState('Could not load the workload', errorMessage(failure))); return; }
    if (!teams.length) { body.append(emptyState('No team yet', 'You are not in a team, so there is nothing to show.')); return; }
    syncFromState();

    const today = todayISO();
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)));
    const model = compileWorkload({
      people, tasks: data.tasks.filter((t) => scopeIds.includes(t.teamId)), leaves: data.leaves.filter((l) => scopeIds.includes(l.teamId)),
      holidays: data.holidays, window: resolveWindow(f.window, today), today
    });
    const t = model.totals;
    add(body,
      h('p', { class: 'muted' }, `${fmtDate(model.window.from)} to ${fmtDate(model.window.to)} · ${model.days} calendar days · a working day is ${fmtHours(model.perDay)} hours`),
      tiles(t, model),
      model.mostRoom.length ? h('p', { class: 'wl-room' }, h('strong', null, 'Most room: '),
        model.mostRoom.map((r) => `${r.person.name} (${fmtHours(r.freeHours)} h free)`).join(', ')) : null,
      table(model),
      h('details', { class: 'viz-table method' },
        h('summary', null, 'How these numbers are worked out'),
        h('ul', null,
          h('li', null, 'Capacity: the person’s working days in the period (not weekends, public holidays or approved leave; a half day of leave counts as half) times the hours in a working day.'),
          h('li', null, 'Load: the estimated hours of open tasks that are due in the period or already overdue. Tasks due later, and tasks with no due date, are listed but not counted.'),
          h('li', null, 'A task with no estimate counts as 0 hours and is flagged, so a low figure may just mean estimates are missing. Add an estimate to the task to include it.'),
          h('li', null, 'Steps waiting: checklist steps given to the person and not yet ticked. They have no estimate, so they are counted but not turned into hours.'),
          h('li', null, 'Balanced is under 80% of capacity, Full is 80% to 100%, Overloaded is over 100%. Room for more is under 40%.'))));
  }

  function tiles(t, model) {
    const tile = (label, value, note, tone = '') => h('div', { class: 'tile' },
      h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, String(value)),
      h('span', { class: 'tile-note' + (tone ? ' cmp-' + tone : ' muted') }, note));
    const pct = t.capacityHours > 0 ? Math.round((t.loadHours / t.capacityHours) * 100) : null;
    return h('div', { class: 'tiles report-tiles' },
      tile('Capacity (hours)', fmtHours(t.capacityHours), `${model.rows.length} people`),
      tile('Due (hours)', fmtHours(t.loadHours), pct === null ? 'no working time' : `${pct}% of capacity`),
      tile('Free (hours)', fmtHours(t.freeHours), 'before anyone is overloaded'),
      tile('Overloaded', t.overloaded, t.overloaded ? 'people over capacity' : 'nobody over capacity', t.overloaded ? 'bad' : 'good'),
      tile('No estimate', t.noEstimate, t.noEstimate ? 'tasks counted as 0 hours' : 'all due tasks have one', t.noEstimate ? 'bad' : ''),
      tile('Steps waiting', t.stepsWaiting, 'given to people, not done'));
  }

  function table(model) {
    if (!model.rows.length) return emptyState('No people in this view', 'Nobody is in the team yet.');
    const out = h('div', { class: 'table-wrap' });
    const tbl = h('table', { class: 'tasks compact wl-table' });
    tbl.append(h('thead', null, h('tr', null, ['Person', 'Load against capacity', 'Status', 'Due', 'Overdue', 'No estimate', 'Steps waiting', 'Later / no date']
      .map((x, i) => h('th', { class: i > 2 ? 'num' : '' }, x)))));
    const tbody = h('tbody');
    for (const r of model.rows) {
      const open = expanded.has(r.person.id);
      const s = UTIL_STATUS[r.status];
      const pct = r.utilisation === null ? null : Math.round(r.utilisation * 100);
      tbody.append(h('tr', { class: 'row wl-row', tabindex: 0, 'aria-expanded': String(open),
        onclick: () => { if (open) expanded.delete(r.person.id); else expanded.add(r.person.id); paint(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } },
        h('td', null, h('span', { class: 'wl-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'), ' ', r.person.name),
        h('td', { class: 'wl-bar-cell' }, bar(r), h('span', { class: 'wl-bar-text' },
          r.capacityHours > 0 ? `${fmtHours(r.loadHours)} of ${fmtHours(r.capacityHours)} h${pct !== null ? ` (${pct}%)` : ''}` : `${fmtHours(r.loadHours)} h due, no working days`)),
        h('td', null, h('span', { class: 'chip wl-chip' + (s.tone ? ' wl-' + s.tone : '') }, s.label)),
        h('td', { class: 'num' }, r.due.length),
        h('td', { class: 'num' }, r.overdue ? h('span', { class: 'due due-overdue' }, r.overdue) : 0),
        h('td', { class: 'num' }, r.noEstimate),
        h('td', { class: 'num' }, r.steps.length),
        h('td', { class: 'num' }, `${r.later.length} / ${r.undated.length}`)));
      if (open) tbody.append(h('tr', { class: 'wl-detail' }, h('td', { colspan: 8 }, detail(r))));
    }
    tbl.append(tbody);
    out.append(tbl);
    return out;
  }

  // The bar is capped at the width of the cell; the text beside it carries the exact figure,
  // and the status word beside that is never left to colour alone.
  function bar(r) {
    const pct = r.utilisation === null ? (r.loadHours > 0 ? 100 : 0) : Math.min(100, Math.round(r.utilisation * 100));
    const tone = UTIL_STATUS[r.status].tone;
    return h('span', { class: 'wl-bar', role: 'img', 'aria-label': `${pct}% of capacity` },
      h('span', { class: 'wl-fill' + (tone ? ' wl-' + tone : ''), style: { width: pct + '%' } }));
  }

  function detail(r) {
    const taskLine = (task, extra) => h('li', null,
      h('button', { type: 'button', class: 'task-link-plain', onclick: (e) => { e.stopPropagation(); openTaskPanel({ task, onSaved: () => { syncFromState(); paint(); } }); } }, task.title),
      h('span', { class: 'muted small' }, ` · ${extra}`));
    const hrs = (task) => (Number(task.estimateHours) > 0 ? `${fmtHours(Number(task.estimateHours))} h` : 'no estimate');
    const group = (title, items) => items.length ? h('div', { class: 'wl-group' }, h('h4', null, title), h('ul', null, ...items)) : null;
    const sections = [
      group(`Due in the period (${r.due.length})`, r.due.map((task) => taskLine(task, `${task.dueDate < todayISO() ? 'overdue, was due ' : 'due '}${fmtDate(task.dueDate)} · ${hrs(task)} · ${statusName(task.status)}`))),
      group(`Steps waiting (${r.steps.length})`, r.steps.map(({ task, step }) => taskLine(task, `“${step.text}” · task owner ${userName(task.ownerId)}`))),
      group(`Due later (${r.later.length})`, r.later.map((task) => taskLine(task, `due ${fmtDate(task.dueDate)} · ${hrs(task)}`))),
      group(`No due date (${r.undated.length})`, r.undated.map((task) => taskLine(task, `${hrs(task)} · ${teamName(task.teamId)}`)))
    ].filter(Boolean);
    return sections.length ? h('div', { class: 'wl-detail-body' }, ...sections) : h('p', { class: 'muted' }, 'Nothing open for this person.');
  }

  load(false);
}
