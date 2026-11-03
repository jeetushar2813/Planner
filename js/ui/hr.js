// HR: the yearly leave entitlements, acknowledging approved leave, and everyone's leave balance.
// Only people with the HR switch on their account (People page) reach this page.
//
// HR does not approve anything. Leave is approved by the Team Leader and then the Director; HR
// is told afterwards and acknowledges it. The acknowledgement never blocks or changes a leave.

import { h, add, clear, todayISO, fmtDate, fmtAgo } from '../core/util.js';
import { LEAVE_TYPE_LABEL, ENTITLED_TYPES } from '../core/model.js';
import * as perm from '../core/perm.js';
import { groupLeaves, balances, dayText, parseDays, daysInYear } from '../core/entitlement.js';
import { buildXlsx, XLSX_MIME } from '../core/xlsx.js';
import {
  state, teamName, userById, userName, loadLeaveYear, loadPolicy, savePolicy, acknowledgeLeave,
  loadHolidays, syncHrQueue
} from '../core/store.js';
import { toast, errorMessage, field, select, emptyState, spinner, avatar } from './components.js';

const rangeText = (g) => (g.startDate === g.endDate ? fmtDate(g.startDate) : `${fmtDate(g.startDate)} to ${fmtDate(g.endDate)}`);
const dayWord = (n) => `${dayText(n)} day${n === 1 ? '' : 's'}`;

