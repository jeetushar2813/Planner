// Leave: ask for leave, approve or decline it, record it for someone, and manage public
// holidays. Approved leave and holidays feed the Calendar and the Team Overview.

import { h, add, clear, todayISO, fmtDate, fmtAgo, fmtWeekday } from '../core/util.js';
import { LEAVE_TYPES, LEAVE_TYPE_LABEL, LEAVE_STATUS_LABEL, HALF_LABEL, ENTITLED_TYPES } from '../core/model.js';
import { groupLeaves, personBalance, dayText, yearOf } from '../core/entitlement.js';
import * as perm from '../core/perm.js';
import { leaveWorkdays } from '../core/calendar.js';
import { MY_KL_HOLIDAYS, MY_KL_YEARS, MY_KL_SOURCE } from '../data/holidays-my-kl.js';
import {
  state, bus, myTeams, teamName, userById, submitLeave, decideLeave, cancelLeave,
  loadMyLeave, loadTeamLeave, loadPendingLeave, loadHolidays, createHoliday, updateHoliday,
  planHolidayImport, importHolidays, loadPolicy, userName
} from '../core/store.js';
import {
  openPanel, toast, errorMessage, field, select, emptyState, spinner, confirmDialog, promptDialog, avatar
} from './components.js';

const rangeText = (l) => (l.startDate === l.endDate ? fmtDate(l.startDate) : `${fmtDate(l.startDate)} to ${fmtDate(l.endDate)}`);
const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;
const statusChip = (status) => h('span', { class: `chip chip-lv chip-lv-${status}` }, LEAVE_STATUS_LABEL[status] || status);
const halfNote = (l) => (l.half && l.half !== 'full' ? ` (${HALF_LABEL[l.half].toLowerCase()})` : '');

