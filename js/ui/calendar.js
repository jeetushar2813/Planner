// Calendar: due dates, leave and public holidays in a month or week view, with warnings
// for days that are short-staffed or heavy. Used for planning who can do what, and when.
//
// Reads: open tasks and leave for your team(s), finished tasks from the first visible day.
// Moving to an earlier month than anything loaded so far reads again; everything else
// (filters, layers, week/month) is worked out on screen.

import {
  h, add, clear, todayISO, addDays, addMonths, startOfMonth, endOfMonth, startOfWeek, eachDay,
  fmtDate, fmtDateLong, fmtMonthYear, fmtWeekday
} from '../core/util.js';
import { LEAVE_TYPE_LABEL, OPEN_CATEGORIES } from '../core/model.js';
import * as perm from '../core/perm.js';
import {
  weekStartsOn, holidayFor, covers, isApproved, capacity, dayFlags, FLAG_TEXT, isWeekend, ownerAwayOnDue
} from '../core/calendar.js';
import {
  state, myTeams, userById, userName, teamName, loadOpenTasks, loadFinished, loadTeamLeave, loadMyLeave, loadHolidays,
  loadKeyDates, saveKeyDate, canManageKeyDates, canManageKeyDateFor
} from '../core/store.js';
import { occurrencesIn, coversDay, dayOf, KEY_CATEGORIES, KEY_CATEGORY_LABEL, MAX_SPAN_DAYS } from '../core/keydates.js';
import { toast, errorMessage, emptyState, spinner, select, openPanel, field, confirmDialog } from './components.js';
import { openTaskPanel } from './taskform.js';

let memory = null;
let memoryUser = null;
const firstName = (name) => (name || '').split(' ')[0];

