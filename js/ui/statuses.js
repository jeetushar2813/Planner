// Statuses (Director only): add statuses beyond the basic four, rename, recolour,
// reorder, switch off. Each status has a category, and reports use the category.

import { h, clear } from '../core/util.js';
import { CATEGORIES, CATEGORY_LABEL, INITIAL_STATUS_ID } from '../core/model.js';
import { state, bus, createStatus, updateStatus, seedDefaultStatuses } from '../core/store.js';
import { openPanel, toast, errorMessage, field, select, statusChip, emptyState } from './components.js';

const CATEGORY_HELP = {
  todo: 'Not started yet.',
  active: 'Being worked on.',
  review: 'Waiting for someone to check it.',
  paused: 'Stopped on purpose. Left out of overdue counts.',
  done: 'Finished. A leader approves this unless the team switched the approval gate off.',
  closed: 'No longer needed. Left out of productivity figures.'
};

export function renderStatuses(container) {
  const content = h('div');
  container.append(
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'Statuses'),
        h('p', { class: 'muted' }, 'The stages a task moves through. Add your own; the category keeps reports consistent.')),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => statusPanel(null) }, '+ Add status'))),
    content);

  function paint() {
    clear(content);
    const list = state.ref.statuses;
    if (!list.length) {
      content.append(emptyState('No statuses yet', 'Create the standard set to get started. You can add more afterwards.',
        h('button', { type: 'button', class: 'btn btn-primary', onclick: async (e) => {
          e.target.disabled = true;
          try { await seedDefaultStatuses(); toast('Default statuses created.', 'success'); paint(); }
          catch (err) { toast(errorMessage(err), 'error'); e.target.disabled = false; }
        } }, 'Set up default statuses')));
      return;
    }
    const rows = list.map((s, i) => h('tr', { class: s.active === false ? 'row-muted' : '' },
      h('td', null, statusChip(s)),
      h('td', null, CATEGORY_LABEL[s.category]),
      h('td', null, s.needsReason ? 'Yes' : h('span', { class: 'muted' }, 'No')),
      h('td', null, s.active === false ? h('span', { class: 'chip chip-off' }, 'Off') : h('span', { class: 'chip chip-on' }, 'On')),
      h('td', { class: 'nowrap' },
        h('button', { type: 'button', class: 'icon-btn small', disabled: i === 0, 'aria-label': `Move ${s.name} up`, onclick: () => move(i, -1) }, '↑'),
        h('button', { type: 'button', class: 'icon-btn small', disabled: i === list.length - 1, 'aria-label': `Move ${s.name} down`, onclick: () => move(i, 1) }, '↓'),
        h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => statusPanel(s) }, 'Edit'))));
    content.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Category'), h('th', null, 'Needs a reason'), h('th', null, 'In use'), h('th'))),
      h('tbody', null, rows))));
    content.append(h('div', { class: 'help-grid' }, CATEGORIES.map((c) =>
      h('p', null, h('strong', null, CATEGORY_LABEL[c] + ': '), CATEGORY_HELP[c]))));
  }

  async function move(index, delta) {
    const list = state.ref.statuses;
    const a = list[index], b = list[index + delta];
    if (!a || !b) return;
    try {
      await updateStatus(a, { order: b.order });
      await updateStatus(b, { order: a.order });
    } catch (err) { toast(errorMessage(err), 'error'); }
    paint();
  }

  function statusPanel(status) {
    const isNew = !status;
    const panel = openPanel({ title: isNew ? 'Add status' : 'Edit status' });
    const draft = status
      ? { name: status.name, category: status.category, color: status.color || '#64748b', needsReason: !!status.needsReason, active: status.active !== false }
      : { name: '', category: 'active', color: '#2563eb', needsReason: false, active: true };
    const protectedStatus = status && status.id === INITIAL_STATUS_ID;
    const help = h('p', { class: 'hint' }, CATEGORY_HELP[draft.category]);
    const form = h('form', { class: 'task-form', novalidate: true },
      field('Name', h('input', { type: 'text', value: draft.name, maxlength: 60, oninput: (e) => { draft.name = e.target.value; } })),
      field('Category', select(CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })), draft.category, {
        onchange: (e) => { draft.category = e.target.value; help.textContent = CATEGORY_HELP[draft.category]; }
      }), null),
      help,
      field('Colour', h('input', { type: 'color', value: draft.color, oninput: (e) => { draft.color = e.target.value; } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.needsReason, onchange: (e) => { draft.needsReason = e.target.checked; } }),
        ' Ask for a short reason when a task is set to this status'),
      !isNew ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.active, disabled: protectedStatus, onchange: (e) => { draft.active = e.target.checked; } }),
        ' Status can be chosen', protectedStatus ? h('span', { class: 'muted' }, ' (new tasks always start as Pending)') : null) : null,
      h('div', { class: 'form-actions' }, h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Add status' : 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (isNew) await createStatus(draft);
        else await updateStatus(status, { ...draft, name: draft.name.trim() });
        toast('Saved.', 'success'); panel.close(); paint();
      } catch (err) { toast(errorMessage(err), 'error'); }
    });
    panel.body.append(form);
  }

  paint();
  const onRef = () => paint();
  bus.addEventListener('ref', onRef);
  return () => bus.removeEventListener('ref', onRef);
}