export function renderLeave(container) {
  const user = state.user;
  const canDecide = perm.isLeaderUp(user);
  const seesTeam = perm.canSeeTeamLeave(user);
  const myTeamList = myTeams();
  const ownTeams = myTeamList.filter((t) => (user.teamIds || []).includes(t.id));

  let mine = [], pending = [], teamLeave = [], holidays = [];
  const policies = {};              // year -> policy document (null when HR has not set one)
  const thisYear = Number(todayISO().slice(0, 4));
  let teamFilter = '';
  let loading = true;
  let failure = null;

  const body = h('div');
  add(container,
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'Leave'),
        h('p', { class: 'muted' }, canDecide
          ? 'Ask for leave, approve your team’s requests, and set public holidays.'
          : 'Ask for leave and see public holidays. Your Team Leader approves requests.')),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: load }, 'Refresh'),
        canDecide ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => openLeavePanel({ record: true }) }, 'Record leave for someone') : null,
        ownTeams.length ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openLeavePanel({ record: false }) }, 'Request leave') : null)),
    body);

  async function load() {
    loading = true; failure = null; paint();
    try {
      const today = todayISO();
      const teamIds = (seesTeam ? myTeamList : []).map((t) => t.id);
      const [m, hol, tl, pd] = await Promise.all([
        loadMyLeave(), loadHolidays(`${thisYear}-01-01`),
        Promise.all(teamIds.map((id) => loadTeamLeave(id, today))),
        canDecide ? Promise.all(teamIds.map((id) => loadPendingLeave(id))) : Promise.resolve([])
      ]);
      for (const y of [thisYear, thisYear + 1]) { try { policies[y] = await loadPolicy(y); } catch { policies[y] = null; } }
      mine = m.sort((a, b) => b.startDate.localeCompare(a.startDate));
      holidays = hol;
      teamLeave = dedupe(tl.flat());
      pending = dedupe(pd.flat());
    } catch (err) { failure = err; }
    loading = false; paint();
  }

  const dedupe = (list) => [...new Map(list.map((l) => [l.id, l])).values()];

  // Working days a request takes, taking public holidays into account.
  const daysOf = (l) => leaveWorkdays(l, userById(l.userId), holidays);

  function paint() {
    clear(body);
    if (loading) { body.append(spinner('Loading leave')); return; }
    if (failure) { body.append(emptyState('Could not load leave', errorMessage(failure))); return; }

    if (canDecide) body.append(approvalsCard());
    body.append(balanceCard());
    body.append(myLeaveCard());
    if (seesTeam) body.append(teamLeaveCard());
    body.append(holidayCard());
  }

  // ---------------------------------------------------------------- approvals
  function approvalsCard() {
    const todo = pending.filter((l) => perm.canApproveLeave(user, l))
      .sort((a, b) => (perm.leaveStep(a) === perm.leaveStep(b) ? 0 : perm.leaveStep(a) === 'director' ? -1 : 1) || a.startDate.localeCompare(b.startDate));
    const card = h('section', { class: 'card-block', 'aria-labelledby': 'h-approve' },
      h('h2', { id: 'h-approve' }, 'Waiting for your decision', h('span', { class: 'count' + (todo.length ? ' count-bad' : '') }, todo.length)),
      h('p', { class: 'muted small' }, 'Leave is approved in two steps: the Team Leader first, then the Director. HR is told afterwards and only acknowledges.'));
    if (!todo.length) { card.append(h('p', { class: 'muted' }, 'No requests are waiting.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Leave'), h('th', null, 'Dates'), h('th', null, 'Reason'), h('th', null, 'Step'), h('th'))),
      h('tbody', null, todo.map((l) => {
        const director = perm.leaveStep(l) === 'director';
        return h('tr', null,
          h('td', null, h('span', { class: 'person' }, avatar(l.userName, 22), h('span', null, l.userName)), h('div', { class: 'sub muted' }, teamName(l.teamId))),
          h('td', null, LEAVE_TYPE_LABEL[l.type]),
          h('td', null, rangeText(l) + halfNote(l), h('div', { class: 'sub muted' }, dayWord(daysOf(l)))),
          h('td', null, l.reason || h('span', { class: 'muted' }, '–')),
          h('td', null, director ? 'Director' : 'Team Leader',
            director && l.leaderBy ? h('div', { class: 'sub muted' }, `Team Leader: ${userName(l.leaderBy)}`) : null,
            !director && perm.isDirector(user) && !(user.role === 'leader' || user.role === 'manager')
              ? h('div', { class: 'sub muted' }, 'Counts as the Team Leader step') : null),
          h('td', { class: 'row-actions' },
            h('button', { type: 'button', class: 'btn btn-primary small', onclick: () => decide(l, 'approve') }, director ? 'Approve' : (perm.isDirector(user) ? 'Approve (Team Leader step)' : 'Approve')),
            h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => decide(l, 'decline') }, 'Decline')));
      })))));
    return card;
  }

  async function decide(leave, decision) {
    let note = '';
    if (decision === 'decline') {
      note = await promptDialog({
        title: 'Decline leave', message: `${leave.userName}, ${rangeText(leave)}`, label: 'Reason (they will see this)',
        confirm: 'Decline leave'
      });
      if (note === null) return;
      if (!note) { toast('Please give a short reason for declining.', 'error'); return; }
    }
    try {
      await decideLeave(leave, decision, note);
      toast(decision !== 'approve' ? 'Leave declined.' : leave.status === 'pending' ? 'Approved. It now waits for the Director.' : 'Leave approved.', 'success');
      load();
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  // ------------------------------------------------------------- my balance
  const balanceFor = (year) => personBalance({ person: user, groups: groupLeaves(mine), policy: policies[year], holidays, year });

  function balanceCard() {
    const year = thisYear;
    const card = h('section', { class: 'card-block' }, h('h2', null, `My leave balance ${year}`));
    if (!policies[year]) {
      card.append(h('p', { class: 'muted' }, 'HR has not set the leave entitlements for this year yet.'));
      return card;
    }
    const bal = balanceFor(year);
    const kinds = ENTITLED_TYPES.filter((t) => bal[t].entitled !== null);
    if (!kinds.length) { card.append(h('p', { class: 'muted' }, 'No leave days have been set for you this year.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
      h('thead', null, h('tr', null, h('th', null, 'Kind of leave'), h('th', { class: 'num' }, 'Entitled'), h('th', { class: 'num' }, 'Taken'), h('th', { class: 'num' }, 'Waiting'), h('th', { class: 'num' }, 'Left'))),
      h('tbody', null, kinds.map((t) => h('tr', null,
        h('td', null, LEAVE_TYPE_LABEL[t]),
        h('td', { class: 'num' }, dayText(bal[t].entitled)),
        h('td', { class: 'num' }, dayText(bal[t].used)),
        h('td', { class: 'num' }, dayText(bal[t].pending)),
        h('td', { class: 'num' }, h('strong', { class: bal[t].left < 0 ? 'neg' : '' }, dayText(bal[t].left)))))))),
      h('p', { class: 'hint' }, 'Taken = approved. Waiting = asked for but not fully approved yet. Weekends and public holidays are not counted.'));
    return card;
  }

  // ----------------------------------------------------------------- my leave
  function myLeaveCard() {
    const card = h('section', { class: 'card-block' }, h('h2', null, 'My leave'));
    if (!mine.length) {
      card.append(h('p', { class: 'muted' }, ownTeams.length ? 'You have not asked for any leave yet.' : 'You are not in a team yet, so leave cannot be requested.'));
      return card;
    }
    const today = todayISO();
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Leave'), h('th', null, 'Dates'), h('th', null, 'Team'), h('th', null, 'Status'), h('th'))),
      h('tbody', null, mine.map((l) => h('tr', { class: ['declined', 'cancelled'].includes(l.status) ? 'row-muted' : '' },
        h('td', null, LEAVE_TYPE_LABEL[l.type], l.reason ? h('div', { class: 'sub muted' }, l.reason) : null),
        h('td', null, rangeText(l) + halfNote(l), h('div', { class: 'sub muted' }, dayWord(daysOf(l)))),
        h('td', null, teamName(l.teamId)),
        h('td', null, statusChip(l.status),
          l.leaderBy && l.status !== 'pending' && l.status !== 'declined' ? h('div', { class: 'sub muted' }, `Team Leader: ${userName(l.leaderBy)}`) : null,
          l.status === 'declined' && l.decisionNote ? h('div', { class: 'sub' }, `“${l.decisionNote}”`) : null,
          l.decidedAt && ['approved', 'declined'].includes(l.status) ? h('div', { class: 'sub muted' }, `${fmtAgo(l.decidedAt)}`) : null,
          l.status === 'approved' && l.hrAckAt ? h('div', { class: 'sub muted' }, 'HR acknowledged') : null),
        h('td', { class: 'row-actions' },
          perm.canCancelLeave(user, l) && l.endDate >= today
            ? h('button', { type: 'button', class: 'btn btn-ghost-danger small', onclick: () => cancel(l) }, 'Cancel')
            : null)))))));
    return card;
  }

  async function cancel(leave) {
    const ok = await confirmDialog(`Cancel ${leave.userName}’s leave (${rangeText(leave)})?`, { title: 'Cancel leave', confirm: 'Cancel leave', cancel: 'Keep it', danger: true });
    if (!ok) return;
    try { await cancelLeave(leave); toast('Leave cancelled.', 'success'); load(); }
    catch (err) { toast(errorMessage(err), 'error'); }
  }

  // ---------------------------------------------------------------- team leave
  function teamLeaveCard() {
    const card = h('section', { class: 'card-block' }, h('h2', null, 'Team leave coming up'));
    if (myTeamList.length > 1) {
      card.append(h('div', { class: 'toolbar' }, select(
        [{ value: '', label: 'All my teams' }, ...myTeamList.map((t) => ({ value: t.id, label: t.name }))], teamFilter,
        { 'aria-label': 'Team', onchange: (e) => { teamFilter = e.target.value; paint(); } })));
    }
    const rows = teamLeave
      .filter((l) => (l.status === 'approved' || perm.isPendingLeave(l)) && (!teamFilter || l.teamId === teamFilter) && l.userId !== user.id)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (!rows.length) { card.append(h('p', { class: 'muted' }, 'Nobody has leave booked.')); return card; }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Leave'), h('th', null, 'Dates'), h('th', null, 'Status'), h('th'))),
      h('tbody', null, rows.map((l) => h('tr', null,
        h('td', null, h('span', { class: 'person' }, avatar(l.userName, 22), h('span', null, l.userName)),
          myTeamList.length > 1 ? h('div', { class: 'sub muted' }, teamName(l.teamId)) : null),
        h('td', null, LEAVE_TYPE_LABEL[l.type]),
        h('td', null, rangeText(l) + halfNote(l), h('div', { class: 'sub muted' }, dayWord(daysOf(l)))),
        h('td', null, statusChip(l.status)),
        h('td', { class: 'row-actions' },
          perm.canCancelLeave(user, l) ? h('button', { type: 'button', class: 'btn btn-ghost-danger small', onclick: () => cancel(l) }, 'Cancel') : null)))))));
    return card;
  }

  // ------------------------------------------------------------------ holidays
  function holidayCard() {
    const card = h('section', { class: 'card-block' },
      h('div', { class: 'row-head' }, h('h2', null, 'Public holidays and closures'),
        h('div', { class: 'head-actions' },
          perm.isDirector(user) ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: openMalaysiaPanel }, 'Add Malaysian holidays') : null,
          perm.canManageHolidays(user) ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => openHolidayPanel(null) }, '+ Add holiday') : null)));
    const list = holidays.filter((x) => x.active !== false && x.date >= todayISO());
    if (!list.length) {
      card.append(h('p', { class: 'muted' }, perm.isDirector(user)
        ? 'No upcoming holidays have been added. Use “Add Malaysian holidays” to load the Kuala Lumpur list.'
        : 'No upcoming holidays have been added.'));
      return card;
    }
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
      h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Holiday'), h('th', null, 'Applies to'), h('th'))),
      h('tbody', null, list.map((x) => h('tr', null,
        h('td', { class: 'nowrap' }, fmtDate(x.date)),
        h('td', null, x.name),
        h('td', null, x.teamId ? teamName(x.teamId) : 'Everyone'),
        h('td', { class: 'row-actions' },
          perm.canEditHoliday(user, x) ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => openHolidayPanel(x) }, 'Edit') : null)))))));
    return card;
  }

  // ----------------------------------------------- bundled Malaysian (Kuala Lumpur) list
  const KIND_LABEL = { federal: 'National', kl: 'Kuala Lumpur', replacement: 'Replacement' };

  async function openMalaysiaPanel() {
    const thisYear = new Date().getFullYear();
    const picked = new Set(MY_KL_YEARS.filter((y) => y >= thisYear));
    const panel = openPanel({
      title: 'Malaysian public holidays', wide: true,
      subtitle: 'Kuala Lumpur: national holidays plus Federal Territory Day, Thaipusam and Nuzul Al-Quran.'
    });
    const yearsBox = h('div', { class: 'toolbar' });
    const listBox = h('div');
    const actions = h('div', { class: 'form-actions' });
    panel.body.append(yearsBox, listBox, actions,
      h('p', { class: 'hint' }, `Source: ${MY_KL_SOURCE}. Dates marked “may move” follow the moon and can change by a day; `
        + 'replacement days are the next working day after a Sunday holiday. Anything wrong can be edited or removed afterwards.'));

    let plan = { fresh: [], existing: [] };
    const chosen = () => MY_KL_YEARS.filter((y) => picked.has(y)).flatMap((y) => MY_KL_HOLIDAYS[y]);

    async function refresh() {
      clear(yearsBox);
      for (const y of MY_KL_YEARS) {
        yearsBox.append(h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: picked.has(y), onchange: (e) => { e.target.checked ? picked.add(y) : picked.delete(y); refresh(); } }), ` ${y}`));
      }
      clear(listBox); clear(actions);
      const items = chosen();
      if (!items.length) { listBox.append(h('p', { class: 'muted' }, 'Choose a year.')); return; }
      listBox.append(spinner('Checking what is already added'));
      try { plan = await planHolidayImport(items); }
      catch (err) { clear(listBox); listBox.append(emptyState('Could not check the holidays', errorMessage(err))); return; }
      const have = new Set(plan.existing.map((x) => x.date + '|' + x.name));
      clear(listBox);
      listBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
        h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Holiday'), h('th', null, 'Type'), h('th', null, ''))),
        h('tbody', null, items.map((i) => h('tr', { class: have.has(i.date + '|' + i.name) ? 'row-muted' : '' },
          h('td', { class: 'nowrap' }, `${fmtWeekday(i.date)} ${fmtDate(i.date)}`),
          h('td', null, i.name, i.tentative ? h('div', { class: 'sub muted' }, 'may move') : null),
          h('td', null, KIND_LABEL[i.kind]),
          h('td', null, have.has(i.date + '|' + i.name) ? 'Already added' : '')))))));
      const n = plan.fresh.length;
      actions.append(h('span', { class: 'muted' }, n ? `${n} new, ${plan.existing.length} already added.` : 'Everything here is already added.'),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Close'),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !n, onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await importHolidays(items);
            toast(`${r.added} holiday${r.added === 1 ? '' : 's'} added.`, 'success'); panel.close(); load();
          } catch (err) { toast(errorMessage(err), 'error'); refresh(); load(); }
        } }, n ? `Add ${n} holiday${n === 1 ? '' : 's'}` : 'Add'));
    }
    refresh();
  }

  function openHolidayPanel(existing) {
    const draft = existing
      ? { name: existing.name, date: existing.date, teamId: existing.teamId || '' }
      : { name: '', date: todayISO(), teamId: perm.isDirector(user) ? '' : (myTeamList[0]?.id || '') };
    const panel = openPanel({ title: existing ? 'Edit holiday' : 'Add holiday', subtitle: 'Weekends are already treated as days off.' });
    const form = h('form', { class: 'task-form', novalidate: true });
    panel.body.append(form);
    const teamOptions = [...(perm.isDirector(user) ? [{ value: '', label: 'Everyone (all teams)' }] : []),
      ...myTeamList.map((t) => ({ value: t.id, label: t.name }))];
    add(form,
      field('Name', h('input', { type: 'text', value: draft.name, maxlength: 100, oninput: (e) => { draft.name = e.target.value; } })),
      field('Date', h('input', { type: 'date', value: draft.date, onchange: (e) => { draft.date = e.target.value; } })),
      field('Applies to', select(teamOptions, draft.teamId, { onchange: (e) => { draft.teamId = e.target.value; } })),
      h('div', { class: 'form-actions' },
        existing ? h('button', { type: 'button', class: 'btn btn-ghost-danger', onclick: async () => {
          if (!(await confirmDialog(`Remove “${existing.name}”? It stays in the activity log.`, { confirm: 'Remove', danger: true }))) return;
          try { await updateHoliday(existing, { active: false }); toast('Holiday removed.', 'success'); panel.close(); load(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Remove') : h('span'),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Save changes' : 'Add holiday')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        if (existing) await updateHoliday(existing, { name: draft.name, date: draft.date, teamId: draft.teamId || null });
        else await createHoliday({ name: draft.name, date: draft.date, teamId: draft.teamId || null });
        toast('Saved.', 'success'); panel.close(); load();
      } catch (err) { toast(errorMessage(err), 'error'); btn.disabled = false; }
    });
  }

  // ------------------------------------------------------------ request / record
  function openLeavePanel({ record }) {
    const today = todayISO();
    const people = record
      ? state.ref.users.filter((u) => u.active !== false && u.role !== 'director'
        && (u.teamIds || []).some((id) => myTeamList.some((t) => t.id === id)))
      : [user];
    if (!people.length) { toast('There is nobody to record leave for yet.', 'error'); return; }
    const draft = {
      personId: record ? people[0].id : user.id, type: 'annual', startDate: today, endDate: today,
      half: 'full', reason: '', teamIds: []
    };
    const teamsFor = (person) => myTeamList.filter((t) => (person.teamIds || []).includes(t.id)
      && (record ? perm.canRecordLeaveFor(user, person, t.id) : true));
    draft.teamIds = teamsFor(userById(draft.personId) || user).map((t) => t.id);

    const panel = openPanel({
      title: record ? 'Record leave' : 'Request leave',
      subtitle: record
        ? (perm.isDirector(user) ? 'Recorded leave is approved straight away.' : 'Counts as the Team Leader’s approval, then waits for the Director.')
        : 'Your Team Leader approves first, then the Director. HR is told afterwards.'
    });
    const form = h('form', { class: 'task-form', novalidate: true });
    panel.body.append(form);
    const preview = h('p', { class: 'hint leave-preview' });
    const personOf = () => userById(draft.personId) || user;

    function updatePreview() {
      const person = personOf();
      const teamId = draft.teamIds[0] || (person.teamIds || [])[0];
      if (!draft.startDate || !draft.endDate || draft.endDate < draft.startDate) { preview.textContent = 'Check the dates: the last day is before the first day.'; return; }
      const n = leaveWorkdays({ ...draft, teamId, half: draft.startDate === draft.endDate ? draft.half : 'full' }, person, holidays);
      preview.textContent = n === 0
        ? 'These dates are all weekends or holidays, so no working days are used.'
        : `Uses ${dayWord(n)} of work. Weekends and public holidays are not counted.`;
      // Your own balance for this kind of leave (a warning only; your approvers decide).
      const year = yearOf(draft.startDate);
      if (!record && ENTITLED_TYPES.includes(draft.type)) {
        if (policies[year] === undefined) { preview.textContent += ' '; }
        else if (policies[year]) {
          const b = balanceFor(year)[draft.type];
          if (b.entitled === null) preview.textContent += ` HR has not set ${LEAVE_TYPE_LABEL[draft.type].toLowerCase()} days for ${year}.`;
          else {
            const left = b.left - n;
            preview.textContent += ` You have ${dayText(b.left)} of ${dayText(b.entitled)} ${LEAVE_TYPE_LABEL[draft.type].toLowerCase()} days left in ${year}${left < 0 ? `. This request goes over by ${dayText(-left)} day${-left === 1 ? '' : 's'}; your approvers will see that.` : `, ${dayText(left)} after this request.`}`;
          }
        }
      }
    }

    function draw() {
      clear(form);
      const person = personOf();
      const teamBoxes = teamsFor(person).map((t) => h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: draft.teamIds.includes(t.id),
          onchange: (e) => { draft.teamIds = e.target.checked ? [...draft.teamIds, t.id] : draft.teamIds.filter((x) => x !== t.id); updatePreview(); }
        }), ' ', t.name));
      const sameDay = draft.startDate === draft.endDate;
      add(form,
        record ? field('Person', select(people.map((u) => ({ value: u.id, label: u.name })), draft.personId, {
          onchange: (e) => { draft.personId = e.target.value; draft.teamIds = teamsFor(personOf()).map((t) => t.id); draw(); }
        })) : null,
        field('Kind of leave', select(LEAVE_TYPES.map((t) => ({ value: t, label: LEAVE_TYPE_LABEL[t] })), draft.type, { onchange: (e) => { draft.type = e.target.value; updatePreview(); } })),
        h('div', { class: 'grid-2' },
          field('First day', h('input', { type: 'date', value: draft.startDate, onchange: (e) => {
            draft.startDate = e.target.value;
            if (!draft.endDate || draft.endDate < draft.startDate) draft.endDate = draft.startDate;
            draw();
          } })),
          field('Last day', h('input', { type: 'date', value: draft.endDate, min: draft.startDate, onchange: (e) => { draft.endDate = e.target.value; draw(); } }))),
        sameDay ? field('Day part', select(Object.entries(HALF_LABEL).map(([value, label]) => ({ value, label })), draft.half,
          { onchange: (e) => { draft.half = e.target.value; updatePreview(); } })) : null,
        preview,
        field('Reason (optional)', h('textarea', { rows: 2, maxlength: 300, oninput: (e) => { draft.reason = e.target.value; } }, draft.reason)),
        teamBoxes.length > 1 ? field('Counts for', h('div', { class: 'check-list' }, teamBoxes), 'Each team’s leader sees the request.') : null,
        h('div', { class: 'form-actions' },
          h('div', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, record ? 'Record leave' : 'Send request')));
      updatePreview();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await submitLeave({
          person: personOf(), type: draft.type, startDate: draft.startDate, endDate: draft.endDate,
          half: draft.half, reason: draft.reason, teamIds: draft.teamIds, existing: [...mine, ...teamLeave]
        });
        toast(record ? 'Leave recorded.' : 'Request sent. Your Team Leader will see it first.', 'success');
        panel.close(); load();
      } catch (err) { toast(errorMessage(err), 'error'); btn.disabled = false; }
    });
    draw();
  }

  const onChange = () => { /* pages reload themselves after their own writes */ };
  bus.addEventListener('leave', onChange);
  load();
  return () => bus.removeEventListener('leave', onChange);
}
