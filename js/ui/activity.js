// Activity: who changed what and when, plus a usage overview (who has signed in recently).
// Director sees everything, Managers and Team Leaders see their team(s) one at a time,
// everyone else sees only their own activity. The Security Rules enforce this.

import { h, add, clear, fmtDateTime, fmtAgo, todayISO, addDays, toDate } from '../core/util.js';
import { ACTION_LABEL, ROLE_LABEL, roleLabel } from '../core/model.js';
import * as perm from '../core/perm.js';
import { state, myTeams, loadLog, loadRefData } from '../core/store.js';
import { fieldLabel } from '../core/log.js';
import { toast, errorMessage, emptyState, spinner, select } from './components.js';

const freshMemory = () => ({ teamId: null, actorId: '', fromISO: addDays(todayISO(), -7), toISO: '', hideLogins: false });
let memory = freshMemory();
let memoryUser = null;

export function renderActivity(container) {
  const user = state.user;
  if (memoryUser !== user.id) { memory = freshMemory(); memoryUser = user.id; } // never carry filters over to another person
  const f = memory;
  const leaderView = perm.isLeaderUp(user);
  const teams = myTeams();
  if (leaderView && !perm.isDirector(user)) {
    if (!f.teamId || !teams.some((t) => t.id === f.teamId)) f.teamId = teams[0]?.id || '';
  } else if (!leaderView) f.teamId = '';
  else if (f.teamId === null) f.teamId = '';
  if (!leaderView) f.actorId = user.id;

  let rows = [];
  let cursor = null;
  let exhausted = false;
  let loading = false;
  let error = null;

  const usageBox = h('section', { class: 'card-block' });
  const filters = h('div', { class: 'toolbar' });
  const list = h('div');
  const more = h('div', { class: 'load-more' });

  add(container,
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'Activity'),
        h('p', { class: 'muted' }, perm.isDirector(user) ? 'Every change by everyone. Entries can never be edited or deleted.'
          : leaderView ? 'Changes in your team. Entries can never be edited or deleted.'
            : 'Your own activity. Entries can never be edited or deleted.')),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: refresh }, 'Refresh'))),
    leaderView ? usageBox : null, filters, list, more);

  // ---- who is using the tool (no extra reads: uses the people list already loaded)
  function drawUsage() {
    if (!leaderView) return;
    clear(usageBox);
    const scope = state.ref.users.filter((u) => u.active !== false && u.id !== user.id
      && (perm.isDirector(user) ? (!f.teamId || (u.teamIds || []).includes(f.teamId)) : (u.teamIds || []).some((id) => teams.some((t) => t.id === id) && (!f.teamId || id === f.teamId))));
    usageBox.append(h('h2', null, 'Who is using the tool'),
      h('p', { class: 'muted' }, 'Based on each person’s last sign-in. Refresh to update.'));
    if (!scope.length) { usageBox.append(h('p', { class: 'muted' }, 'No other people in this view.')); return; }
    const level = (u) => {
      const d = toDate(u.lastLoginAt);
      if (!d) return { text: 'Never signed in', cls: 'bad', rank: 0 };
      const days = (Date.now() - d.getTime()) / 86400000;
      if (days < 1) return { text: 'Active today', cls: 'good', rank: 3 };
      if (days < 7) return { text: 'This week', cls: 'ok', rank: 2 };
      return { text: 'No sign-in for 7+ days', cls: 'bad', rank: 1 };
    };
    const sorted = [...scope].sort((a, b) => level(a).rank - level(b).rank || a.name.localeCompare(b.name));
    usageBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Role'), h('th', null, 'Last sign-in'), h('th', null, 'Usage'))),
      h('tbody', null, sorted.map((u) => h('tr', null,
        h('td', null, u.name), h('td', null, roleLabel(u)),
        h('td', null, u.lastLoginAt ? fmtAgo(u.lastLoginAt) : '–'),
        h('td', null, h('span', { class: 'chip usage-' + level(u).cls }, level(u).text))))))));
  }

  function drawFilters() {
    clear(filters);
    if (leaderView) {
      filters.append(select([
        ...(perm.isDirector(user) ? [{ value: '', label: 'All teams' }] : []),
        ...teams.map((t) => ({ value: t.id, label: t.name }))
      ], f.teamId, { 'aria-label': 'Team', onchange: (e) => { f.teamId = e.target.value; f.actorId = ''; drawFilters(); drawUsage(); reload(); } }));
      const people = state.ref.users.filter((u) => !f.teamId || (u.teamIds || []).includes(f.teamId));
      filters.append(select([{ value: '', label: 'Everyone' }, ...people.map((u) => ({ value: u.id, label: u.name }))], f.actorId,
        { 'aria-label': 'Person', onchange: (e) => { f.actorId = e.target.value; reload(); } }));
    }
    filters.append(
      h('label', { class: 'inline-label' }, 'From ', h('input', { type: 'date', value: f.fromISO, onchange: (e) => { f.fromISO = e.target.value; reload(); } })),
      h('label', { class: 'inline-label' }, 'To ', h('input', { type: 'date', value: f.toISO, onchange: (e) => { f.toISO = e.target.value; reload(); } })),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: f.hideLogins, onchange: (e) => { f.hideLogins = e.target.checked; paint(); } }), ' Hide sign-ins'));
  }

  async function reload() { rows = []; cursor = null; exhausted = false; error = null; await loadMore(); }

  async function refresh() {
    try { await loadRefData({ force: true }); } catch (err) { toast(errorMessage(err), 'error'); }
    drawFilters(); drawUsage(); await reload();
  }

  async function loadMore() {
    if (loading || exhausted) return;
    loading = true; paint();
    try {
      const result = await loadLog({
        teamId: f.teamId || null, actorId: f.actorId || null,
        fromISO: f.fromISO || null, toISO: f.toISO || null, after: cursor
      });
      rows = rows.concat(result.docs);
      cursor = result.cursor;
      if (result.docs.length < 40) exhausted = true;
    } catch (err) { error = err; exhausted = true; }
    loading = false; paint();
  }

  function paint() {
    clear(list); clear(more);
    if (error) { list.append(emptyState('Could not load the log', errorMessage(error))); return; }
    const shown = rows.filter((r) => !(f.hideLogins && r.action === 'auth.login'));
    if (!shown.length && !loading) {
      list.append(emptyState('No activity found', 'Try a wider date range or another person.'));
    } else if (shown.length) {
      list.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks log' },
        h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Details'))),
        h('tbody', null, shown.map(logRow)))));
    }
    if (loading) more.append(spinner('Loading'));
    else if (!exhausted) more.append(h('button', { type: 'button', class: 'btn btn-ghost', onclick: loadMore }, 'Load more'));
    else if (shown.length) more.append(h('p', { class: 'muted' }, 'End of the log for this range.'));
  }

  function logRow(r) {
    const changes = (r.changes || []).map((c) => h('li', null,
      h('strong', null, fieldLabel(c.field)), ': ',
      c.from ? h('span', null, h('span', { class: 'from' }, c.from), ' → ') : null,
      h('span', { class: 'to' }, c.to || 'empty')));
    return h('tr', null,
      h('td', { class: 'nowrap' }, fmtDateTime(r.ts)),
      h('td', null, h('strong', null, r.actorName), h('div', { class: 'sub muted' }, ROLE_LABEL[r.actorRole] || r.actorRole)),
      h('td', null, ACTION_LABEL[r.action] || r.action, r.entityTitle ? h('div', { class: 'sub' }, r.entityTitle) : null),
      h('td', null, changes.length ? h('ul', { class: 'changes' }, changes) : h('span', { class: 'muted' }, '–')));
  }

  drawFilters();
  drawUsage();
  reload();
}
