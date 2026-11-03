// My projects: for people who own a project (and for leaders who hand work to others).
//  - every task in the projects I own, in any team
//  - work waiting for my review, with Approve and Send back
//  - tasks I handed to someone else
// Project owners can hand tasks out and approve work, but they cannot edit other
// people's task details (the Security Rules enforce this too).

import { h, clear, todayISO, addDays } from '../core/util.js';
import { OPEN_CATEGORIES } from '../core/model.js';
import * as perm from '../core/perm.js';
import {
  state, bus, ownedProjects, projectName, teamName, userName, userById, statusById, activeStatuses,
  loadRefData, loadProjectTasks, loadProjectDone, loadAssignedByMe
} from '../core/store.js';
import { wasOnTime, pct } from '../core/metrics.js';
import {
  toast, errorMessage, statusChip, priorityChip, personTag, emptyState, spinner, select
} from './components.js';
import { openTaskPanel, requestStatusChange } from './taskform.js';
import { dueLabel, dueState } from './tasks.js';
import { stackedHbars, legend, noData } from './charts.js';
import { presetReportProject } from './reports.js';

let choice = ''; // '' = all my projects
let choiceUser = null;

export function renderProjects(container) {
  const user = state.user;
  if (choiceUser !== user.id) { choice = ''; choiceUser = user.id; }
  let loading = true;
  let loadError = null;
  let handed = [];
  let personFilter = '';
  let statusFilter = '';

  const projectsHere = () => ownedProjects();
  if (choice && !projectsHere().some((p) => p.id === choice)) choice = '';

  const picker = h('select', { 'aria-label': 'Project', onchange: () => { choice = picker.value; personFilter = ''; paint(); } });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh');
  const reportBtn = h('button', {
    type: 'button', class: 'btn btn-ghost',
    onclick: () => { presetReportProject(choice || projectsHere()[0]?.id || null); location.hash = '#/reports'; }
  }, 'Project report');
  const addBtn = h('button', {
    type: 'button', class: 'btn btn-primary',
    onclick: () => openTaskPanel({
      defaults: { projectId: choice || projectsHere()[0]?.id || '', teamId: projectTeam() },
      onSaved: () => load(false)
    })
  }, '+ Add task');
  const body = h('div', { class: 'projects-body' });

  container.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'My projects'),
      h('p', { class: 'muted' }, 'Everything in the projects you own, work waiting for your review, and tasks you handed to others.')),
    h('div', { class: 'toolbar' }, picker, h('div', { class: 'spacer' }), refreshBtn, reportBtn, addBtn),
    body);

  function projectTeam() {
    const p = state.ref.projects.find((x) => x.id === (choice || projectsHere()[0]?.id));
    const mine = perm.visibleTeams(user, state.ref.teams).map((t) => t.id);
    return p && mine.includes(p.teamId) ? p.teamId : undefined;
  }

  function drawPicker() {
    const list = projectsHere();
    clear(picker).append(
      ...(list.length > 1 ? [h('option', { value: '' }, 'All my projects')] : []),
      ...list.map((p) => h('option', { value: p.id, selected: p.id === choice }, p.name)));
    if (list.length === 1) choice = list[0].id;
    picker.value = choice;
    picker.hidden = list.length === 0;
    reportBtn.hidden = addBtn.hidden = list.length === 0;
  }

  // ---- data
  async function load(force) {
    loading = true; loadError = null; paint();
    try {
      if (force) await loadRefData({ force: true });
      const from = addDays(todayISO(), -30);
      const owned = projectsHere();
      const [, , mine] = await Promise.all([
        Promise.all(owned.map((p) => loadProjectTasks(p.id))),
        Promise.all(owned.map((p) => loadProjectDone(p.id, from))),
        loadAssignedByMe()
      ]);
      handed = mine;
    } catch (err) { loadError = err; }
    loading = false;
    paint();
  }

  const scopeIds = () => (choice ? [choice] : projectsHere().map((p) => p.id));
  const inScope = (t) => scopeIds().includes(t.projectId);

  function paint() {
    drawPicker();
    clear(body);
    if (loading) { body.append(spinner('Loading projects')); return; }
    if (loadError) {
      body.append(emptyState('Could not load projects', errorMessage(loadError),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => load(true) }, 'Try again')));
      return;
    }
    const today = todayISO();
    const from = addDays(today, -30);
    const all = [...state.tasks.values()].filter((t) => !t.archived && inScope(t));
    const open = all.filter((t) => OPEN_CATEGORIES.includes(t.statusCategory));
    const finished = all.filter((t) => t.statusCategory === 'done' && (t.completedDate || '') >= from);
    const toReview = open.filter((t) => t.statusCategory === 'review' && t.ownerId !== user.id);
    const overdue = open.filter((t) => dueState(t).kind === 'overdue');
    const onTime = finished.length ? finished.filter(wasOnTime).length / finished.length : null;

    if (!projectsHere().length) {
      body.append(emptyState('You do not own a project yet',
        'A Team Leader, Manager or the Director can make you the owner of a project in Teams & projects. Tasks you hand to others are listed below.'));
    } else {
      body.append(
        h('div', { class: 'tiles tiles-5' },
          tile('Open tasks', open.length, `${new Set(open.map((t) => t.ownerId)).size} people`),
          tile('Overdue', overdue.length, overdue.length ? 'need attention' : 'all on schedule', overdue.length ? 'bad' : null),
          tile('Waiting for you', toReview.length, 'in review', toReview.length ? 'warn' : null),
          tile('Finished', finished.length, 'last 30 days'),
          tile('On time', pct(onTime), 'of those finished')),
        reviewCard(toReview),
        openCard(open),
        workloadCard(open));
    }
    body.append(handedCard());
  }

  function tile(label, value, note, tone) {
    return h('div', { class: 'tile' + (tone ? ' tile-' + tone : '') },
      h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, String(value)),
      h('span', { class: 'tile-note muted' }, note));
  }

  const openTask = (t) => openTaskPanel({ task: t, onSaved: () => paint() });
  const whoCell = (t) => h('td', null, personTag(userName(t.ownerId)),
    h('div', { class: 'sub muted' }, teamName(t.teamId)));

  // ---- waiting for my review
  async function approve(t) {
    const done = activeStatuses().find((s) => s.category === 'done');
    if (!done) { toast('There is no Completed status set up.', 'error'); return; }
    await requestStatusChange(t, done.id);
  }
  async function sendBack(t) {
    const back = statusById('rework') || activeStatuses().find((s) => s.category === 'active');
    if (!back) { toast('There is no status to send work back to.', 'error'); return; }
    await requestStatusChange(t, back.id);
  }

  function reviewCard(list) {
    const card = h('section', { class: 'card-block' }, h('div', { class: 'row-head' }, h('h2', null, 'Waiting for your review')));
    if (!list.length) { card.append(h('p', { class: 'muted' }, 'Nothing is waiting for you.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Task'), h('th', null, 'Owner'), h('th', null, 'Due'), h('th'))),
      h('tbody', null, list.map((t) => h('tr', { class: 'row', tabindex: 0, onclick: () => openTask(t) },
        h('td', { class: 'cell-title' }, h('div', { class: 'title' }, t.title),
          h('div', { class: 'sub muted' }, projectName(t.projectId))),
        whoCell(t),
        h('td', null, dueLabel(t)),
        h('td', { class: 'actions-cell' },
          h('button', { type: 'button', class: 'btn btn-primary small', onclick: (e) => { e.stopPropagation(); approve(t); } }, 'Approve'),
          ' ',
          h('button', { type: 'button', class: 'btn btn-ghost small', onclick: (e) => { e.stopPropagation(); sendBack(t); } }, 'Send back'))))))));
    return card;
  }

  // ---- all open tasks
  function openCard(open) {
    const people = [...new Set(open.map((t) => t.ownerId))].map((id) => userById(id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    const personSel = select([{ value: '', label: 'Everyone' }, ...people.map((u) => ({ value: u.id, label: u.name }))], personFilter,
      { 'aria-label': 'Filter by person', onchange: () => { personFilter = personSel.value; paint(); } });
    const statusSel = select([{ value: '', label: 'Any status' },
      ...activeStatuses().filter((s) => OPEN_CATEGORIES.includes(s.category)).map((s) => ({ value: s.id, label: s.name }))], statusFilter,
      { 'aria-label': 'Filter by status', onchange: () => { statusFilter = statusSel.value; paint(); } });
    const rows = open.filter((t) => (!personFilter || t.ownerId === personFilter) && (!statusFilter || t.status === statusFilter))
      .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    const showProject = scopeIds().length > 1;
    const card = h('section', { class: 'card-block' },
      h('div', { class: 'row-head' }, h('h2', null, `Open tasks (${rows.length})`),
        h('div', { class: 'toolbar' }, personSel, statusSel)));
    if (!rows.length) { card.append(h('p', { class: 'muted' }, 'No open tasks match.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Task'), h('th', null, 'Owner'), h('th', null, 'Status'),
        h('th', null, 'Priority'), h('th', null, 'Due'))),
      h('tbody', null, rows.map((t) => h('tr', {
        class: 'row' + (dueState(t).kind === 'overdue' ? ' row-overdue' : ''), tabindex: 0, onclick: () => openTask(t),
        onkeydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'TR') openTask(t); }
      },
        h('td', { class: 'cell-title' }, h('div', { class: 'title' }, t.title),
          h('div', { class: 'sub muted' }, [showProject && projectName(t.projectId), t.statusNote && `“${t.statusNote}”`].filter(Boolean).join(' · '))),
        whoCell(t),
        h('td', null, statusChip(statusById(t.status))),
        h('td', null, priorityChip(t.priority)),
        h('td', null, dueLabel(t))))))));
    return card;
  }

  // ---- who is carrying what
  function workloadCard(open) {
    const byPerson = new Map();
    for (const t of open) {
      const row = byPerson.get(t.ownerId) || { onTrack: 0, overdue: 0 };
      if (dueState(t).kind === 'overdue') row.overdue++; else row.onTrack++;
      byPerson.set(t.ownerId, row);
    }
    const rows = [...byPerson].map(([id, r]) => ({
      label: userName(id), parts: [
        { value: r.onTrack, color: 'var(--viz-1)', name: 'On track' },
        { value: r.overdue, color: 'var(--viz-2)', name: 'Overdue' }]
    })).sort((a, b) => b.parts[0].value + b.parts[1].value - (a.parts[0].value + a.parts[1].value));
    const card = h('section', { class: 'card-block' }, h('h2', null, 'Who is carrying what'));
    if (!rows.length) { card.append(noData('No open tasks.')); return card; }
    card.append(legend([{ name: 'On track', color: 'var(--viz-1)' }, { name: 'Overdue', color: 'var(--viz-2)' }]),
      stackedHbars({ rows, ariaLabel: 'Open tasks per person in the project' }));
    return card;
  }

  // ---- tasks I handed to others
  function handedCard() {
    const rows = handed.filter((t) => !t.archived).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    const card = h('section', { class: 'card-block' },
      h('div', { class: 'row-head' }, h('h2', null, `Handed to others (${rows.length})`)));
    if (!rows.length) { card.append(h('p', { class: 'muted' }, 'Open tasks you created for someone else will show here.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Task'), h('th', null, 'Given to'), h('th', null, 'Status'), h('th', null, 'Due'))),
      h('tbody', null, rows.map((t) => h('tr', {
        class: 'row' + (dueState(t).kind === 'overdue' ? ' row-overdue' : ''), tabindex: 0, onclick: () => openTask(t),
        onkeydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'TR') openTask(t); }
      },
        h('td', { class: 'cell-title' }, h('div', { class: 'title' }, t.title),
          h('div', { class: 'sub muted' }, projectName(t.projectId))),
        whoCell(t),
        h('td', null, statusChip(statusById(t.status))),
        h('td', null, dueLabel(t))))))));
    return card;
  }

  const onTasks = () => { if (!loading) paint(); };
  const onRef = () => { if (!loading) paint(); };
  bus.addEventListener('tasks', onTasks);
  bus.addEventListener('ref', onRef);
  load(false);
  return () => { bus.removeEventListener('tasks', onTasks); bus.removeEventListener('ref', onRef); };
}
