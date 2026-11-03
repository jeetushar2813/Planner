// Reports: a weekly, monthly, quarterly, yearly or custom-date report for a team or one person.
// It is meant for meetings: read it on screen, save it as PDF (the browser's print window), or
// download it as an Excel workbook with the full task lists.
//
// Reads stay low: each team's open tasks, tasks finished since the previous period began, and
// leave are loaded once per period and kept for 5 minutes. Team and person filters are applied
// on screen without reading again.

import { h, add, clear, todayISO, fmtDate, fmtDateLong, daysBetween, toDate } from '../core/util.js';
import { LEAVE_TYPE_LABEL, roleLabel } from '../core/model.js';
import { PERIOD_KINDS, resolvePeriod, compileReport, compare } from '../core/report.js';
import { reportSheets, reportFileName } from '../core/reportExport.js';
import { buildXlsx, XLSX_MIME } from '../core/xlsx.js';
import { wasOnTime, pct } from '../core/metrics.js';
import {
  state, myTeams, userName, userById, teamName, statusName, projectName, ownedProjects, loadOpenTasks, loadFinished,
  loadTeamLeave, loadHolidays, loadProjectTasks, loadProjectDone
} from '../core/store.js';
import * as perm from '../core/perm.js';
import { toast, errorMessage, emptyState, spinner, select } from './components.js';
import { openTaskPanel } from './taskform.js';
import { hbars, columns, legend, tableView, noData } from './charts.js';

const CACHE_MINUTES = 5;
const LIST_LIMIT = 40;
let cache = null;                       // { key, at, data }
let memory = { teamId: '', personId: '', projectId: '', kind: 'this_month', from: '', to: '' };
let memoryUser = null;
let presetProject = null;

// "Project report" on My projects opens Reports already pointed at that project.
export function presetReportProject(projectId) { presetProject = projectId || ''; }