export function renderCalendar(container) {
  const user = state.user;
  const today = todayISO();
  if (memoryUser !== user.id || !memory) {
    memory = {
      view: 'month', anchor: today, teamId: '',
      personId: perm.isDeputyUp(user) ? '' : user.id,
      layers: { due: true, leave: true, holiday: true, key: true }
    };
    memoryUser = user.id;
  }
  const f = memory;
  const teams = myTeams();
  const leaderView = perm.canSeeTeamLeave(user);
  if (f.teamId && !teams.some((t) => t.id === f.teamId)) f.teamId = '';

  let data = null;              // { open, fin, leaves, holidays, keyDates, from }
  let loading = true;
  let failure = null;

  const head = h('div', { class: 'cal-head' });
  const filters = h('div', { class: 'toolbar' });
  const grid = h('div', { class: 'cal' });
  add(container,
    h('div', { class: 'page-head' },
      h('h1', null, 'Calendar'),
      h('p', { class: 'muted' }, leaderView ? 'Deadlines, leave, holidays and key dates in one place, so you can plan who does what.' : 'Your deadlines, your leave, public holidays and key dates.')),
    head, filters, grid);

  // -------------------------------------------------------------------- range
  const range = () => {
    if (f.view === 'week') { const s = startOfWeek(f.anchor, weekStartsOn()); return { from: s, to: addDays(s, 6) }; }
    const s = startOfWeek(startOfMonth(f.anchor), weekStartsOn());
    const e = addDays(startOfWeek(endOfMonth(f.anchor), weekStartsOn()), 6);
    return { from: s, to: e };
  };

  async function load(force = false) {
    const { from } = range();
    if (!force && data && from >= data.from) { paint(); return; }
    loading = true; failure = null; paint();
    const start = addDays(from, -7);
    try {
      const perTeam = await Promise.all(teams.map(async (t) => {
        const [open, fin, leaves] = await Promise.all([
          loadOpenTasks({ teamId: t.id }), loadFinished({ teamId: t.id, fromISO: start }),
          leaderView ? loadTeamLeave(t.id, start) : Promise.resolve([])
        ]);
        return { open, fin, leaves };
      }));
      const mineLeave = leaderView ? [] : (await loadMyLeave()).filter((l) => l.endDate >= start);
      const uniq = (lists) => [...new Map(lists.flat().map((x) => [x.id, x])).values()];
      data = {
        open: uniq(perTeam.map((x) => x.open)), fin: uniq(perTeam.map((x) => x.fin)),
        leaves: uniq([...perTeam.map((x) => x.leaves), mineLeave]), holidays: await loadHolidays(start), from: start,
        keyDates: await loadKeyDates().catch(() => [])
      };
    } catch (err) { failure = err; toast(errorMessage(err), 'error'); }
    loading = false; paint();
  }

  // ----------------------------------------------------------------- controls
  function drawControls() {
    const { from, to } = range();
    const title = f.view === 'week' ? `${fmtDate(from)} to ${fmtDate(to)}` : fmtMonthYear(f.anchor);
    const step = (dir) => { f.anchor = f.view === 'week' ? addDays(f.anchor, 7 * dir) : addMonths(startOfMonth(f.anchor), dir); load(); };
    clear(head);
    add(head,
      h('div', { class: 'cal-nav' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous', onclick: () => step(-1) }, '‹'),
        h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => { f.anchor = todayISO(); load(); } }, 'Today'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next', onclick: () => step(1) }, '›'),
        h('h2', { class: 'cal-title', 'aria-live': 'polite' }, title)),
      canManageKeyDates(user) ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => openKeyDatePanel(null, f.anchor) }, '+ Key date') : null,
      h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
        ['month', 'week'].map((v) => h('button', {
          type: 'button', class: 'seg-btn' + (f.view === v ? ' on' : ''), 'aria-pressed': String(f.view === v),
          onclick: () => { f.view = v; load(); }
        }, v === 'month' ? 'Month' : 'Week'))));

    clear(filters);
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)));
    if (f.personId && !people.some((p) => p.id === f.personId)) f.personId = perm.isDeputyUp(user) ? '' : user.id;
    const layer = (key, label) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: f.layers[key], onchange: (e) => { f.layers[key] = e.target.checked; paint(); } }), ' ' + label);
    add(filters,
      teams.length > 1 ? select([{ value: '', label: perm.isDirector(user) ? 'All teams' : 'All my teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))], f.teamId,
        { 'aria-label': 'Team', onchange: (e) => { f.teamId = e.target.value; paint(); } }) : null,
      select([{ value: '', label: 'Everyone' }, ...people.sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.id === user.id ? `${p.name} (me)` : p.name }))], f.personId,
        { 'aria-label': 'Person', onchange: (e) => { f.personId = e.target.value; paint(); } }),
      layer('due', 'Due dates'), layer('leave', 'Leave'), layer('holiday', 'Holidays'), layer('key', 'Key dates'));
  }

  // ------------------------------------------------------------------ the grid
  function paint() {
    drawControls();
    clear(grid);
    if (loading) { grid.append(spinner('Loading calendar')); return; }
    if (failure || !data) { grid.append(emptyState('Could not load the calendar', errorMessage(failure))); return; }
    if (!teams.length) { grid.append(emptyState('No team yet', 'You are not in a team, so there is nothing to show.')); return; }

    const ctx = context();
    const { from, to } = range();
    const days = eachDay(from, to);
    const names = eachDay(from, addDays(from, 6)).map((d) => h('div', { class: 'cal-dow' + (isWeekend(d) ? ' cal-dow-off' : '') }, fmtWeekday(d)));
    const cells = days.map((d) => dayCell(d, ctx));
    add(grid,
      h('div', { class: 'cal-grid cal-' + f.view, role: 'grid', 'aria-label': f.view === 'week' ? 'Week' : fmtMonthYear(f.anchor) }, names, cells),
      legendRow(leaderView));
  }

  // Everything the day cells need, filtered once.
  function context() {
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const inScope = (t) => scopeIds.includes(t.teamId);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)));
    const approved = data.leaves.filter((l) => isApproved(l) && scopeIds.includes(l.teamId));
    const tasksAll = [...data.open, ...data.fin].filter(inScope);
    return {
      scopeIds, people, approved, tasksAll,
      tasks: tasksAll.filter((t) => !f.personId || t.ownerId === f.personId),
      leaves: data.leaves.filter((l) => (l.status === 'approved' || perm.isPendingLeave(l)) && scopeIds.includes(l.teamId)
        && (!f.personId || l.userId === f.personId) && (leaderView || l.userId === user.id)),
      holidays: data.holidays.filter((x) => x.active !== false && (!x.teamId || scopeIds.includes(x.teamId))),
      keyOccs: occurrencesIn((data.keyDates || []).filter((k) => !k.teamId || scopeIds.includes(k.teamId)), range().from, range().to)
    };
  }

  function dayInfo(iso, ctx) {
    const tasks = ctx.tasks.filter((t) => t.dueDate === iso).sort((a, b) => (a.statusCategory === 'done') - (b.statusCategory === 'done'));
    const leaves = ctx.leaves.filter((l) => covers(l, iso));
    const holiday = ctx.holidays.find((x) => x.date === iso) || null;
    const keys = ctx.keyOccs.filter((o) => coversDay(o, iso));
    let flags = [], cap = null;
    if (leaderView && ctx.people.length) {
      cap = capacity(ctx.people, iso, ctx.approved, data.holidays);
      const dueCount = ctx.tasksAll.filter((t) => t.dueDate === iso && OPEN_CATEGORIES.includes(t.statusCategory)).length;
      flags = dayFlags(cap, dueCount);
    }
    return { tasks, leaves, holiday, keys, flags, cap };
  }

  function dayCell(iso, ctx) {
    const info = dayInfo(iso, ctx);
    const week = f.view === 'week';
    const outside = !week && iso.slice(0, 7) !== f.anchor.slice(0, 7);
    const limit = week ? Infinity : 3;
    const taskLimit = week ? Infinity : 3;
    const off = isWeekend(iso) || (f.layers.holiday && info.holiday);

    const chips = [];
    if (f.layers.key !== false) {
      for (const o of info.keys.slice(0, week ? Infinity : 2)) chips.push(keyChip(o, iso, week));
      if (!week && info.keys.length > 2) chips.push(h('div', { class: 'cal-more' }, `+${info.keys.length - 2} key dates`));
    }
    if (f.layers.holiday && info.holiday) {
      chips.push(h('div', { class: 'chip-cal chip-holiday', title: info.holiday.name + (info.holiday.teamId ? ` (${teamName(info.holiday.teamId)})` : '') }, info.holiday.name));
    }
    if (f.layers.leave && !isWeekend(iso)) {
      const lv = info.leaves.slice(0, week ? Infinity : 2);
      for (const l of lv) {
        const half = l.half && l.half !== 'full' ? ' ½' : '';
        const label = `${firstName(l.userName)} · ${LEAVE_TYPE_LABEL[l.type].split(' ')[0].toLowerCase()}${half}`;
        chips.push(h('div', {
          class: 'chip-cal chip-leave' + (perm.isPendingLeave(l) ? ' chip-pending' : ''),
          title: `${l.userName}: ${LEAVE_TYPE_LABEL[l.type]}${half ? ' (half day)' : ''}${perm.isPendingLeave(l) ? ', waiting for approval' : ''}`
        }, label + (perm.isPendingLeave(l) ? ' ?' : '')));
      }
      if (info.leaves.length > lv.length) chips.push(h('div', { class: 'cal-more' }, `+${info.leaves.length - lv.length} on leave`));
    }
    if (f.layers.due) {
      const shown = info.tasks.slice(0, taskLimit);
      for (const t of shown) chips.push(taskChip(t, iso, ctx));
      if (info.tasks.length > shown.length) chips.push(h('div', { class: 'cal-more' }, `+${info.tasks.length - shown.length} more due`));
    }

    const flagBadge = f.layers.due || f.layers.leave ? info.flags.map((x) => h('span', { class: 'flag', title: FLAG_TEXT[x], 'aria-label': FLAG_TEXT[x] }, '!')) : [];
    const cell = h('div', {
      class: 'cal-cell' + (iso === todayISO() ? ' cal-today' : '') + (outside ? ' cal-outside' : '') + (off ? ' cal-off' : ''),
      role: 'gridcell', tabindex: 0, 'aria-label': `${fmtDateLong(iso)}: ${info.tasks.length} due, ${info.leaves.length} on leave${info.holiday ? ', ' + info.holiday.name : ''}${info.keys.length ? ', key dates: ' + info.keys.map((o) => o.kd.title).join(', ') : ''}`,
      onclick: () => openDay(iso, ctx),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(iso, ctx); } }
    },
      h('div', { class: 'cal-date' }, h('span', { class: 'cal-num' }, String(Number(iso.slice(8)))),
        week ? h('span', { class: 'muted small' }, ' ' + fmtDate(iso).replace(/^\d+ /, '')) : null,
        flagBadge,
        info.cap && info.cap.expected && info.cap.available < info.cap.expected && leaderView && f.layers.leave ? h('span', { class: 'cal-cap muted', title: 'People available' }, `${info.cap.available}/${info.cap.expected}`) : null),
      chips);
    return cell;
  }

  // A key date on a day. The star keeps it recognisable without colour; a multi-day date says which day it is.
  function keyChip(o, iso, week) {
    const pos = dayOf(o, iso);
    const label = `${o.kd.title}${pos && week ? ` (day ${pos.day} of ${pos.of})` : ''}`;
    return h('button', {
      type: 'button', class: 'chip-cal chip-key',
      title: `${o.kd.title} · ${KEY_CATEGORY_LABEL[o.kd.category] || 'Other'}${pos ? ` · day ${pos.day} of ${pos.of}` : ''}${o.kd.teamId ? ` · ${teamName(o.kd.teamId)}` : ' · everyone'}${o.kd.note ? ' · ' + o.kd.note : ''}`,
      onclick: (e) => { e.stopPropagation(); canEditKey(o.kd) ? openKeyDatePanel(o.kd) : openDay(iso, context()); }
    }, '★ ' + label);
  }
  const canEditKey = (kd) => canManageKeyDateFor(user, kd.teamId);

  function taskChip(t, iso, ctx) {
    const done = t.statusCategory === 'done';
    const overdue = !done && OPEN_CATEGORIES.includes(t.statusCategory) && t.dueDate < todayISO();
    const owner = userById(t.ownerId);
    const away = !done && ownerAwayOnDue(t, owner, data.leaves.filter(isApproved), data.holidays);
    return h('button', {
      type: 'button',
      class: 'chip-cal chip-due' + (done ? ' chip-done' : '') + (overdue ? ' chip-overdue' : '') + (away ? ' chip-away' : ''),
      title: `${t.title} (${userName(t.ownerId)})${away ? ' · owner is on leave' : ''}${overdue ? ' · overdue' : ''}`,
      onclick: (e) => { e.stopPropagation(); openTaskPanel({ task: t, onSaved: () => { refreshFromState(); paint(); } }); }
    }, f.personId ? t.title : `${firstName(userName(t.ownerId))}: ${t.title}`, away ? ' ⚠' : '');
  }

  function refreshFromState() {
    data.open = data.open.map((t) => state.tasks.get(t.id) || t).filter((t) => OPEN_CATEGORIES.includes(t.statusCategory) && !t.archived);
    data.fin = data.fin.map((t) => state.tasks.get(t.id) || t);
  }

  // The side panel for one day: everything in full.
  function openDay(iso, ctx) {
    const info = dayInfo(iso, ctx);
    const panel = openPanel({ title: fmtDateLong(iso), subtitle: isWeekend(iso) ? 'Weekend' : undefined });
    const body = panel.body;
    const section = (title, ...kids) => add(h('section', { class: 'card-block' }, h('h3', null, title)), ...kids);
    if (info.keys.length) {
      body.append(section(`Key dates (${info.keys.length})`, h('ul', { class: 'plain-list' }, info.keys.map((o) => {
        const pos = dayOf(o, iso);
        return h('li', null, h('strong', null, '★ ' + o.kd.title),
          h('span', { class: 'muted' }, ` · ${KEY_CATEGORY_LABEL[o.kd.category] || 'Other'}${pos ? ` · day ${pos.day} of ${pos.of}` : ''}${o.kd.yearly ? ' · every year' : ''}${o.kd.teamId ? ` · ${teamName(o.kd.teamId)}` : ' · everyone'}`),
          o.kd.note ? h('div', { class: 'muted small' }, o.kd.note) : null,
          canEditKey(o.kd) ? h('button', { type: 'button', class: 'link-btn', onclick: () => { panel.close(); openKeyDatePanel(o.kd); } }, ' Edit') : null);
      }))));
    }
    if (canManageKeyDates(user)) body.append(h('p', null, h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => { panel.close(); openKeyDatePanel(null, iso); } }, '+ Key date on this day')));
    if (info.holiday) body.append(section('Holiday', h('p', null, info.holiday.name, info.holiday.teamId ? h('span', { class: 'muted' }, ` (${teamName(info.holiday.teamId)})`) : null)));
    if (info.flags.length) body.append(h('div', { class: 'notice' }, info.flags.map((x) => h('p', null, '! ' + FLAG_TEXT[x]))));
    if (info.cap && info.cap.expected) body.append(h('p', { class: 'muted' }, `${info.cap.available} of ${info.cap.expected} people available.`));
    const leaves = ctx.leaves.filter((l) => covers(l, iso));
    if (leaderView || leaves.length) {
      body.append(section(`On leave (${leaves.length})`, leaves.length
        ? h('ul', { class: 'plain-list' }, leaves.map((l) => h('li', null, h('strong', null, l.userName), ` · ${LEAVE_TYPE_LABEL[l.type]}`,
          l.half && l.half !== 'full' ? ' (half day)' : '', perm.isPendingLeave(l) ? h('span', { class: 'muted' }, ' · waiting for approval') : null)))
        : h('p', { class: 'muted' }, 'Nobody.')));
    }
    body.append(section(`Due (${info.tasks.length})`, info.tasks.length
      ? h('ul', { class: 'task-list' }, info.tasks.map((t) => h('li', null, h('button', { type: 'button', class: 'task-link', onclick: () => { panel.close(); openTaskPanel({ task: t, onSaved: () => { refreshFromState(); paint(); } }); } },
        h('span', { class: 'task-link-title' }, t.title), h('span', { class: 'task-link-meta' }, h('span', { class: 'muted' }, userName(t.ownerId)),
          t.statusCategory === 'done' ? h('span', { class: 'chip chip-ok' }, 'Completed') : null)))))
      : h('p', { class: 'muted' }, 'No deadlines.')));
  }

  function legendRow(showFlags) {
    return h('ul', { class: 'viz-legend cal-key' },
      h('li', null, h('span', { class: 'key-box chip-due' }, ''), 'Due'),
      h('li', null, h('span', { class: 'key-box chip-overdue' }, ''), 'Overdue'),
      h('li', null, h('span', { class: 'key-box chip-leave' }, ''), 'Leave (? = waiting for approval)'),
      h('li', null, h('span', { class: 'key-box chip-holiday' }, ''), 'Holiday'),
      h('li', null, h('span', { class: 'key-box chip-key' }, ''), '★ Key date'),
      showFlags ? h('li', null, h('span', { class: 'flag' }, '!'), 'Short-staffed or heavy day') : null,
      h('li', null, '⚠ Owner on leave when the task is due'));
  }

  // ------------------------------------------------------------------ key date editor
  function openKeyDatePanel(existing, presetDate) {
    const manageable = myTeams().filter((t) => canManageKeyDateFor(user, t.id));
    const everyoneOk = perm.isDirector(user);
    if (!manageable.length && !everyoneOk) { toast('You can add key dates for your own team once you lead a team.', 'error'); return; }
    const draft = existing
      ? { title: existing.title, startDate: existing.startDate, endDate: existing.endDate === existing.startDate ? '' : existing.endDate,
        teamId: existing.teamId || '', category: existing.category || 'other', yearly: existing.yearly === true, note: existing.note || '' }
      : { title: '', startDate: presetDate || todayISO(), endDate: '', teamId: everyoneOk ? '' : (manageable[0]?.id || ''), category: 'event', yearly: false, note: '' };
    const panel = openPanel({ title: existing ? 'Edit key date' : 'Add key date', subtitle: 'A reminder on the calendar. It is not a task and not a day off.' });
    const form = h('form', { class: 'task-form', novalidate: true });
    panel.body.append(form);
    const scopeOptions = [...(everyoneOk ? [{ value: '', label: 'Everyone (all teams)' }] : []), ...manageable.map((t) => ({ value: t.id, label: t.name }))];
    add(form,
      field('Title', h('input', { type: 'text', value: draft.title, maxlength: 100, placeholder: 'Semester 1 starts', oninput: (e) => { draft.title = e.target.value; } })),
      h('div', { class: 'grid-2' },
        field('First day', h('input', { type: 'date', value: draft.startDate, onchange: (e) => { draft.startDate = e.target.value; } })),
        field('Last day', h('input', { type: 'date', value: draft.endDate, onchange: (e) => { draft.endDate = e.target.value; } }),
          `Leave empty for a one-day date. At most ${MAX_SPAN_DAYS} days.`),
        field('Type', select(KEY_CATEGORIES.map((c) => ({ value: c, label: KEY_CATEGORY_LABEL[c] })), draft.category, { onchange: (e) => { draft.category = e.target.value; } })),
        field('Applies to', select(scopeOptions, draft.teamId, { onchange: (e) => { draft.teamId = e.target.value; } }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.yearly, onchange: (e) => { draft.yearly = e.target.checked; } }), ' Repeats every year on the same day'),
      field('Note', h('textarea', { rows: 2, maxlength: 500, value: draft.note, placeholder: 'Optional: venue, who attends, what to prepare', oninput: (e) => { draft.note = e.target.value; } })),
      h('div', { class: 'form-actions' },
        existing ? h('button', { type: 'button', class: 'btn btn-ghost-danger', onclick: async () => {
          if (!(await confirmDialog(`Remove “${existing.title}”? It stays in the activity log.`, { confirm: 'Remove', danger: true }))) return;
          try { await saveKeyDate(existing, { ...draft, active: false }); toast('Key date removed.', 'success'); panel.close(); await reloadKeys(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Remove') : h('span'),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Save changes' : 'Add key date')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await saveKeyDate(existing, draft);
        toast('Saved.', 'success'); panel.close(); await reloadKeys();
      } catch (err) { toast(errorMessage(err), 'error'); btn.disabled = false; }
    });
  }

  async function reloadKeys() {
    try { if (data) data.keyDates = await loadKeyDates({ force: true }); } catch (err) { toast(errorMessage(err), 'error'); }
    paint();
  }

  load();
  return () => {};
}

export { holidayFor };
