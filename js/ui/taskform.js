// The task panel: create a task, or open one to view, edit, comment and archive.
// Which fields can be changed depends on the signed-in person's role (perm.js);
// the Security Rules enforce the same limits on the server.

import { h, add, clear, fmtDateTime, uid20, todayISO } from '../core/util.js';
import { PRIORITIES, PRIORITY_LABEL, INITIAL_STATUS_ID } from '../core/model.js';
import * as perm from '../core/perm.js';
import {
  state, myTeams, ownerCandidates, activeStatuses, statusById, teamById, userName, projectName,
  userById, assignableUsers, userWithTeams, createTask, updateTask, loadComments, addComment
} from '../core/store.js';
import {
  openPanel, toast, errorMessage, confirmDialog, promptDialog, field, select, statusChip, spinner
} from './components.js';

const EDITABLE = ['title', 'description', 'teamId', 'projectId', 'ownerId', 'priority', 'status',
  'statusNote', 'startDate', 'dueDate', 'estimateHours', 'checklist'];

// Changing status from a list or board: asks for a reason when the status needs one.
export async function requestStatusChange(task, statusId) {
  const status = statusById(statusId);
  if (!status) return null;
  let note = task.statusNote || null;
  if (status.needsReason) {
    const reason = await promptDialog({
      title: `Why is this "${status.name}"?`, message: task.title,
      label: 'Short reason (required)', confirm: 'Save'
    });
    if (reason === null) return null;
    if (!reason) { toast('A reason is required for that status.', 'error'); return null; }
    note = reason;
  }
  try {
    const updated = await updateTask(task, { status: statusId, statusNote: note });
    if (updated) toast(`Moved to ${status.name}.`, 'success');
    return updated;
  } catch (err) {
    toast(errorMessage(err), 'error');
    return null;
  }
}

function blankDraft(defaults) {
  const user = state.user;
  const teams = myTeams();
  const teamId = defaults.teamId || teams[0]?.id || '';
  const owners = ownerCandidates(teamId);
  const ownerId = defaults.ownerId
    || (owners.some((o) => o.id === user.id) ? user.id : owners[0]?.id || '');
  return {
    title: '', description: '', teamId, projectId: defaults.projectId || '', ownerId,
    priority: 'medium', status: INITIAL_STATUS_ID, statusNote: '',
    startDate: todayISO(), dueDate: defaults.dueDate || '', estimateHours: '', checklist: []
  };
}

function draftFrom(task) {
  return {
    title: task.title, description: task.description || '', teamId: task.teamId,
    projectId: task.projectId || '', ownerId: task.ownerId, priority: task.priority,
    status: task.status, statusNote: task.statusNote || '', startDate: task.startDate || '',
    dueDate: task.dueDate || '', estimateHours: task.estimateHours ?? '',
    checklist: (task.checklist || []).map((c) => ({ ...c }))
  };
}

const snapshot = (d) => JSON.stringify(EDITABLE.map((k) => (d[k] === undefined || d[k] === null ? '' : d[k])));

