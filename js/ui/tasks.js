// My Tasks and Team Tasks: one browser with list and board views, filters and sorting.

import { h, clear, todayISO, addDays, daysBetween, fmtDate, debounce } from '../core/util.js';
import { OPEN_CATEGORIES, PRIORITIES, PRIORITY_LABEL, PRIORITY_RANK } from '../core/model.js';
import * as perm from '../core/perm.js';
import { stepsForUser } from '../core/steps.js';
import {
  state, bus, myTeams, teamById, statusById, userName, projectName, activeStatuses,
  watchMyTasks, loadOpenTasks, loadFinished, loadRefData
} from '../core/store.js';
import {
  toast, errorMessage, statusChip, priorityChip, personTag, avatar, emptyState, spinner, select
} from './components.js';
import { openTaskPanel, requestStatusChange } from './taskform.js';

// ----------------------------------------------------------- shared helpers

export function isOpen(task) { return !task.archived && OPEN_CATEGORIES.includes(task.statusCategory); }

// 'overdue' | 'today' | 'soon' (within 7 days) | 'later' | 'none'
export function dueState(task) {
  if (!task.dueDate || !isOpen(task)) return { kind: 'none', days: null };
  const days = daysBetween(todayISO(), task.dueDate);
  if (days < 0) return { kind: 'overdue', days };
  if (days === 0) return { kind: 'today', days };
  if (days <= 7) return { kind: 'soon', days };
  return { kind: 'later', days };
}

export function dueLabel(task) {
  const d = dueState(task);
  if (!task.dueDate) return h('span', { class: 'muted' }, 'No due date');
  const text = fmtDate(task.dueDate);
  if (d.kind === 'overdue') return h('span', { class: 'due due-overdue' }, text, ` · ${-d.days}d late`);
  if (d.kind === 'today') return h('span', { class: 'due due-today' }, 'Today');
  if (d.kind === 'soon') return h('span', { class: 'due due-soon' }, text, d.days === 1 ? ' · tomorrow' : ` · in ${d.days}d`);
  return h('span', { class: 'due' }, text);
}

// "2 steps for you": steps in this task given to the signed-in person or their whole team.
const stepsChip = (t, user) => {
  const n = stepsForUser(t, user).length;
  return n ? h('span', { class: 'chip chip-step steps-for-me', title: 'Steps in this task are waiting for you or your team' }, `${n} step${n === 1 ? '' : 's'} for you`) : null;
};

const checklistProgress = (t) => {
  const items = t.checklist || [];
  return items.length ? `${items.filter((i) => i.done).length}/${items.length}` : '';
};

