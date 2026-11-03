// Task templates and recurring tasks (Team Leader, Manager, Director).
// A template is a saved task. Give it a repeat and the Planner makes the task for you.

import { h, clear, todayISO, fmtDate, uid20 } from '../core/util.js';
import { PRIORITIES, PRIORITY_LABEL } from '../core/model.js';
import * as perm from '../core/perm.js';
import { REPEATS, REPEAT_LABEL, REPEAT_SHORT, MAX_TEMPLATE_OWNERS, dueOccurrence } from '../core/recurrence.js';
import { cleanTags, cleanTag, MAX_TAGS } from '../core/tags.js';
import {
  state, bus, myTeams, teamName, userName, templates, loadTemplates, saveTemplate, runRecurring, ownerCandidates,
  draftFromTemplate
} from '../core/store.js';
import { openPanel, toast, errorMessage, field, select, emptyState, spinner, confirmDialog } from './components.js';
import { openTaskPanel } from './taskform.js';

export function renderTemplates(container) {
  const user = state.user;
  const list = h('div');
  const status = h('p', { class: 'muted' });
  container.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'Task templates'),
      h('p', { class: 'muted' }, 'Save a task you make again and again. Give it a repeat (weekly, monthly...) and the Planner makes it for you when a Team Leader, Manager or Director opens the app.')),
    h('div', { class: 'toolbar toolbar-2' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => editor(null) }, '+ New template'),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => load(true) }, 'Refresh')),
    status, list);

  async function load(force = false) {
    clear(list).append(spinner('Loading templates'));
    try {
      if (force) {
        const made = await runRecurring({ force: true });
        if (made) toast(`${made} recurring task${made === 1 ? '' : 's'} made.`, 'success');
      }
      await loadTemplates({ force });
      draw();
    } catch (err) {
      clear(list).append(emptyState('Could not load templates', errorMessage(err)));
    }
  }

  function draw() {
    clear(list);
    const rows = templates.list;
    status.textContent = '';
    if (!rows.length) {
      list.append(emptyState('No templates yet', 'Press "New template", for example "Monthly attendance report", repeating every month.'));
      return;
    }
    for (const t of rows) {
      const off = t.active === false;
      list.append(h('div', { class: 'tpl-row' + (off ? ' off' : '') },
        h('div', null,
          h('h3', null, t.name, off ? h('span', { class: 'chip chip-off', style: { marginLeft: '8px' } }, 'Paused') : null),
          h('div', { class: 'tpl-meta' },
            h('span', null, teamName(t.teamId)),
            h('span', null, `For ${(t.ownerIds || []).map(userName).join(', ')}`),
            h('span', null, t.repeat === 'none' ? 'Used by hand' : `${REPEAT_SHORT[t.repeat]}${!off && t.nextDate ? `, next ${fmtDate(t.nextDate)}` : ''}`),
            t.lastRunDate ? h('span', null, `Last made for ${fmtDate(t.lastRunDate)}`) : null,
            t.dueInDays !== null && t.dueInDays !== undefined ? h('span', null, `Due ${t.dueInDays} day${t.dueInDays === 1 ? '' : 's'} after`) : null)),
        h('div', { class: 'tpl-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => useNow(t) }, 'Use now'),
          h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => editor(t) }, 'Edit'),
          h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => toggle(t) }, off ? 'Resume' : 'Pause'))));
    }
  }

  function useNow(t) {
    const ok = new Set(ownerCandidates(t.teamId).map((o) => o.id));
    const owners = (t.ownerIds || []).filter((id) => ok.has(id));
    openTaskPanel({
      defaults: { teamId: t.teamId, draft: { ...draftFromTemplate(t), ...(owners.length ? { ownerIds: owners, ownerId: owners[0] } : {}) } },
      onSaved: draw
    });
  }

  async function toggle(t) {
    const resuming = t.active === false;
    if (!resuming && !(await confirmDialog('No new tasks will be made from it until you resume it. Tasks already made stay as they are.', { title: `Pause "${t.name}"?`, confirm: 'Pause' }))) return;
    try {
      // Resuming after a long pause: skip the dates that went by instead of making a task for them.
      let next = t.nextDate;
      if (resuming && t.repeat !== 'none' && next) {
        const due = dueOccurrence({ ...t, active: true }, todayISO());
        if (due) next = due.next;
      }
      await saveTemplate(t, { ...t, active: resuming, nextDate: next });
      toast(resuming ? 'Resumed.' : 'Paused.', 'success');
      draw();
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  // ---- editor
  function editor(existing) {
    const teams = myTeams().filter((t) => perm.isDirector(user) || perm.inTeam(user, t.id));
    if (!teams.length) { toast('You are not in a team yet.', 'error'); return; }
    const d = existing
      ? { ...existing, projectId: existing.projectId || '', estimateHours: existing.estimateHours ?? '', dueInDays: existing.dueInDays ?? '',
        nextDate: existing.nextDate || todayISO(), tags: [...(existing.tags || [])], checklist: (existing.checklist || []).map((c) => ({ ...c })), ownerIds: [...(existing.ownerIds || [])] }
      : { name: '', teamId: teams[0].id, title: '', description: '', priority: 'medium', projectId: '', estimateHours: '', dueInDays: '',
        tags: [], checklist: [], ownerIds: [], repeat: 'monthly', nextDate: todayISO(), active: true };
    const panel = openPanel({ title: existing ? 'Edit template' : 'New template', wide: true });
    const form = h('form', { novalidate: true, class: 'task-form' });
    panel.body.append(form);
    let saving = false;

    const bind = (el, key, redraw = false) => { el.addEventListener(redraw ? 'change' : 'input', () => { d[key] = el.value; if (redraw) drawForm(); }); return el; };

    function drawForm() {
      const owners = ownerCandidates(d.teamId);
      d.ownerIds = d.ownerIds.filter((id) => owners.some((o) => o.id === id));
      const projects = state.ref.projects.filter((p) => p.active !== false && p.teamId === d.teamId);
      if (d.projectId && !projects.some((p) => p.id === d.projectId)) d.projectId = '';
      const tagInput = h('input', { type: 'text', maxlength: 30, placeholder: 'Add a tag and press Enter', 'aria-label': 'Add a tag',
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const t = cleanTag(tagInput.value); tagInput.value = ''; if (t && !d.tags.includes(t) && d.tags.length < MAX_TAGS) { d.tags.push(t); drawForm(); } } } });
      const stepsText = h('textarea', { rows: 4, placeholder: 'One step on each line', 'aria-label': 'Checklist steps, one per line' }, d.checklist.map((c) => c.text).join('\n'));
      stepsText.addEventListener('input', () => {
        d.checklist = stepsText.value.split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 60)
          .map((text, i) => ({ id: d.checklist[i]?.id || uid20().slice(0, 8), text }));
      });
      clear(form).append(
        field('Template name', bind(h('input', { type: 'text', maxlength: 100, value: d.name, placeholder: 'Monthly attendance report' }), 'name')),
        h('div', { class: 'grid-2' },
          field('Team', bind(select(teams.map((t) => ({ value: t.id, label: t.name })), d.teamId, { disabled: !!existing }), 'teamId', true)),
          field('Priority', bind(select(PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), d.priority), 'priority')),
          field('Project', bind(select([{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))], d.projectId), 'projectId')),
          field('Estimate (hours)', bind(h('input', { type: 'number', min: 0, step: '0.5', value: d.estimateHours, placeholder: 'optional' }), 'estimateHours')),
          field('Repeats', bind(select(REPEATS.map((r) => ({ value: r, label: REPEAT_LABEL[r] })), d.repeat), 'repeat', true)),
          d.repeat !== 'none' ? field('First task on', bind(h('input', { type: 'date', value: d.nextDate }), 'nextDate'),
            'The task is made on this date (or the next time a leader opens the app after it).') : null,
          field('Due after (days)', bind(h('input', { type: 'number', min: 0, max: 365, step: 1, value: d.dueInDays, placeholder: 'e.g. 5' }), 'dueInDays'),
            'Days between the day the task is made and its due date. Leave empty for no due date.')),
        field('Task title', bind(h('input', { type: 'text', maxlength: 200, value: d.title, placeholder: 'Attendance report for {month}' }), 'title'),
          'You can use {month}, {year} and {date}. They become the month, year or date of each task.'),
        h('div', { class: 'field' },
          h('label', null, 'Gets the task ', h('span', { class: 'muted' }, `${d.ownerIds.length} of ${MAX_TEMPLATE_OWNERS} at most`)),
          h('div', { class: 'check-list assignee-list' }, owners.map((o) => {
            const box = h('input', { type: 'checkbox', checked: d.ownerIds.includes(o.id), 'aria-label': o.name,
              onchange: () => {
                if (box.checked && d.ownerIds.length >= MAX_TEMPLATE_OWNERS) { box.checked = false; toast(`At most ${MAX_TEMPLATE_OWNERS} people.`, 'error'); return; }
                d.ownerIds = box.checked ? [...d.ownerIds, o.id] : d.ownerIds.filter((x) => x !== o.id);
                drawForm();
              } });
            return h('label', { class: 'check' }, box, ' ', o.name);
          })),
          h('p', { class: 'hint' }, 'Each person gets their own task every time.')),
        field('Description', bind(h('textarea', { rows: 3, maxlength: 5000, value: d.description, placeholder: 'Details, links, notes' }), 'description')),
        h('div', { class: 'field' }, h('label', null, 'Tags'),
          h('div', { class: 'tag-list' }, d.tags.map((t, i) => h('span', { class: 'chip chip-tag' }, '#' + t,
            h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove tag ${t}`, onclick: () => { d.tags.splice(i, 1); drawForm(); } }, '×')))),
          tagInput),
        field('Checklist', stepsText, 'Steps are added to every task.'),
        existing ? h('label', { class: 'check' }, (() => { const c = h('input', { type: 'checkbox', checked: d.active !== false }); c.addEventListener('change', () => { d.active = c.checked; }); return c; })(), ' Active (untick to pause)') : null,
        h('div', { class: 'form-actions' },
          h('div', { class: 'spacer' }),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.requestClose() }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Save changes' : 'Save template')));
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      saving = true;
      try {
        d.tags = cleanTags(d.tags);
        const saved = await saveTemplate(existing, d);
        toast(saved ? 'Template saved.' : 'No changes to save.', 'success');
        panel.close();
        // A template that is already due makes its first task straight away.
        const made = await runRecurring({ force: false });
        if (made) toast(`${made} task${made === 1 ? '' : 's'} made from the template.`, 'success');
        draw();
      } catch (err) { saving = false; toast(errorMessage(err), 'error'); }
    });
    drawForm();
  }

  const onTemplates = () => draw();
  bus.addEventListener('templates', onTemplates);
  load(false);
  return () => bus.removeEventListener('templates', onTemplates);
}