// task = null opens a blank form. onSaved(task) runs after a successful save.
export function openTaskPanel({ task = null, defaults = {}, onSaved } = {}) {
  const isNew = !task;
  const user = state.user;
  if (isNew && !myTeams().length) {
    toast('You are not in a team yet, so you cannot create tasks. Ask the Director to add you to a team.', 'error');
    return;
  }
  if (isNew && !activeStatuses().length) {
    toast('The statuses are not set up yet. Ask the Director to set up the default statuses.', 'error');
    return;
  }

  let draft = isNew ? blankDraft(defaults) : draftFrom(task);
  const original = snapshot(draft);
  let saving = false;
  const dirty = () => snapshot(draft) !== original;

  const panel = openPanel({
    title: isNew ? 'New task' : 'Task',
    subtitle: isNew ? null : `${userName(task.createdBy)} created this on ${fmtDateTime(task.createdAt)}`,
    wide: true,
    onClose: async () => {
      if (saving || !dirty()) return true;
      return confirmDialog('You have unsaved changes. Close without saving?', {
        title: 'Discard changes?', confirm: 'Discard', cancel: 'Keep editing', danger: true
      });
    }
  });

  const form = h('form', { class: 'task-form', novalidate: true });
  const commentsBox = h('section', { class: 'comments' });
  panel.body.append(form, commentsBox);

  // What this person may change on this task.
  function can() {
    const team = teamById(draft.teamId);
    if (isNew) {
      return {
        details: true, deadline: true, reassign: !perm.isMember(user) || perm.ownsProject(user, draft.projectId), team: true,
        statuses: [], tick: true, archive: false, anything: true
      };
    }
    const statuses = perm.allowedStatuses(user, task, activeStatuses(), team);
    return {
      details: perm.canEditDetails(user, task),
      deadline: perm.canChangeDeadline(user, task),
      reassign: perm.canReassign(user, task),
      team: perm.isDirector(user),
      statuses,
      tick: perm.canTickChecklist(user, task),
      archive: perm.canArchive(user, task),
      anything: perm.canEditAnything(user, task, activeStatuses(), team)
    };
  }

  function bind(input, key, { redraw = false } = {}) {
    const handler = () => {
      draft[key] = input.value;
      if (redraw) draw(); else updateSave();
    };
    input.addEventListener(redraw ? 'change' : 'input', handler);
    return input;
  }

  let saveBtn;
  function updateSave() {
    if (!saveBtn) return;
    saveBtn.disabled = saving || !dirty() || (isNew && !draft.title.trim());
  }

  // A project owner hands work to anyone, in any team. The task then belongs to the team
  // of the person who gets it (the Security Rules require the owner to be in the task's team).
  const crossTeam = () => !!draft.projectId && perm.ownsProject(user, draft.projectId);

  function pickOwner(id) {
    draft.ownerId = id;
    if (crossTeam()) {
      const person = userById(id);
      const theirTeams = person?.teamIds || [];
      if (theirTeams.length && !theirTeams.includes(draft.teamId)) {
        const project = state.ref.projects.find((p) => p.id === draft.projectId);
        draft.teamId = theirTeams.includes(project?.teamId) ? project.teamId : theirTeams[0];
      }
    }
    draw();
  }

  // After the project changes, make sure the owner still belongs to the task's team.
  function pickProject(id) {
    draft.projectId = id;
    if (!crossTeam() && isNew && !ownerCandidates(draft.teamId).some((o) => o.id === draft.ownerId)) {
      const mine = ownerCandidates(draft.teamId);
      draft.ownerId = mine.some((o) => o.id === user.id) ? user.id : mine[0]?.id || '';
    }
    draw();
  }

  function draw() {
    const perms = can();
    const teams = myTeams();
    const cross = crossTeam();
    const owners = cross
      ? assignableUsers().map((u) => ({ ...u, label: userWithTeams(u) }))
      : ownerCandidates(draft.teamId);
    const projects = state.ref.projects.filter((p) => p.active !== false
      && (p.teamId === draft.teamId || perm.ownsProject(user, p.id)));
    if (!owners.some((o) => o.id === draft.ownerId)) {
      // Keep an existing owner visible even if they left the team.
      const existing = state.ref.users.find((u) => u.id === draft.ownerId);
      if (existing) owners.push(existing);
    }

    const titleInput = bind(h('input', {
      type: 'text', value: draft.title, maxlength: 200, placeholder: 'What needs to be done?',
      disabled: !perms.details, 'aria-label': 'Title', class: 'title-input'
    }), 'title');

    const teamOptions = [...(teams.length ? teams : [])];
    if (draft.teamId && !teamOptions.some((t) => t.id === draft.teamId)) {
      const t = teamById(draft.teamId); if (t) teamOptions.push(t);
    }
    const statusOptions = isNew
      ? [statusById(draft.status)].filter(Boolean)
      : (perms.statuses.some((s) => s.id === draft.status) ? perms.statuses
        : [statusById(draft.status), ...perms.statuses].filter(Boolean));
    const statusSelectable = !isNew && perms.statuses.length > 0;
    const selectedStatus = statusById(draft.status);
    const showNote = selectedStatus?.needsReason || (draft.statusNote || '').length > 0;

    clear(form);
    add(form,
      h('div', { class: 'field' }, titleInput),
      h('div', { class: 'grid-2' },
        field('Team', bind(select(teamOptions.map((t) => ({ value: t.id, label: t.name })), draft.teamId,
          { disabled: cross || (!perms.team && !isNew) }), 'teamId', { redraw: true }),
          cross ? 'Follows the person who gets the task.' : null),
        field('Owner', (() => {
          const sel = select(owners.map((o) => ({ value: o.id, label: o.label || o.name })), draft.ownerId,
            { disabled: !perms.reassign });
          sel.addEventListener('change', () => pickOwner(sel.value));
          return sel;
        })(), cross ? 'You own this project, so you can give this task to anyone.' : null),
        field('Project', (() => {
          const sel = select([{ value: '', label: 'No project' },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
            ...(draft.projectId && !projects.some((p) => p.id === draft.projectId)
              ? [{ value: draft.projectId, label: projectName(draft.projectId) || 'Unknown project' }] : [])],
            draft.projectId, { disabled: !perms.details });
          sel.addEventListener('change', () => pickProject(sel.value));
          return sel;
        })()),
        field('Priority', bind(select(PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })), draft.priority,
          { disabled: !perms.details }), 'priority')),
        field('Status', bind(select(statusOptions.map((s) => ({ value: s.id, label: s.name })), draft.status,
          { disabled: !statusSelectable }), 'status', { redraw: true }),
          isNew ? 'New tasks start as Pending.'
            : (!statusSelectable
              ? (perm.ownsProjectTask(user, task)
                ? 'As project owner you can approve or return this task once it is in Review.'
                : 'Only a leader can change the status of this task.')
              : null)),
        field('Estimate (hours)', bind(h('input', {
          type: 'number', min: 0, step: '0.5', value: draft.estimateHours, disabled: !perms.details, placeholder: 'optional'
        }), 'estimateHours')),
        field('Start date', bind(h('input', { type: 'date', value: draft.startDate, disabled: !perms.details }), 'startDate')),
        field('Due date', bind(h('input', { type: 'date', value: draft.dueDate, disabled: !perms.deadline }), 'dueDate'),
          !perms.deadline && !isNew ? 'Only a Team Leader or above can change deadlines.' : null)
      ),
      showNote ? field(selectedStatus?.needsReason ? 'Status note (required)' : 'Status note',
        bind(h('textarea', {
          rows: 2, maxlength: 500, value: draft.statusNote, disabled: !statusSelectable,
          placeholder: 'Why is it blocked, on hold or returned?'
        }), 'statusNote')) : null,
      field('Description', bind(h('textarea', {
        rows: 4, maxlength: 5000, value: draft.description, disabled: !perms.details,
        placeholder: 'Details, links, notes'
      }), 'description')),
      checklistSection(perms),
      h('div', { class: 'form-actions' },
        !isNew && perms.archive ? h('button', {
          type: 'button', class: 'btn btn-ghost-danger', onclick: archiveToggle
        }, task.archived ? 'Restore task' : 'Archive task') : h('span'),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.requestClose() }, perms.anything ? 'Cancel' : 'Close'),
        perms.anything ? (saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Create task' : 'Save changes')) : null
      )
    );
    updateSave();
  }

  function checklistSection(perms) {
    const list = h('ul', { class: 'checklist' });
    draft.checklist.forEach((item, index) => {
      const box = h('input', {
        type: 'checkbox', checked: item.done, disabled: !perms.tick, 'aria-label': `Done: ${item.text}`,
        onchange: () => { item.done = box.checked; updateSave(); counter.textContent = counts(); }
      });
      list.append(h('li', null,
        h('label', null, box, h('span', { class: item.done ? 'done' : '' }, item.text)),
        perms.details ? h('button', {
          type: 'button', class: 'icon-btn small', 'aria-label': `Remove ${item.text}`,
          onclick: () => { draft.checklist.splice(index, 1); draw(); }
        }, '×') : null));
    });
    const counts = () => `${draft.checklist.filter((c) => c.done).length}/${draft.checklist.length}`;
    const counter = h('span', { class: 'muted' }, draft.checklist.length ? counts() : '');
    let newItem;
    const add = () => {
      const text = newItem.value.trim();
      if (!text) return;
      draft.checklist.push({ id: uid20().slice(0, 8), text: text.slice(0, 200), done: false });
      draw();
      form.querySelector('.checklist-add input')?.focus();
    };
    return h('div', { class: 'field' },
      h('label', null, 'Checklist ', counter),
      list,
      perms.details ? h('div', { class: 'checklist-add' },
        newItem = h('input', {
          type: 'text', placeholder: 'Add a step and press Enter', maxlength: 200,
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }
        }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: add }, 'Add')) : null);
  }

  async function archiveToggle() {
    const word = task.archived ? 'Restore' : 'Archive';
    const ok = await confirmDialog(
      task.archived ? 'This task will return to the active lists.' : 'Archived tasks disappear from the active lists. Nothing is deleted, and the history stays in the activity log.',
      { title: `${word} this task?`, confirm: word, danger: !task.archived });
    if (!ok) return;
    try {
      const updated = await updateTask(task, { archived: !task.archived });
      toast(`Task ${task.archived ? 'restored' : 'archived'}.`, 'success');
      saving = true; panel.close();
      onSaved && onSaved(updated);
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || !dirty()) return;
    saving = true; updateSave();
    saveBtn.textContent = 'Saving...';
    try {
      const result = isNew ? await createTask(draft) : await updateTask(task, draft);
      toast(isNew ? 'Task created.' : (result ? 'Changes saved.' : 'No changes to save.'), 'success');
      panel.close();
      onSaved && onSaved(result);
    } catch (err) {
      saving = false;
      saveBtn.textContent = isNew ? 'Create task' : 'Save changes';
      updateSave();
      toast(errorMessage(err), 'error');
    }
  });

  draw();
  if (isNew) setTimeout(() => form.querySelector('.title-input')?.focus(), 60);
  else drawComments();

  // ---------------------------------------------------------------- comments
  async function drawComments() {
    const list = h('div', { class: 'comment-list' }, spinner('Loading comments'));
    const input = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Write a comment', 'aria-label': 'New comment' });
    const send = h('button', { type: 'button', class: 'btn btn-primary' }, 'Comment');
    clear(commentsBox);
    add(commentsBox, h('h3', null, 'Comments'), list,
      perm.canComment(user, task)
        ? h('div', { class: 'comment-form' }, input, send) : null);

    const show = (comment) => h('div', { class: 'comment' },
      h('div', { class: 'comment-head' }, h('strong', null, comment.authorName), h('span', { class: 'muted' }, fmtDateTime(comment.createdAt))),
      h('p', null, comment.text));

    try {
      const comments = await loadComments(task.id);
      clear(list);
      if (!comments.length) list.append(h('p', { class: 'muted empty-comments' }, 'No comments yet.'));
      comments.forEach((c) => list.append(show(c)));
    } catch (err) {
      clear(list);
      list.append(h('p', { class: 'error-text' }, errorMessage(err)));
    }

    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const comment = await addComment(task, input.value);
        list.querySelector('.empty-comments')?.remove();
        list.append(show(comment));
        input.value = '';
      } catch (err) { toast(errorMessage(err), 'error'); }
      send.disabled = false;
    });
  }

  return panel;
}

export { statusChip };