export function renderReports(container) {
  const user = state.user;
  const today = todayISO();
  if (memoryUser !== user.id) { memory = { teamId: '', personId: '', projectId: '', kind: 'this_month', from: addMonthStart(today), to: today }; memoryUser = user.id; }
  const f = memory;
  if (!f.from) f.from = addMonthStart(today);
  if (!f.to) f.to = today;
  // Team reports are for Assistant Team Leaders and above. Project owners (even plain members)
  // get reports for the projects they own. The Director can report on any project.
  const teamReports = perm.canSeeTeamReports(user);
  const teams = teamReports ? myTeams() : [];
  const projectChoices = () => (perm.isDirector(user)
    ? state.ref.projects.filter((p) => p.active !== false) : ownedProjects());
  if (presetProject !== null) { f.projectId = presetProject; f.teamId = ''; f.personId = ''; presetProject = null; }
  if (f.projectId && !projectChoices().some((p) => p.id === f.projectId)) f.projectId = '';
  if (!teamReports && !f.projectId) f.projectId = projectChoices()[0]?.id || '';
  if (f.teamId && !teams.some((t) => t.id === f.teamId)) f.teamId = '';
  const isDirector = perm.isDirector(user);

  let data = null, loading = true, failure = null;
  let model = null;
  const showAll = new Set();

  const controls = h('div', { class: 'toolbar report-controls' });
  const body = h('div', { class: 'report-doc' });
  const actions = h('div', { class: 'head-actions' });
  add(container,
    h('div', { class: 'page-head row-head report-head' },
      h('div', null,
        h('h1', null, 'Reports'),
        h('p', { class: 'muted' }, 'Progress of a team or one person for a week, month, quarter, year or any dates. Save it as PDF or Excel for meetings.')),
      actions),
    controls, body);

  // ------------------------------------------------------------------ loading
  const periodNow = () => resolvePeriod(f.kind, today, { from: f.from, to: f.to });

  async function load(force = false) {
    const period = periodNow();
    const key = `${user.id}|${f.projectId || ''}|${period.prev.from}`;
    if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MINUTES * 60000) {
      data = cache.data; loading = false; failure = null; paint(); return;
    }
    loading = true; failure = null; paint();
    try {
      if (f.projectId) {
        const [open, fin] = await Promise.all([loadProjectTasks(f.projectId), loadProjectDone(f.projectId, period.prev.from)]);
        data = { tasks: [...new Map([...open, ...fin].map((x) => [x.id, x])).values()], leaves: [], holidays: [], at: Date.now() };
        cache = { key, at: data.at, data };
        loading = false; paint(); return;
      }
      const perTeam = await Promise.all(teams.map(async (t) => {
        const [open, fin, leaves] = await Promise.all([
          loadOpenTasks({ teamId: t.id }), loadFinished({ teamId: t.id, fromISO: period.prev.from }), loadTeamLeave(t.id, period.prev.from)
        ]);
        return { open, fin, leaves };
      }));
      const uniq = (lists) => [...new Map(lists.flat().map((x) => [x.id, x])).values()];
      data = {
        tasks: uniq(perTeam.flatMap((x) => [x.open, x.fin])), leaves: uniq(perTeam.map((x) => x.leaves)),
        holidays: await loadHolidays(period.prev.from), at: Date.now()
      };
      cache = { key, at: data.at, data };
    } catch (err) { failure = err; toast(errorMessage(err), 'error'); }
    loading = false; paint();
  }

  // ----------------------------------------------------------------- controls
  function drawControls() {
    clear(controls);
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (f.personId && !people.some((p) => p.id === f.personId)) f.personId = '';
    const choices = projectChoices();
    const projectPick = choices.length && (teamReports || choices.length > 1) ? select(
      [...(teamReports ? [{ value: '', label: 'Team report' }] : []), ...choices.map((p) => ({ value: p.id, label: 'Project: ' + p.name }))], f.projectId,
      { 'aria-label': 'Report on', onchange: (e) => { f.projectId = e.target.value; f.personId = ''; load(); } }) : null;
    if (f.projectId) {
      const owners = [...new Set((data?.tasks || []).map((t) => t.ownerId))].map((id) => userById(id)).filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (f.personId && !owners.some((p) => p.id === f.personId)) f.personId = '';
      add(controls, projectPick,
        select([{ value: '', label: 'Everyone in the project' }, ...owners.map((p) => ({ value: p.id, label: p.name }))], f.personId,
          { 'aria-label': 'Person', onchange: (e) => { f.personId = e.target.value; paint(); } }),
        select(PERIOD_KINDS, f.kind, { 'aria-label': 'Period', onchange: (e) => { f.kind = e.target.value; load(); } }),
        f.kind === 'custom' ? h('span', { class: 'date-range' },
          h('input', { type: 'date', value: f.from, 'aria-label': 'From', max: today, onchange: (e) => { f.from = e.target.value || f.from; load(); } }),
          h('span', { class: 'muted' }, 'to'),
          h('input', { type: 'date', value: f.to, 'aria-label': 'To', onchange: (e) => { f.to = e.target.value || f.to; load(); } })) : null);
    } else add(controls, projectPick,
      teams.length > 1 || isDirector ? select([{ value: '', label: isDirector ? 'All teams' : 'All my teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))], f.teamId,
        { 'aria-label': 'Team', onchange: (e) => { f.teamId = e.target.value; f.personId = ''; paint(); } }) : null,
      select([{ value: '', label: 'Whole team' }, ...people.map((p) => ({ value: p.id, label: p.name }))], f.personId,
        { 'aria-label': 'Person', onchange: (e) => { f.personId = e.target.value; paint(); } }),
      select(PERIOD_KINDS, f.kind, { 'aria-label': 'Period', onchange: (e) => { f.kind = e.target.value; load(); } }),
      f.kind === 'custom' ? h('span', { class: 'date-range' },
        h('input', { type: 'date', value: f.from, 'aria-label': 'From', max: today, onchange: (e) => { f.from = e.target.value || f.from; load(); } }),
        h('span', { class: 'muted' }, 'to'),
        h('input', { type: 'date', value: f.to, 'aria-label': 'To', onchange: (e) => { f.to = e.target.value || f.to; load(); } })) : null);
    clear(actions);
    add(actions,
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh'),
      h('button', { type: 'button', class: 'btn btn-ghost', disabled: !model, onclick: downloadExcel }, 'Download Excel'),
      h('button', { type: 'button', class: 'btn btn-primary', disabled: !model, onclick: printPdf, title: 'Opens the print window: choose “Save as PDF”' }, 'Save as PDF'));
  }

  // ------------------------------------------------------------------- scope
  function scope() {
    if (f.projectId) {
      const owners = [...new Set((data?.tasks || []).map((t) => t.ownerId))].map((id) => userById(id)).filter(Boolean)
        .filter((u) => !f.personId || u.id === f.personId);
      const text = `Project: ${projectName(f.projectId)}${f.personId ? ` · ${userName(f.personId)}` : ''}`;
      return { scopeIds: [], people: owners, scopeText: text };
    }
    const scopeIds = f.teamId ? [f.teamId] : teams.map((t) => t.id);
    const people = state.ref.users.filter((u) => u.active !== false && u.role !== 'director' && (u.teamIds || []).some((id) => scopeIds.includes(id)))
      .filter((u) => !f.personId || u.id === f.personId);
    const scopeText = f.personId
      ? `${userName(f.personId)}${f.teamId ? ` (${teamName(f.teamId)})` : ''}`
      : f.teamId ? teamName(f.teamId) : (teams.length === 1 ? teams[0].name : isDirector ? 'All teams' : 'All my teams');
    return { scopeIds, people, scopeText };
  }

  const lookup = (scopeText) => ({
    user: userName, team: teamName, status: statusName, project: projectName,
    today, scope: scopeText, by: user.name
  });

  // ------------------------------------------------------------------- export
  function downloadExcel() {
    if (!model) return;
    try {
      const { scopeText } = scope();
      const bytes = buildXlsx(reportSheets(model, lookup(scopeText)));
      const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
      const a = h('a', { href: url, download: reportFileName(model, scopeText) + '.xlsx' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Excel file downloaded.', 'success');
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  function printPdf() {
    if (!model) return;
    const { scopeText } = scope();
    const before = document.title;
    document.title = reportFileName(model, scopeText);          // becomes the suggested PDF file name
    showAll.add('print');
    paint();
    const restore = () => { document.title = before; showAll.delete('print'); window.removeEventListener('afterprint', restore); paint(); };
    window.addEventListener('afterprint', restore);
    setTimeout(() => window.print(), 60);
  }

  // -------------------------------------------------------------------- paint
  function paint() {
    drawControls();
    clear(body);
    if (loading) { body.append(spinner('Preparing the report')); return; }
    if (failure || !data) { body.append(emptyState('Could not prepare the report', errorMessage(failure))); model = null; drawControls(); return; }
    if (!f.projectId && !teams.length) { body.append(emptyState('No team yet', 'You are not in a team, so there is nothing to report.')); return; }

    const period = periodNow();
    const { scopeIds, people, scopeText } = scope();
    const isProject = !!f.projectId;
    const tasks = isProject ? data.tasks : data.tasks.filter((t) => scopeIds.includes(t.teamId));
    model = compileReport({
      period, tasks, people, leaves: isProject ? [] : data.leaves.filter((l) => scopeIds.includes(l.teamId)), holidays: data.holidays, today,
      projects: state.ref.projects, teamIds: scopeIds
    });
    model.scopeKind = isProject ? 'project' : 'team';
    model.peopleInvolved = new Set(tasks.map((t) => t.ownerId)).size;
    drawControls();
    const hd = model.headline;

    add(body,
      h('header', { class: 'report-title' },
        h('p', { class: 'report-kicker' }, period.title),
        h('h2', null, period.name, ' · ', scopeText),
        h('p', { class: 'muted' }, period.label,
          period.inProgress ? ` · still running, figures are up to ${fmtDate(period.asOf)}` : ''),
        h('p', { class: 'muted small' }, `Prepared ${fmtDateLong(today)} by ${user.name} (${roleLabel(user)})`)),
      tiles(hd),
      section('Progress over the period', progressBlock()),
      section(f.personId ? 'Scorecard' : 'Individual scorecards', scorecards()),
      !isProject && model.projects.length ? section('By project', projectsBlock()) : null,
      section(`Tasks completed (${hd.completed})`, taskList('done', model.completed, ['Task', 'Owner', 'Project', 'Due', 'Completed', 'On time'],
        (t) => [titleCell(t), userName(t.ownerId), projectName(t.projectId) || '–', t.dueDate ? fmtDate(t.dueDate) : '–', fmtDate(t.completedDate),
          wasOnTime(t) ? 'Yes' : `Late by ${daysBetween(t.dueDate, t.completedDate)}d`], 'Nothing was completed in this period.')),
      section(`Still open today (${hd.openNow})`, taskList('open', model.open, ['Task', 'Owner', 'Status', 'Due', 'Overdue'],
        (t) => [titleCell(t), userName(t.ownerId), statusName(t.status), t.dueDate ? fmtDate(t.dueDate) : '–',
          t.dueDate && t.dueDate < today ? `${daysBetween(t.dueDate, today)}d` : '–'], 'No open tasks.')),
      isProject ? null : section('Leave and holidays', leaveBlock()),
      h('section', { class: 'card-block report-method' },
        h('h2', null, 'How these numbers are worked out'),
        h('ul', null,
          h('li', null, 'Completed: tasks that reached a Done status, counted on the day they were completed.'),
          h('li', null, 'Finished on time: completed on or before the due date. A task with no due date counts as on time.'),
          h('li', null, 'Created: tasks added in the period. Cancelled tasks are not included.'),
          h('li', null, 'Open and overdue are the position today. The app does not keep history, so they are not “as at” the end of the period.'),
          isProject ? h('li', null, 'People involved: everyone who owns at least one task in the project, whichever team they are in.')
            : h('li', null, 'Leave: approved working days in the period. Weekends and public holidays are not counted.'),
          h('li', null, `Compared with the previous period: ${fmtDate(period.prev.from)} to ${fmtDate(period.prev.to)}.`))));
  }

  const section = (title, content) => h('section', { class: 'card-block report-section' }, h('h2', null, title), content);
  const titleCell = (t) => h('button', { type: 'button', class: 'task-link-plain', onclick: () => openTaskPanel({ task: t, onSaved: () => load(true) }) }, t.title);

  // -------------------------------------------------------------------- tiles
  function tiles(hd) {
    const running = model.period.inProgress;
    const tile = (label, value, cmp, extra, neutral = false) => {
      const tone = cmp && !neutral && !running ? cmp.tone : '';      // no red or green while the period is still running
      return h('div', { class: 'tile' },
        h('span', { class: 'tile-label' }, label),
        h('span', { class: 'tile-value' }, String(value)),
        h('span', { class: 'tile-note' + (tone ? ' cmp-' + tone : ' muted') }, cmp ? cmp.text : extra || ''));
    };
    const oneDec = (n) => (n === null ? '–' : (Math.round(n * 10) / 10).toString());
    return h('div', { class: 'tiles report-tiles' },
      tile('Completed', hd.completed, compare(hd.completed, hd.completedPrev)),
      tile('Finished on time', pct(hd.onTimeRate),
        hd.onTimeRate === null ? { text: 'nothing completed', tone: '' } : compare(Math.round(hd.onTimeRate * 100), hd.onTimeRatePrev === null ? null : Math.round(hd.onTimeRatePrev * 100), { unit: ' pts' })),
      tile('Created', hd.created, compare(hd.created, hd.createdPrev), '', true),
      tile('Days to finish (avg)', oneDec(hd.avgDays), compare(hd.avgDays, hd.avgDaysPrev, { digits: 1, lowerIsBetter: true })),
      tile('Sent back for rework', hd.rework, compare(hd.rework, hd.reworkPrev, { lowerIsBetter: true })),
      model.scopeKind === 'project'
        ? tile('People involved', model.peopleInvolved, null, 'across teams')
        : tile('Leave taken (days)', hd.leaveDays, compare(hd.leaveDays, hd.leaveDaysPrev), '', true),
      tile('Open today', hd.openNow, null, 'position today'),
      tile('Overdue today', hd.overdueNow, null, hd.overdueNow ? 'need attention' : 'nothing overdue'));
  }

  // ----------------------------------------------------------------- progress
  function progressBlock() {
    const b = model.buckets;
    if (b.every((x) => x.total === 0 && x.created === 0)) return noData('No tasks were created or completed in this period.');
    const unitName = b[0]?.unit || 'week';
    const chart = b.some((x) => x.total > 0)
      ? columns({
        weeks: b.map((x) => ({
          label: x.label, a: x.onTime, b: x.late,
          tip: `${x.unit === 'day' ? fmtDate(x.start) : x.unit === 'month' ? x.label : `${fmtDate(x.start)} to ${fmtDate(x.end)}`}: ${x.total} completed (${x.onTime} on time, ${x.late} late), ${x.created} created`
        })),
        aName: 'On time', bName: 'Late', table: false, ariaLabel: `Tasks completed per ${unitName}, on time and late`
      }) : noData('No tasks were completed in this period.');
    const notes = [];
    if (model.busiest) notes.push(`Busiest ${unitName}: ${model.busiest.label} (${model.busiest.total} completed).`);
    if (model.quietest && model.quietest !== model.busiest) notes.push(`Quietest: ${model.quietest.label} (${model.quietest.total}).`);
    return h('div', null, chart,
      notes.length ? h('p', { class: 'muted small' }, notes.join(' ')) : null,
      tableView([`${unitName[0].toUpperCase()}${unitName.slice(1)} starting`, 'Created', 'Completed', 'Late'], b.map((x) => [fmtDate(x.start), x.created, x.total, x.late])));
  }

  // --------------------------------------------------------------- scorecards
  function scorecards() {
    const rows = model.people;
    if (!rows.length) return noData('No people in this view.');
    const num = (n) => (n === null ? '–' : (Math.round(n * 10) / 10).toString());
    return h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact report-table' },
      h('thead', null, h('tr', null, ['Person', 'Completed', 'On time', 'Days to finish', 'Rework', 'Created', 'Open today', 'Overdue today', ...(model.scopeKind === 'project' ? [] : ['Leave days'])]
        .map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, r.person.name),
        h('td', { class: 'num' }, r.done),
        h('td', { class: 'num' }, r.done ? `${pct(r.rate)}${r.late ? ` (${r.late} late)` : ''}` : '–'),
        h('td', { class: 'num' }, num(r.avgDays)),
        h('td', { class: 'num' }, r.rework),
        h('td', { class: 'num' }, r.created),
        h('td', { class: 'num' }, r.openNow),
        h('td', { class: 'num' }, r.overdueNow ? h('span', { class: 'due due-overdue' }, r.overdueNow) : 0),
        model.scopeKind === 'project' ? null : h('td', { class: 'num' }, r.leaveDays))))));
  }

  // ----------------------------------------------------------------- projects
  function projectsBlock() {
    const rows = model.projects;
    return h('div', null,
      rows.some((r) => r.done) ? hbars({ rows: rows.filter((r) => r.done).map((r) => ({ label: r.name, value: r.done, note: `${r.onTime} on time` })), ariaLabel: 'Tasks completed per project' }) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact report-table' },
        h('thead', null, h('tr', null, ['Project', 'Completed', 'On time', 'Open today', 'Overdue today'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.name), h('td', { class: 'num' }, r.done), h('td', { class: 'num' }, r.onTime),
          h('td', { class: 'num' }, r.openNow), h('td', { class: 'num' }, r.overdueNow)))))));
  }

  // ---------------------------------------------------------------- task lists
  function taskList(key, list, headers, cells, emptyText) {
    if (!list.length) return noData(emptyText);
    const all = showAll.has(key) || showAll.has('print');
    const rows = list.map((t, i) => h('tr', { class: i >= LIST_LIMIT && !all ? 'extra-row' : '' }, cells(t).map((c, ci) => h('td', { class: ci === 0 ? 'task-cell' : '' }, c))));
    return h('div', null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact report-table report-tasks' },
        h('thead', null, h('tr', null, headers.map((x) => h('th', null, x)))), h('tbody', null, rows))),
      list.length > LIST_LIMIT && !all
        ? h('button', { type: 'button', class: 'link-btn no-print', onclick: () => { showAll.add(key); paint(); } }, `Show all ${list.length}`) : null,
      list.length > LIST_LIMIT ? h('p', { class: 'muted small no-print' }, 'The PDF and the Excel file always include every task.') : null);
  }

  // ------------------------------------------------------------ leave/holidays
  function leaveBlock() {
    const types = model.leaveByType.filter((x) => x.days > 0);
    const total = model.headline.leaveDays;
    return h('div', null,
      total
        ? h('div', null,
          hbars({ rows: types.map((x) => ({ label: LEAVE_TYPE_LABEL[x.type], value: x.days })), ariaLabel: 'Leave taken by type, working days', unit: ' d' }),
          h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact report-table' },
            h('thead', null, h('tr', null, ['Person', 'Leave', 'Dates', 'Working days'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
            h('tbody', null, model.leaveRows.map(({ leave: l, days }) => h('tr', null,
              h('td', null, l.userName || userName(l.userId)), h('td', null, LEAVE_TYPE_LABEL[l.type] + (l.half && l.half !== 'full' ? ` (${l.half.toUpperCase()})` : '')),
              h('td', null, l.startDate === l.endDate ? fmtDate(l.startDate) : `${fmtDate(l.startDate)} to ${fmtDate(l.endDate)}`),
              h('td', { class: 'num' }, days)))))))
        : h('p', { class: 'muted' }, 'No approved leave in this period.'),
      h('h3', { class: 'report-sub' }, `Public holidays in the period (${model.holidays.length})`),
      model.holidays.length
        ? h('ul', { class: 'report-holidays' }, model.holidays.map((x) => h('li', null, h('strong', null, fmtDate(x.date)), ' ', x.name, x.teamId ? h('span', { class: 'muted' }, ` · ${teamName(x.teamId)}`) : null)))
        : h('p', { class: 'muted' }, 'None added for these dates.'));
  }

  paint();
  load();
  return () => {};
}

function addMonthStart(iso) { return iso.slice(0, 8) + '01'; }