const SORTS = {
  due: { label: 'Due date', fn: (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] },
  priority: { label: 'Priority', fn: (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') },
  updated: { label: 'Recently updated', fn: (a, b) => (b.updatedAt?.getTime?.() || 0) - (a.updatedAt?.getTime?.() || 0) },
  title: { label: 'Title', fn: (a, b) => a.title.localeCompare(b.title) }
};

// Filter choices are remembered while you move between screens.
const freshMemory = () => ({
  my: { search: '', status: '', priority: '', project: '', sort: 'due', view: 'list', finished: false },
  team: { search: '', status: '', priority: '', project: '', owner: '', sort: 'due', view: 'list', finished: false, teamId: null, stepsForMe: false }
});
let memory = freshMemory();
let memoryUser = null;

// ------------------------------------------------------------- the browser

export function renderMyTasks(container) { return renderBrowser(container, 'my'); }
export function renderTeamTasks(container) { return renderBrowser(container, 'team'); }

function renderBrowser(container, mode) {
  const user = state.user;
  if (memoryUser !== user.id) { memory = freshMemory(); memoryUser = user.id; } // never carry filters over to another person
  const f = memory[mode];
  const isTeam = mode === 'team';
  const teams = myTeams();
  const finishedLoaded = new Set();
  let unwatch = null;
  let loading = false;
  let loadError = null;

  if (isTeam) {
    const valid = f.teamId === '' || teams.some((t) => t.id === f.teamId);
    if (!valid || f.teamId === null) f.teamId = perm.isDirector(user) ? '' : (teams[0]?.id || '');
  }

  // ---- toolbar
  const search = h('input', {
    type: 'search', placeholder: 'Search tasks', value: f.search, 'aria-label': 'Search tasks',
    oninput: debounce(() => { f.search = search.value; paint(); }, 150)
  });
  const teamSelect = isTeam ? select([
    ...(perm.isDirector(user) ? [{ value: '', label: 'All teams' }] : []),
    ...teams.map((t) => ({ value: t.id, label: t.name }))
  ], f.teamId, { 'aria-label': 'Team', onchange: () => { f.teamId = teamSelect.value; f.owner = ''; f.project = ''; drawFilters(); load(); } }) : null;

  const statusSelect = h('select', { 'aria-label': 'Filter by status', onchange: () => { f.status = statusSelect.value; paint(); } });
  const prioritySelect = select([{ value: '', label: 'Any priority' }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))], f.priority,
    { 'aria-label': 'Filter by priority', onchange: () => { f.priority = prioritySelect.value; paint(); } });
  const projectSelect = h('select', { 'aria-label': 'Filter by project', onchange: () => { f.project = projectSelect.value; paint(); } });
  const ownerSelect = isTeam ? h('select', { 'aria-label': 'Filter by owner', onchange: () => { f.owner = ownerSelect.value; paint(); } }) : null;
  const sortSelect = select(Object.entries(SORTS).map(([value, s]) => ({ value, label: 'Sort: ' + s.label })), f.sort,
    { 'aria-label': 'Sort', onchange: () => { f.sort = sortSelect.value; paint(); } });

  const viewToggle = h('div', { class: 'segmented', role: 'group', 'aria-label': 'View' },
    ['list', 'board'].map((v) => h('button', {
      type: 'button', class: f.view === v ? 'active' : '', 'aria-pressed': f.view === v,
      onclick: () => { f.view = v; viewToggle.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); }); paint(); },
      dataset: { v }
    }, v === 'list' ? 'List' : 'Board')));

  const finishedBox = h('input', { type: 'checkbox', checked: f.finished, onchange: async () => {
    f.finished = finishedBox.checked;
    if (f.finished) await loadFinishedTasks();
    paint();
  } });
  const stepsBox = isTeam ? h('input', { type: 'checkbox', checked: f.stepsForMe, onchange: () => { f.stepsForMe = stepsBox.checked; paint(); } }) : null;
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh');
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openTaskPanel({
    defaults: { teamId: isTeam ? f.teamId : undefined, ownerId: isTeam && f.owner ? f.owner : undefined },
    onSaved: () => paint()
  }) }, '+ New task');

  const toolbar = h('div', { class: 'toolbar' },
    isTeam ? teamSelect : null, search, statusSelect, prioritySelect, projectSelect, ownerSelect, sortSelect);
  const toolbar2 = h('div', { class: 'toolbar toolbar-2' },
    viewToggle,
    h('label', { class: 'check' }, finishedBox, ' Show finished (last 30 days)'),
    isTeam ? h('label', { class: 'check', title: 'Only tasks with a checklist step given to you or your team' }, stepsBox, ' Steps for me') : null,
    h('div', { class: 'spacer' }), refreshBtn, newBtn);
  const summary = h('div', { class: 'summary muted' });
  const content = h('div', { class: 'browser-content' });

  container.append(
    h('div', { class: 'page-head' },
      h('h1', null, isTeam ? 'Team tasks' : 'My tasks'),
      h('p', { class: 'muted' }, isTeam
        ? (perm.isMember(user) ? 'Your team’s work. You can see it, but you can only change your own tasks.' : 'Everything open in your team(s).')
        : 'Everything assigned to you that is not finished.')),
    toolbar, toolbar2, summary, content);

  function drawFilters() {
    // Status and project options depend on what exists right now.
    clear(statusSelect).append(
      h('option', { value: '' }, 'Any status'),
      ...activeStatuses().map((s) => h('option', { value: s.id, selected: s.id === f.status }, s.name)));
    statusSelect.value = f.status;
    const visibleTeamIds = new Set(teams.map((t) => t.id));
    const projects = state.ref.projects.filter((p) => p.active !== false
      && (isTeam && f.teamId ? p.teamId === f.teamId : visibleTeamIds.has(p.teamId)));
    clear(projectSelect).append(
      h('option', { value: '' }, 'Any project'),
      ...projects.map((p) => h('option', { value: p.id, selected: p.id === f.project }, p.name)));
    projectSelect.value = f.project;
    if (ownerSelect) {
      const people = state.ref.users.filter((u) => u.active !== false
        && (f.teamId ? (u.teamIds || []).includes(f.teamId) : true));
      clear(ownerSelect).append(
        h('option', { value: '' }, 'Any owner'),
        ...people.map((u) => h('option', { value: u.id, selected: u.id === f.owner }, u.name)));
      ownerSelect.value = f.owner;
    }
  }

  // ---- data
  async function load(force = false) {
    loading = true; loadError = null; paint();
    try {
      if (force) {
        await loadRefData({ force: true });
        drawFilters();
      }
      if (isTeam) {
        await loadOpenTasks({ teamId: f.teamId || null });
        finishedLoaded.clear();
        if (f.finished) await loadFinishedTasks();
      } else if (!unwatch) {
        await new Promise((resolve) => {
          let first = true;
          unwatch = watchMyTasks(() => { if (first) { first = false; resolve(); } else paint(); },
            (err) => { loadError = err; resolve(); });
        });
        if (f.finished) await loadFinishedTasks();
      } else if (force && f.finished) {
        finishedLoaded.clear();
        await loadFinishedTasks();
      }
    } catch (err) {
      loadError = err;
    }
    loading = false;
    paint();
  }

  async function loadFinishedTasks() {
    const key = isTeam ? 'team:' + f.teamId : 'me';
    if (finishedLoaded.has(key)) return;
    try {
      await loadFinished({
        teamId: isTeam ? (f.teamId || null) : null,
        ownerId: isTeam ? null : user.id,
        fromISO: addDays(todayISO(), -30)
      });
      finishedLoaded.add(key);
    } catch (err) {
      f.finished = false; finishedBox.checked = false;
      toast(errorMessage(err), 'error');
    }
  }

  // ---- which tasks are on screen
  function visibleTasks() {
    const fromISO = addDays(todayISO(), -30);
    const q = f.search.trim().toLowerCase();
    return [...state.tasks.values()].filter((t) => {
      if (t.archived) return false;
      if (isTeam) {
        if (f.teamId ? t.teamId !== f.teamId : !perm.canViewTask(user, t)) return false;
        if (f.owner && t.ownerId !== f.owner) return false;
        if (f.stepsForMe && !stepsForUser(t, user).length) return false;
      } else if (t.ownerId !== user.id) return false;
      const open = OPEN_CATEGORIES.includes(t.statusCategory);
      const recentlyDone = t.statusCategory === 'done' && f.finished && (t.completedDate || '') >= fromISO;
      if (!open && !recentlyDone) return false;
      if (f.status && t.status !== f.status) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.project && t.projectId !== f.project) return false;
      if (q && !(`${t.title} ${t.description || ''} ${userName(t.ownerId)} ${projectName(t.projectId)}`.toLowerCase().includes(q))) return false;
      return true;
    }).sort(SORTS[f.sort].fn);
  }

  function paint() {
    drawFilters();
    clear(content);
    if (loading) { clear(summary); content.append(spinner('Loading tasks')); return; }
    if (loadError) {
      clear(summary);
      content.append(emptyState('Could not load tasks', errorMessage(loadError),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => load(true) }, 'Try again')));
      return;
    }
    const list = visibleTasks();
    const overdue = list.filter((t) => dueState(t).kind === 'overdue').length;
    summary.textContent = `${list.length} task${list.length === 1 ? '' : 's'}${overdue ? ` · ${overdue} overdue` : ''}`;
    if (!list.length) {
      const filtered = f.search || f.status || f.priority || f.project || f.owner;
      content.append(emptyState(filtered ? 'No tasks match these filters' : (isTeam ? 'No open tasks for this team' : 'Nothing assigned to you'),
        filtered ? 'Clear a filter to see more.' : 'Use "New task" to add one.'));
      return;
    }
    content.append(f.view === 'board' ? board(list) : table(list));
  }

  // ---- list view
  function statusCell(task) {
    const team = teamById(task.teamId);
    const allowed = perm.allowedStatuses(user, task, activeStatuses(), team);
    if (!allowed.length) return statusChip(statusById(task.status));
    const options = allowed.some((s) => s.id === task.status) ? allowed : [statusById(task.status), ...allowed].filter(Boolean);
    const sel = h('select', {
      class: 'status-select', 'aria-label': `Status of ${task.title}`,
      style: { '--chip': statusById(task.status)?.color || '#64748b' },
      onclick: (e) => e.stopPropagation(),
      onchange: async (e) => {
        e.stopPropagation();
        const result = await requestStatusChange(task, sel.value);
        if (!result) sel.value = task.status;
      }
    }, options.map((s) => h('option', { value: s.id, selected: s.id === task.status }, s.name)));
    return sel;
  }

  function table(list) {
    const rows = list.map((t) => {
      const open = () => openTaskPanel({ task: t, onSaved: () => paint() });
      return h('tr', {
        class: 'row' + (dueState(t).kind === 'overdue' ? ' row-overdue' : ''),
        tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'TR') open(); }
      },
        h('td', { class: 'cell-title' },
          h('div', { class: 'title' }, t.title, stepsChip(t, user)),
          h('div', { class: 'sub muted' },
            [projectName(t.projectId), checklistProgress(t) && `☑ ${checklistProgress(t)}`, t.statusNote && `“${t.statusNote}”`]
              .filter(Boolean).join(' · '))),
        isTeam ? h('td', null, personTag(userName(t.ownerId))) : null,
        h('td', null, statusCell(t)),
        h('td', null, priorityChip(t.priority)),
        h('td', null, dueLabel(t)),
        h('td', { class: 'num muted' }, t.estimateHours ? `${t.estimateHours}h` : ''));
    });
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'tasks' },
        h('thead', null, h('tr', null,
          h('th', null, 'Task'), isTeam ? h('th', null, 'Owner') : null,
          h('th', null, 'Status'), h('th', null, 'Priority'), h('th', null, 'Due'), h('th', { class: 'num' }, 'Est.'))),
        h('tbody', null, rows)));
  }

  // ---- board view
  function board(list) {
    const columns = activeStatuses().filter((s) => OPEN_CATEGORIES.includes(s.category) || (f.finished && s.category === 'done'));
    const wrap = h('div', { class: 'board' });
    for (const status of columns) {
      const cards = list.filter((t) => t.status === status.id);
      const col = h('section', { class: 'column', 'aria-label': status.name, dataset: { status: status.id } },
        h('header', null, statusChip(status), h('span', { class: 'count' }, cards.length)),
        h('div', { class: 'cards' }, cards.map((t) => card(t))));
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('drop');
        const task = state.tasks.get(e.dataTransfer.getData('text/plain'));
        if (!task || task.status === status.id) return;
        const allowed = perm.allowedStatuses(user, task, activeStatuses(), teamById(task.teamId));
        if (!allowed.some((s) => s.id === status.id)) {
          toast(`You cannot move this task to ${status.name}.`, 'error');
          return;
        }
        await requestStatusChange(task, status.id);
        paint();
      });
      wrap.append(col);
    }
    return wrap;
  }

  function card(t) {
    const canDrag = perm.canChangeStatus(user, t, activeStatuses(), teamById(t.teamId));
    const el = h('article', {
      class: 'card' + (dueState(t).kind === 'overdue' ? ' card-overdue' : ''),
      draggable: canDrag, tabindex: 0,
      onclick: () => openTaskPanel({ task: t, onSaved: () => paint() }),
      onkeydown: (e) => { if (e.key === 'Enter') openTaskPanel({ task: t, onSaved: () => paint() }); }
    },
      h('div', { class: 'card-title' }, t.title, stepsChip(t, user)),
      h('div', { class: 'card-meta' }, priorityChip(t.priority), dueLabel(t)),
      h('div', { class: 'card-foot' },
        avatar(userName(t.ownerId), 22), h('span', { class: 'muted' }, userName(t.ownerId).split(' ')[0]),
        checklistProgress(t) ? h('span', { class: 'muted' }, `☑ ${checklistProgress(t)}`) : null));
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  }

  // ---- go
  const onTasks = () => paint();
  bus.addEventListener('tasks', onTasks);
  drawFilters();
  load();

  return () => {
    bus.removeEventListener('tasks', onTasks);
    if (unwatch) unwatch();
  };
}