export function renderHr(container) {
  const user = state.user;
  const thisYear = Number(todayISO().slice(0, 4));
  let year = thisYear;
  let tab = 'ack';
  let leaves = [], holidays = [], policy = null;
  let loading = true, failure = null;
  let teamFilter = '';
  // What is typed on the Entitlements tab (kept as text while typing).
  let draft = null;

  const body = h('div');
  const tabBar = h('div', { class: 'segmented', role: 'group', 'aria-label': 'HR sections' });
  const yearSelect = select([thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: y, label: String(y) })), year,
    { 'aria-label': 'Year', onchange: (e) => { year = Number(e.target.value); draft = null; load(); } });

  add(container,
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'HR leave'),
        h('p', { class: 'muted' }, 'Set the yearly leave days, see everyone’s balance, and acknowledge approved leave. Leave is approved by the Team Leader and the Director; your acknowledgement is a record only.')),
      h('div', { class: 'head-actions' }, yearSelect,
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh'))),
    tabBar, body);

  async function load(force = false) {
    loading = true; failure = null; paint();
    try {
      [leaves, holidays, policy] = await Promise.all([loadLeaveYear(year), loadHolidays(`${year}-01-01`), loadPolicy(year, { force })]);
      syncHrQueue(leaves, year);
    } catch (err) { failure = err; }
    loading = false; paint();
  }

  const groups = () => groupLeaves(leaves);
  const waiting = () => groups().filter((g) => g.waitingForHr).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const personOf = (g) => userById(g.userId) || { id: g.userId, teamIds: g.teamIds };
  const daysOf = (g) => daysInYear(g, personOf(g), holidays, year);

  function drawTabs() {
    clear(tabBar);
    const n = waiting().length;
    for (const [id, label] of [['ack', `To acknowledge${n ? ` (${n})` : ''}`], ['bal', 'Balances'], ['ent', 'Entitlements']]) {
      tabBar.append(h('button', {
        type: 'button', class: tab === id ? 'active' : '', 'aria-pressed': tab === id,
        onclick: () => { tab = id; paint(); }
      }, label));
    }
  }

  function paint() {
    drawTabs();
    clear(body);
    if (loading) { body.append(spinner('Loading leave')); return; }
    if (failure) { body.append(emptyState('Could not load', errorMessage(failure))); return; }
    if (!policy) {
      body.append(h('p', { class: 'notice' }, `Leave entitlements for ${year} have not been set yet. People see no balance until you set them in the Entitlements tab.`));
    }
    body.append(tab === 'ack' ? ackTab() : tab === 'bal' ? balanceTab() : entitlementTab());
  }

  // ------------------------------------------------------- to acknowledge
  function ackTab() {
    const list = waiting();
    const done = groups().filter((g) => g.status === 'approved' && !g.waitingForHr)
      .sort((a, b) => ackTime(b) - ackTime(a)).slice(0, 25);
    const wrap = h('div');

    const card = h('section', { class: 'card-block' },
      h('div', { class: 'row-head' },
        h('h2', null, 'Approved leave to acknowledge', h('span', { class: 'count' + (list.length ? ' count-bad' : '') }, list.length)),
        list.length ? h('button', { type: 'button', class: 'btn btn-primary small', onclick: () => ack(list) }, `Acknowledge all (${list.length})`) : null),
      h('p', { class: 'muted small' }, 'These are already approved by the Team Leader and the Director. Acknowledging tells everyone HR has taken note.'));
    if (!list.length) card.append(h('p', { class: 'muted' }, 'Nothing is waiting for you.'));
    else card.append(table(['Person', 'Leave', 'Dates', 'Approved by', ''], list.map((g) => h('tr', null,
      personCell(g),
      h('td', null, LEAVE_TYPE_LABEL[g.type]),
      h('td', null, rangeText(g) + (g.half !== 'full' ? ` (${g.half === 'am' ? 'morning' : 'afternoon'})` : ''), h('div', { class: 'sub muted' }, dayWord(daysOf(g)))),
      h('td', null, approvers(g)),
      h('td', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => ack([g]) }, 'Acknowledge'))))));
    wrap.append(card);

    if (done.length) {
      wrap.append(h('section', { class: 'card-block' }, h('h2', null, 'Recently acknowledged'),
        table(['Person', 'Leave', 'Dates', 'Acknowledged'], done.map((g) => h('tr', null,
          personCell(g),
          h('td', null, LEAVE_TYPE_LABEL[g.type]),
          h('td', null, rangeText(g)),
          h('td', null, ackText(g)))))));
    }
    return wrap;
  }

  const ackDoc = (g) => g.docs.find((d) => d.hrAckAt);
  const ackTime = (g) => { const d = ackDoc(g); const t = d && (d.hrAckAt?.getTime ? d.hrAckAt.getTime() : new Date(d.hrAckAt).getTime()); return t || 0; };
  const ackText = (g) => { const d = ackDoc(g); return d ? `${userName(d.hrAckBy)}, ${fmtAgo(d.hrAckAt)}` : ''; };
  const approvers = (g) => {
    const d = g.docs.find((x) => x.status === 'approved') || g.docs[0];
    return h('span', null,
      d.leaderBy ? `Team Leader: ${userName(d.leaderBy)}` : 'Team Leader step skipped',
      h('div', { class: 'sub muted' }, d.decidedBy ? `Director: ${userName(d.decidedBy)}${d.decidedAt ? ', ' + fmtAgo(d.decidedAt) : ''}` : ''));
  };
  const personCell = (g) => h('td', null,
    h('span', { class: 'person' }, avatar(g.userName, 22), h('span', null, g.userName)),
    h('div', { class: 'sub muted' }, g.teamIds.map(teamName).join(', ')));

  async function ack(list) {
    try {
      const n = await acknowledgeLeave(list);
      syncHrQueue(leaves, year);
      toast(n ? `Acknowledged ${list.length === 1 ? 'the leave' : list.length + ' leave requests'}.` : 'Nothing to acknowledge.', 'success');
    } catch (err) { toast(errorMessage(err), 'error'); }
    paint();
  }

  function table(heads, rows) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, heads.map((x) => h('th', null, x)))), h('tbody', null, rows)));
  }

  // --------------------------------------------------------------- balances
  function peopleForBalance() {
    return state.ref.users.filter((u) => u.active !== false && (u.teamIds || []).length
      && (!teamFilter || u.teamIds.includes(teamFilter)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function balanceTab() {
    const rows = balances({ people: peopleForBalance(), leaves, policy, holidays, year });
    const card = h('section', { class: 'card-block' },
      h('div', { class: 'row-head' },
        h('h2', null, `Leave balance ${year}`),
        h('div', { class: 'head-actions' },
          select([{ value: '', label: 'All teams' }, ...state.ref.teams.filter((t) => t.active !== false).map((t) => ({ value: t.id, label: t.name }))], teamFilter,
            { 'aria-label': 'Team', onchange: (e) => { teamFilter = e.target.value; paint(); } }),
          h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => exportExcel(rows) }, 'Download Excel'))),
      h('p', { class: 'muted small' }, 'Each cell shows days left. Underneath: taken (approved), and waiting (not fully approved yet), out of the days given.'));
    if (!rows.length) { card.append(h('p', { class: 'muted' }, 'Nobody to show.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact balance-table' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), ENTITLED_TYPES.map((t) => h('th', { class: 'num' }, LEAVE_TYPE_LABEL[t].replace(' leave', ''))))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, h('span', { class: 'person' }, avatar(r.person.name, 22), h('span', null, r.person.name)),
          h('div', { class: 'sub muted' }, (r.person.teamIds || []).map(teamName).join(', ') + (policy?.overrides?.[r.person.id] ? ' · has an exception' : ''))),
        ENTITLED_TYPES.map((t) => {
          const b = r.byType[t];
          if (b.entitled === null) return h('td', { class: 'num muted' }, '–');
          return h('td', { class: 'num' }, h('strong', { class: b.left < 0 ? 'neg' : '' }, dayText(b.left)),
            h('div', { class: 'sub muted' }, `${dayText(b.used)} taken${b.pending ? ` + ${dayText(b.pending)} waiting` : ''} of ${dayText(b.entitled)}`));
        })))))));
    return card;
  }

  function exportExcel(rows) {
    try {
      const head = (v) => ({ v, s: 'head' });
      const sheetRows = [
        [{ v: `Leave balances ${year}`, s: 'title' }],
        [`Prepared ${todayISO()} by ${user.name}`],
        [],
        [head('Person'), head('Team'), ...ENTITLED_TYPES.flatMap((t) => ['Entitled', 'Taken', 'Waiting', 'Left'].map((k) => head(`${LEAVE_TYPE_LABEL[t]}: ${k}`)))],
        ...rows.map((r) => [r.person.name, (r.person.teamIds || []).map(teamName).join(', '),
          ...ENTITLED_TYPES.flatMap((t) => { const b = r.byType[t]; return [b.entitled, b.entitled === null ? null : b.used, b.entitled === null ? null : b.pending, b.left].map((v) => (v === null ? null : { v, s: 'dec' })); })])
      ];
      const bytes = buildXlsx([{ name: `Balances ${year}`, rows: sheetRows, header: 3, widths: [24, 22, ...ENTITLED_TYPES.flatMap(() => [10, 10, 10, 10])] }]);
      const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
      const a = h('a', { href: url, download: `leave-balances-${year}.xlsx` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Excel file downloaded.', 'success');
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  // ----------------------------------------------------------- entitlements
  const asText = (v) => (typeof v === 'number' ? String(v) : '');
  function startDraft() {
    draft = {
      days: Object.fromEntries(ENTITLED_TYPES.map((t) => [t, asText(policy?.days?.[t])])),
      overrides: Object.fromEntries(Object.entries(policy?.overrides || {}).map(([id, o]) => [id, Object.fromEntries(ENTITLED_TYPES.map((t) => [t, asText(o[t])]))]))
    };
  }

  function entitlementTab() {
    if (!draft) startDraft();
    const wrap = h('div');
    const dayInput = (value, onInput, placeholder = 'not set', label = '') => h('input', {
      type: 'text', inputmode: 'decimal', value, placeholder, class: 'days-input', 'aria-label': label,
      oninput: (e) => onInput(e.target.value)
    });

    const company = h('section', { class: 'card-block' },
      h('div', { class: 'row-head' },
        h('h2', null, `Days everyone gets in ${year}`),
        h('div', { class: 'head-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost small', onclick: copyPrevious }, `Copy from ${year - 1}`))),
      h('p', { class: 'muted small' }, 'Leave a kind empty to leave it unlimited and untracked. Half days are allowed (for example 7.5).'),
      h('div', { class: 'ent-grid' }, ENTITLED_TYPES.map((t) => field(LEAVE_TYPE_LABEL[t],
        dayInput(draft.days[t], (v) => { draft.days[t] = v; }, 'not set', LEAVE_TYPE_LABEL[t])))));
    wrap.append(company);

    const ex = h('section', { class: 'card-block' },
      h('h2', null, 'Exceptions for named people'),
      h('p', { class: 'muted small' }, 'Use this when someone gets a different number (for example longer service). Only fill the kinds that differ; an empty box means the days above.'));
    const ids = Object.keys(draft.overrides);
    if (ids.length) {
      ex.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
        h('thead', null, h('tr', null, h('th', null, 'Person'), ENTITLED_TYPES.map((t) => h('th', { class: 'num' }, LEAVE_TYPE_LABEL[t].replace(' leave', ''))), h('th'))),
        h('tbody', null, ids.map((id) => h('tr', null,
          h('td', null, userName(id), h('div', { class: 'sub muted' }, (userById(id)?.teamIds || []).map(teamName).join(', '))),
          ENTITLED_TYPES.map((t) => h('td', { class: 'num' }, dayInput(draft.overrides[id][t], (v) => { draft.overrides[id][t] = v; },
            draft.days[t] === '' ? 'not set' : `${draft.days[t]}`, `${userName(id)} ${LEAVE_TYPE_LABEL[t]}`))),
          h('td', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn-ghost-danger small', onclick: () => { delete draft.overrides[id]; paint(); } }, 'Remove'))))))));
    } else ex.append(h('p', { class: 'muted' }, 'No exceptions.'));
    const candidates = state.ref.users.filter((u) => u.active !== false && (u.teamIds || []).length && !draft.overrides[u.id]).sort((a, b) => a.name.localeCompare(b.name));
    const pick = select([{ value: '', label: 'Add a person...' }, ...candidates.map((u) => ({ value: u.id, label: `${u.name} (${(u.teamIds || []).map(teamName).join(', ')})` }))], '',
      { 'aria-label': 'Add an exception for', onchange: (e) => { if (e.target.value) { draft.overrides[e.target.value] = Object.fromEntries(ENTITLED_TYPES.map((t) => [t, ''])); paint(); } } });
    ex.append(h('div', { class: 'inline' }, pick));
    wrap.append(ex);

    wrap.append(h('div', { class: 'form-actions' },
      h('p', { class: 'muted small' }, 'Everyone can see their own balance. Changes apply to the whole of ' + year + '.'),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { startDraft(); paint(); } }, 'Discard changes'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Save entitlements')));
    return wrap;
  }

  async function copyPrevious() {
    try {
      const prev = await loadPolicy(year - 1, { force: true });
      if (!prev) { toast(`There are no entitlements for ${year - 1} to copy.`, 'error'); return; }
      draft = {
        days: Object.fromEntries(ENTITLED_TYPES.map((t) => [t, asText(prev.days?.[t])])),
        overrides: Object.fromEntries(Object.entries(prev.overrides || {}).map(([id, o]) => [id, Object.fromEntries(ENTITLED_TYPES.map((t) => [t, asText(o[t])]))]))
      };
      toast(`Copied from ${year - 1}. Check the numbers, then save.`, 'success');
      paint();
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  async function save() {
    const days = {}, overrides = {};
    for (const t of ENTITLED_TYPES) {
      const r = parseDays(draft.days[t]);
      if (!r.ok) { toast(`${LEAVE_TYPE_LABEL[t]}: please enter a number of days from 0 to 366 (half days allowed).`, 'error'); return; }
      if (r.value !== null) days[t] = r.value;
    }
    for (const [id, o] of Object.entries(draft.overrides)) {
      overrides[id] = {};
      for (const t of ENTITLED_TYPES) {
        const r = parseDays(o[t]);
        if (!r.ok) { toast(`${userName(id)}, ${LEAVE_TYPE_LABEL[t]}: please enter a number of days from 0 to 366 (half days allowed).`, 'error'); return; }
        if (r.value !== null) overrides[id][t] = r.value;
      }
    }
    try {
      const saved = await savePolicy(year, days, overrides);
      if (!saved) { toast('Nothing changed.', 'info'); return; }
      policy = saved; draft = null;
      toast(`Leave entitlements for ${year} saved.`, 'success');
      paint();
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  load();
  return () => {};
}
