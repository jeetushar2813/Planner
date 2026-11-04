// Home: your numbers, what is coming up, and (for leaders) a team overview on demand.

import { h, clear, todayISO, fmtDateLong, pluralize } from '../core/util.js';
import { OPEN_CATEGORIES } from '../core/model.js';
import * as perm from '../core/perm.js';
import {
  state, bus, myTeams, userName, statusById, watchMyTasks, loadOpenTasks, seedDefaultStatuses, isDemo
} from '../core/store.js';
import { toast, errorMessage, statusChip, priorityChip, emptyState, spinner } from './components.js';
import { openTaskPanel } from './taskform.js';
import { dueState, dueLabel } from './tasks.js';
import { loadKeyDates } from '../core/store.js';
import { comingUp, whenText, KEY_CATEGORY_LABEL } from '../core/keydates.js';
import { fmtDate } from '../core/util.js';

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function renderHome(container) {
  const user = state.user;
  let unwatch = null;
  let teamLoaded = false;
  let teamLoading = false;

  const setup = h('div');
  const tiles = h('div', { class: 'tiles' });
  const upcoming = h('div', { class: 'upcoming' });
  const keysAhead = h('section', { class: 'card-block keys-ahead', hidden: true });
  const teamCard = h('section', { class: 'card-block' });

  container.append(
    h('div', { class: 'page-head' },
      h('h1', null, `${greeting()}, ${user.name.split(' ')[0]}`),
      h('p', { class: 'muted' }, fmtDateLong(todayISO()))),
    setup, tiles, upcoming, keysAhead, teamCard);

  // ---- first-time setup (Director only)
  function drawSetup() {
    clear(setup);
    const noStatuses = state.ref.statuses.length === 0;
    const noTeams = state.ref.teams.length === 0;
    if (!noStatuses && !noTeams) return;
    if (!perm.isDirector(user)) {
      setup.append(h('div', { class: 'notice' }, 'The workspace is still being set up. The Director needs to add statuses and teams before tasks can be created.'));
      return;
    }
    const seedBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      seedBtn.disabled = true;
      try { await seedDefaultStatuses(); toast('Default statuses created.', 'success'); drawSetup(); }
      catch (err) { toast(errorMessage(err), 'error'); seedBtn.disabled = false; }
    } }, 'Set up default statuses');
    setup.append(h('section', { class: 'card-block setup' },
      h('h2', null, 'Set up your workspace'),
      h('p', { class: 'muted' }, 'Three quick steps before the team can start. You only do this once.'),
      h('ol', null,
        h('li', null, h('strong', null, 'Statuses. '), noStatuses ? seedBtn : '✓ Done'),
        h('li', null, h('strong', null, 'Teams. '), noTeams ? h('a', { href: '#/teams' }, 'Create your first team') : '✓ Done'),
        h('li', null, h('strong', null, 'People. '), h('a', { href: '#/people' }, 'Add your team members and give each a login')))));
  }

  // ---- numbers and upcoming
  function mine() {
    return [...state.tasks.values()].filter((t) => t.ownerId === user.id && !t.archived && OPEN_CATEGORIES.includes(t.statusCategory));
  }

  function paint() {
    const list = mine();
    const overdue = list.filter((t) => dueState(t).kind === 'overdue').sort(byDue);
    const today = list.filter((t) => dueState(t).kind === 'today').sort(byDue);
    const soon = list.filter((t) => dueState(t).kind === 'soon').sort(byDue);
    const inReview = list.filter((t) => t.statusCategory === 'review');

    clear(tiles).append(
      tile('Open tasks', list.length, 'assigned to you', '#/my'),
      tile('Overdue', overdue.length, overdue.length ? 'need attention' : 'all on time', '#/my', overdue.length ? 'bad' : 'good'),
      tile('Due in 7 days', today.length + soon.length, 'including today', '#/my'),
      tile('In review', inReview.length, 'waiting for a check', '#/my'));

    clear(upcoming).append(
      column('Overdue', overdue, 'Nothing overdue.', 'bad'),
      column('Due today', today, 'Nothing due today.'),
      column('Next 7 days', soon, 'Nothing due this week.'));
  }

  const byDue = (a, b) => (a.dueDate || '').localeCompare(b.dueDate || '');

  function tile(label, value, note, href, tone) {
    return h('a', { class: 'tile' + (tone ? ' tile-' + tone : ''), href },
      h('span', { class: 'tile-label' }, label),
      h('span', { class: 'tile-value' }, String(value)),
      h('span', { class: 'tile-note muted' }, note));
  }

  function column(title, tasks, emptyText, tone) {
    return h('section', { class: 'card-block upcoming-col' },
      h('h2', null, title, h('span', { class: 'count' + (tone === 'bad' && tasks.length ? ' count-bad' : '') }, tasks.length)),
      tasks.length
        ? h('ul', { class: 'task-list' }, tasks.slice(0, 8).map((t) =>
          h('li', null, h('button', { type: 'button', class: 'task-link', onclick: () => openTaskPanel({ task: t, onSaved: paint }) },
            h('span', { class: 'task-link-title' }, t.title),
            h('span', { class: 'task-link-meta' }, dueLabel(t), statusChip(statusById(t.status)), priorityChip(t.priority))))))
        : h('p', { class: 'muted' }, emptyText),
      tasks.length > 8 ? h('p', null, h('a', { href: '#/my' }, `See all ${tasks.length}`)) : null);
  }

  // ---- key dates ahead (Semester starts, Exam week...). One cached read, shared with the calendar and the bell.
  function drawKeys(list) {
    const items = comingUp(list, todayISO(), 30).slice(0, 8);
    keysAhead.hidden = items.length === 0;
    clear(keysAhead);
    if (!items.length) return;
    keysAhead.append(
      h('h2', null, '★ Key dates ahead', h('span', { class: 'count' }, items.length)),
      h('ul', null, items.map((o) => h('li', null,
        h('span', { class: 'key-when' }, whenText(o)),
        h('a', { href: '#/calendar' }, o.kd.title),
        h('span', { class: 'muted' }, `${fmtDate(o.startDate)}${o.endDate !== o.startDate ? ' to ' + fmtDate(o.endDate) : ''} · ${KEY_CATEGORY_LABEL[o.kd.category] || 'Other'}`)))));
  }
  const loadKeys = () => loadKeyDates().then(drawKeys).catch(() => { /* key dates are optional on Home */ });

  // ---- team overview, loaded only when asked (keeps reads low)
  function drawTeam() {
    clear(teamCard);
    if (!perm.isDeputyUp(user)) return;
    teamCard.append(h('h2', null, 'Team overview'));
    if (teamLoading) { teamCard.append(spinner('Loading team')); return; }
    if (!teamLoaded) {
      teamCard.append(
        h('p', { class: 'muted' }, 'Open work, overdue items and reviews waiting across your team(s). Loaded on request to keep Firebase reads low.'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: loadTeam }, 'Load team overview'));
      return;
    }
    const teams = myTeams();
    const all = [...state.tasks.values()].filter((t) => !t.archived && OPEN_CATEGORIES.includes(t.statusCategory) && perm.canViewTask(user, t));
    const rows = teams.map((team) => {
      const ts = all.filter((t) => t.teamId === team.id);
      return h('tr', null,
        h('td', null, h('strong', null, team.name)),
        h('td', { class: 'num' }, ts.length),
        h('td', { class: 'num' }, bad(ts.filter((t) => dueState(t).kind === 'overdue').length)),
        h('td', { class: 'num' }, ts.filter((t) => t.statusCategory === 'review').length),
        h('td', { class: 'num' }, ts.filter((t) => t.statusCategory === 'paused').length));
    });
    const people = new Map();
    for (const t of all) {
      const p = people.get(t.ownerId) || { open: 0, overdue: 0 };
      p.open += 1; if (dueState(t).kind === 'overdue') p.overdue += 1;
      people.set(t.ownerId, p);
    }
    const personRows = [...people.entries()].sort((a, b) => b[1].overdue - a[1].overdue || b[1].open - a[1].open).map(([id, p]) =>
      h('tr', null, h('td', null, userName(id)), h('td', { class: 'num' }, p.open), h('td', { class: 'num' }, bad(p.overdue))));
    teamCard.append(
      h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
        h('thead', null, h('tr', null, h('th', null, 'Team'), h('th', { class: 'num' }, 'Open'), h('th', { class: 'num' }, 'Overdue'), h('th', { class: 'num' }, 'In review'), h('th', { class: 'num' }, 'On hold / blocked'))),
        h('tbody', null, rows))),
      h('h3', null, 'By person'),
      personRows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
          h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', { class: 'num' }, 'Open'), h('th', { class: 'num' }, 'Overdue'))),
          h('tbody', null, personRows)))
        : h('p', { class: 'muted' }, 'No open tasks.'),
      h('p', null, h('a', { href: '#/team' }, 'Open team tasks')));
  }

  const bad = (n) => (n ? h('span', { class: 'due due-overdue' }, String(n)) : '0');

  async function loadTeam() {
    teamLoading = true; drawTeam();
    try {
      if (perm.isDirector(user)) await loadOpenTasks();
      else for (const team of myTeams()) await loadOpenTasks({ teamId: team.id });
      teamLoaded = true;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    teamLoading = false; drawTeam();
  }

  // ---- go
  drawSetup();
  paint();
  drawTeam();
  loadKeys();
  const onKeys = () => loadKeys();
  bus.addEventListener('keydates', onKeys);
  unwatch = watchMyTasks(() => { paint(); if (teamLoaded) drawTeam(); }, (err) => {
    clear(upcoming).append(emptyState('Could not load your tasks', errorMessage(err)));
  });
  const onTasks = () => { paint(); if (teamLoaded) drawTeam(); };
  bus.addEventListener('tasks', onTasks);

  return () => { if (unwatch) unwatch(); bus.removeEventListener('tasks', onTasks); bus.removeEventListener('keydates', onKeys); };
}

export { isDemo, pluralize };
