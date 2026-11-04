// The task panel: create a task, or open one to view, edit, comment and archive.
// Which fields can be changed depends on the signed-in person's role (perm.js);
// the Security Rules enforce the same limits on the server.

import { h, add, clear, fmtDateTime, uid20, todayISO } from '../core/util.js';
import { PRIORITIES, PRIORITY_LABEL, INITIAL_STATUS_ID, OPEN_CATEGORIES } from '../core/model.js';
import * as perm from '../core/perm.js';
import { cleanTag, cleanTags, tagCounts, MAX_TAGS } from '../core/tags.js';
import { openBlockers, wouldLoop, MAX_BLOCKERS } from '../core/deps.js';
import { requiredHints, availabilityWarnings } from '../core/taskrules.js';
import { splitMentions, mentionQuery, suggestPeople } from '../core/mentions.js';
import {
  state, myTeams, ownerCandidates, activeStatuses, statusById, teamById, userName, projectName,
  userById, assignableUsers, userWithTeams, createTasks, updateTask, loadComments, addComment, mentionCandidates, teamForOwner, MAX_ASSIGNEES,
  availabilityData, canUseTemplates, loadTemplates, draftFromTemplate, loadOpenTasks
} from '../core/store.js';
import {
  openPanel, toast, errorMessage, confirmDialog, promptDialog, field, select, statusChip, spinner
} from './components.js';

const EDITABLE = ['title', 'description', 'teamId', 'projectId', 'ownerId', 'priority', 'status',
  'statusNote', 'startDate', 'dueDate', 'estimateHours', 'checklist', 'ownerIds', 'tags', 'blockedBy', 'bulk', 'bulkText'];

// Moving a task forward while something it waits for is unfinished: ask first.
const FORWARD = ['active', 'review', 'done'];
async function confirmBlockers(task, status) {
  if (!FORWARD.includes(status.category)) return true;
  const { open } = openBlockers(task, (id) => state.tasks.get(id));
  if (!open.length) return true;
  return confirmDialog(`This task is waiting for: ${open.map((t) => t.title).join(', ')}. Move it to "${status.name}" anyway?`,
    { title: 'Something it waits for is not finished', confirm: 'Move anyway', cancel: 'Not yet' });
}

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
  if (!(await confirmBlockers(task, status))) return null;
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
  const pre = { ...(defaults.draft || {}) };
  if (pre.teamId && !teams.some((t) => t.id === pre.teamId)) { delete pre.teamId; delete pre.projectId; }
  const teamId = pre.teamId || defaults.teamId || teams[0]?.id || '';
  const owners = ownerCandidates(teamId);
  const ownerId = defaults.ownerId
    || (owners.some((o) => o.id === user.id) ? user.id : owners[0]?.id || '');
  return {
    title: '', description: '', teamId, projectId: defaults.projectId || '', ownerId, ownerIds: ownerId ? [ownerId] : [],
    priority: 'medium', status: INITIAL_STATUS_ID, statusNote: '',
    startDate: todayISO(), dueDate: defaults.dueDate || '', estimateHours: '', checklist: [],
    tags: [], blockedBy: [], bulk: false, bulkText: '',
    ...pre
  };
}

// "Duplicate": a new task with the same details, not started, no due date, steps un-ticked.
function duplicateDraft(task) {
  const steps = (task.checklist || []).map((c) => {
    const { doneBy, doneAt, ...rest } = c; // eslint-disable-line no-unused-vars
    return { ...rest, id: uid20().slice(0, 8), done: false };
  });
  return {
    title: `${task.title} (copy)`.slice(0, 200), description: task.description || '', teamId: task.teamId,
    projectId: task.projectId || '', priority: task.priority, estimateHours: task.estimateHours ?? '',
    startDate: todayISO(), dueDate: '', tags: [...(task.tags || [])], checklist: steps
  };
}

function draftFrom(task) {
  return {
    title: task.title, description: task.description || '', teamId: task.teamId,
    projectId: task.projectId || '', ownerId: task.ownerId, priority: task.priority,
    status: task.status, statusNote: task.statusNote || '', startDate: task.startDate || '',
    dueDate: task.dueDate || '', estimateHours: task.estimateHours ?? '',
    checklist: (task.checklist || []).map((c) => ({ ...c })),
    tags: [...(task.tags || [])], blockedBy: [...(task.blockedBy || [])]
  };
}

const snapshot = (d) => JSON.stringify(EDITABLE.map((k) => (d[k] === undefined || d[k] === null ? '' : d[k])));

// task = null opens a blank form. onSaved(task) runs after a successful save.
export function openTaskPanel({ task = null, defaults = {}, onSaved } = {}) {  // defaults.draft pre-fills a new task
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
        statuses: [], tick: true, tickItem: () => true, assignSteps: true, archive: false, anything: true
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
      tickItem: (item) => perm.canTickItem(user, task, item),
      assignSteps: perm.canAssignSteps(user, task),
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
  // "Add several tasks at once": one title per line.
  const bulkLines = () => String(draft.bulkText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const howMany = () => (draft.bulk ? bulkLines().length : 1) * (multi() ? Math.max(draft.ownerIds.length, 1) : 1);
  const saveLabel = () => (!isNew ? 'Save changes' : (howMany() > 1 ? `Create ${howMany()} tasks` : 'Create task'));
  function updateSave() {
    const count = form.querySelector('.bulk-count');
    if (count) count.textContent = bulkLines().length ? `${bulkLines().length} title${bulkLines().length === 1 ? '' : 's'}.` : 'Type one title on each line.';
    if (!saveBtn) return;
    if (!saving) saveBtn.textContent = saveLabel();
    saveBtn.disabled = saving || !dirty() || (isNew && (draft.bulk ? !bulkLines().length : !draft.title.trim()));
  }

  // Templates a Team Leader saved (Assistant Team Leader and above can start from one).
  let templateList = [];
  if (isNew && canUseTemplates(user)) {
    loadTemplates().then((list) => { templateList = list; draw(); }).catch(() => {});
  }
  function applyTemplate(id) {
    const tpl = templateList.find((t) => t.id === id);
    if (!tpl) return;
    const d = draftFromTemplate(tpl);
    Object.assign(draft, {
      title: d.title, description: d.description, projectId: d.projectId, priority: d.priority,
      estimateHours: d.estimateHours, dueDate: d.dueDate, tags: d.tags, checklist: d.checklist
    });
    const ok = new Set(ownerCandidates(draft.teamId).map((o) => o.id));
    const mine = (tpl.ownerIds || []).filter((x) => ok.has(x));
    if (mine.length) { draft.ownerIds = multi() ? mine : [mine[0]]; draft.ownerId = mine[0]; }
    draw();
  }

  // Warning under the dates: the person is on leave, or it is a weekend or public holiday.
  let availToken = 0;
  async function refreshAvailability() {
    const box = form.querySelector('.avail-warning');
    if (!box) return;
    clear(box);
    const ids = isNew && multi() ? draft.ownerIds : [draft.ownerId];
    const changed = isNew || draft.dueDate !== (task.dueDate || '') || draft.ownerId !== task.ownerId;
    if (!draft.dueDate || !changed || !perm.isDeputyUp(user)) return;
    const people = ids.map(userById).filter(Boolean);
    if (!people.length) return;
    const token = ++availToken;
    const data = await availabilityData(people.flatMap((p) => p.teamIds || []));
    if (token !== availToken) return;
    const now = form.querySelector('.avail-warning');
    if (!now) return;
    clear(now);
    const warns = availabilityWarnings(people, draft.dueDate, data);
    if (warns.length) now.append(h('p', { class: 'notice notice-warn', role: 'status' }, '⚠ ', warns.join(' '), ' You can still save.'));
  }

  // ---- tags
  function tagsSection(perms) {
    const editable = perms.details;
    if (!editable && !draft.tags.length) return null;
    const list = h('div', { class: 'tag-list' });
    const render = () => {
      clear(list);
      draft.tags.forEach((t, i) => list.append(h('span', { class: 'chip chip-tag' }, '#' + t,
        editable ? h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove tag ${t}`,
          onclick: () => { draft.tags.splice(i, 1); render(); updateSave(); } }, '×') : null)));
    };
    const commit = () => {
      const t = cleanTag(input.value);
      input.value = '';
      if (!t || draft.tags.includes(t)) return;
      if (draft.tags.length >= MAX_TAGS) { toast(`At most ${MAX_TAGS} tags on a task.`, 'error'); return; }
      draft.tags.push(t); render(); updateSave();
    };
    const input = editable ? h('input', {
      type: 'text', list: 'tag-suggestions', maxlength: 30, placeholder: 'Add a tag and press Enter', 'aria-label': 'Add a tag',
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } },
      onblur: commit
    }) : null;
    const suggestions = tagCounts([...state.tasks.values()]).slice(0, 40);
    render();
    return h('div', { class: 'field tags' }, h('label', null, 'Tags'), list, input,
      h('datalist', { id: 'tag-suggestions' }, suggestions.map(([t]) => h('option', { value: t }))),
      editable ? h('p', { class: 'hint' }, 'Short labels such as admissions or event. They can be used to filter the task lists.') : null);
  }

  // ---- "waiting for" (dependencies)
  // The list of tasks to choose from is read on demand (once per team), to keep reads low.
  const teamTasksLoaded = new Set();
  function blockersSection(perms) {
    const editable = perms.details;
    if (!editable && !draft.blockedBy.length) return null;
    const lookup = (id) => state.tasks.get(id) || null;
    const box = h('div', { class: 'field blockers' });
    const render = () => {
      clear(box);
      const { open } = openBlockers({ blockedBy: draft.blockedBy }, lookup);
      box.append(h('label', null, 'Waiting for ', h('span', { class: 'muted' }, draft.blockedBy.length ? `${draft.blockedBy.length} task${draft.blockedBy.length === 1 ? '' : 's'}` : '')));
      if (draft.blockedBy.length) {
        const ul = h('ul', { class: 'blocker-list' });
        draft.blockedBy.forEach((id, i) => {
          const t = lookup(id);
          ul.append(h('li', { class: 'blocker' + (t && open.includes(t) ? ' open' : '') },
            t ? h('span', { class: 'blocker-title' }, t.title) : h('span', { class: 'muted' }, 'Another task (not loaded here)'),
            t ? statusChip(statusById(t.status)) : null,
            editable ? h('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Stop waiting for this task',
              onclick: () => { draft.blockedBy.splice(i, 1); render(); updateSave(); } }, '×') : null));
        });
        box.append(ul);
      }
      if (open.length) box.append(h('p', { class: 'notice notice-warn' }, `⚠ Not finished yet: ${open.map((t) => t.title).join(', ')}.`));
      if (editable && draft.blockedBy.length < MAX_BLOCKERS && !teamTasksLoaded.has(draft.teamId)) {
        const more = h('button', { type: 'button', class: 'btn btn-ghost small',
          onclick: async () => {
            more.disabled = true; more.textContent = 'Loading tasks...';
            try { await loadOpenTasks({ teamId: draft.teamId }); teamTasksLoaded.add(draft.teamId); } catch (err) { toast(errorMessage(err), 'error'); }
            render();
          } }, '+ Add a task this one waits for');
        box.append(more);
      } else if (editable && draft.blockedBy.length < MAX_BLOCKERS) {
        const choices = [...state.tasks.values()].filter((t) => !t.archived && OPEN_CATEGORIES.includes(t.statusCategory)
          && t.id !== task?.id && !draft.blockedBy.includes(t.id)
          && (t.teamId === draft.teamId || (draft.projectId && t.projectId === draft.projectId)))
          .sort((a, b) => a.title.localeCompare(b.title)).slice(0, 150);
        const sel = h('select', { 'aria-label': 'Add a task this one waits for',
          onchange: () => {
            const id = sel.value;
            if (!id) return;
            if (task && wouldLoop(task.id, id, lookup)) { toast('That would make two tasks wait for each other.', 'error'); sel.value = ''; return; }
            draft.blockedBy.push(id); render(); updateSave();
          } },
        [h('option', { value: '' }, choices.length ? '+ Add a task this one waits for...' : 'No other open tasks to choose from'),
          ...choices.map((t) => h('option', { value: t.id }, `${t.title} (${userName(t.ownerId).split(' ')[0]})`))]);
        sel.disabled = !choices.length;
        box.append(sel, h('p', { class: 'hint' }, 'Open tasks of this team, and of this project.'));
      }
    };
    render();
    return box;
  }

  // A project owner hands work to anyone, in any team. The task then belongs to the team
  // of the person who gets it (the Security Rules require the owner to be in the task's team).
  const crossTeam = () => !!draft.projectId && perm.ownsProject(user, draft.projectId);

  // On a new task, an Assistant Team Leader or above (or the owner of the project) can give the
  // task to several people at once. Each person gets their own task.
  const multi = () => isNew && (!perm.isMember(user) || crossTeam());

  function toggleOwner(id, on) {
    const set = new Set(draft.ownerIds);
    if (on) set.add(id); else set.delete(id);
    setOwners([...set]);
  }
  function setOwners(ids) {
    draft.ownerIds = ids;
    draft.ownerId = ids[0] || '';
    if (crossTeam() && ids[0]) draft.teamId = teamForOwner(draft, ids[0]);
    draw();
  }

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
    if (isNew) draft.ownerIds = draft.ownerId ? [draft.ownerId] : [];
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
    const several = multi();
    if (several) {
      // Only people who can get a task in this team stay ticked when the team or project changes.
      const ok = new Set(owners.map((o) => o.id));
      draft.ownerIds = draft.ownerIds.filter((id) => ok.has(id));
      draft.ownerId = draft.ownerIds[0] || '';
    } else if (!owners.some((o) => o.id === draft.ownerId)) {
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

    const req = isNew ? requiredHints(draft) : {};
    const reqText = (label, on) => (on ? `${label} (required)` : label);
    const templateChoices = templateList.filter((t) => t.active !== false && t.teamId === draft.teamId);
    const titleBlock = isNew && draft.bulk
      ? h('div', { class: 'field' },
        h('label', null, 'Titles, one task per line'),
        bind(h('textarea', { rows: 5, value: draft.bulkText, 'aria-label': 'Titles, one per line', placeholder: 'Prepare the slides\nBook the venue\nSend the invitations' }), 'bulkText'),
        h('p', { class: 'hint' }, h('span', { class: 'bulk-count' }), ' ',
          h('button', { type: 'button', class: 'link-btn', onclick: () => { draft.bulk = false; draw(); } }, 'Back to one task')))
      : h('div', { class: 'field' }, titleInput,
        isNew ? h('p', { class: 'hint' }, h('button', { type: 'button', class: 'link-btn', onclick: () => { draft.bulk = true; draw(); form.querySelector('textarea')?.focus(); } }, 'Add several tasks at once')) : null);

    clear(form);
    add(form,
      isNew && templateChoices.length ? field('Start from a template', (() => {
        const sel = select([{ value: '', label: 'Choose a template...' }, ...templateChoices.map((t) => ({ value: t.id, label: t.name }))], '');
        sel.addEventListener('change', () => applyTemplate(sel.value));
        return sel;
      })()) : null,
      titleBlock,
      h('div', { class: 'grid-2' },
        field('Team', bind(select(teamOptions.map((t) => ({ value: t.id, label: t.name })), draft.teamId,
          { disabled: cross || (!perms.team && !isNew) }), 'teamId', { redraw: true }),
          cross ? 'Follows the person who gets the task.' : null),
        several ? null : field('Owner', (() => {
          const sel = select(owners.map((o) => ({ value: o.id, label: o.label || o.name })), draft.ownerId,
            { disabled: !perms.reassign });
          sel.addEventListener('change', () => pickOwner(sel.value));
          return sel;
        })(), cross ? 'You own this project, so you can give this task to anyone.' : null),
        field(reqText('Project', req.project), (() => {
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
        field(reqText('Estimate (hours)', req.estimate), bind(h('input', {
          type: 'number', min: 0, step: '0.5', value: draft.estimateHours, disabled: !perms.details, placeholder: req.estimate ? 'required' : 'optional'
        }), 'estimateHours')),
        field('Start date', bind(h('input', { type: 'date', value: draft.startDate, disabled: !perms.details }), 'startDate')),
        field(reqText('Due date', req.dueDate), (() => {
          const input = bind(h('input', { type: 'date', value: draft.dueDate, disabled: !perms.deadline }), 'dueDate');
          input.addEventListener('change', refreshAvailability);
          return input;
        })(),
          !perms.deadline && !isNew ? 'Only a Team Leader or above can change deadlines.' : null)
      ),
      h('div', { class: 'avail-warning' }),
      several ? assigneesSection(owners, cross) : null,
      showNote ? field(selectedStatus?.needsReason ? 'Status note (required)' : 'Status note',
        bind(h('textarea', {
          rows: 2, maxlength: 500, value: draft.statusNote, disabled: !statusSelectable,
          placeholder: 'Why is it blocked, on hold or returned?'
        }), 'statusNote')) : null,
      tagsSection(perms),
      blockersSection(perms),
      field(reqText('Description', req.description), bind(h('textarea', {
        rows: 4, maxlength: 5000, value: draft.description, disabled: !perms.details,
        placeholder: 'Details, links, notes'
      }), 'description')),
      checklistSection(perms),
      h('div', { class: 'form-actions' },
        !isNew && perms.archive ? h('button', {
          type: 'button', class: 'btn btn-ghost-danger', onclick: archiveToggle
        }, task.archived ? 'Restore task' : 'Archive task') : h('span'),
        !isNew ? h('button', { type: 'button', class: 'btn btn-ghost', title: 'Make a new task with the same details', onclick: duplicate }, 'Duplicate') : null,
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.requestClose() }, perms.anything ? 'Cancel' : 'Close'),
        perms.anything ? (saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, saveLabel())) : null
      )
    );
    updateSave();
    refreshAvailability();
  }

  function duplicate() {
    if (dirty()) { toast('Save or discard your changes first, then duplicate.', 'info'); return; }
    saving = true;
    panel.close();
    openTaskPanel({ defaults: { draft: duplicateDraft(task) }, onSaved });
  }

  // "Assign to": tick one or more people. One separate task is made for each.
  function assigneesSection(owners, cross) {
    const chosen = new Set(draft.ownerIds);
    const rows = owners.map((o) => {
      const box = h('input', {
        type: 'checkbox', checked: chosen.has(o.id), 'aria-label': o.label || o.name,
        onchange: () => toggleOwner(o.id, box.checked)
      });
      return h('label', { class: 'check', 'data-name': (o.label || o.name).toLowerCase() }, box, ' ', o.label || o.name,
        o.id === user.id ? h('span', { class: 'muted' }, ' (you)') : null);
    });
    const search = owners.length > 8 ? h('input', {
      type: 'search', placeholder: 'Find a person', class: 'assignee-search', 'aria-label': 'Find a person',
      oninput: (e) => {
        const q = e.target.value.trim().toLowerCase();
        rows.forEach((row) => { row.style.display = !q || row.dataset.name.includes(q) ? '' : 'none'; });
      }
    }) : null;
    const n = draft.ownerIds.length;
    return h('div', { class: 'field assignees' },
      h('label', null, 'Assign to ', h('span', { class: 'muted' }, n ? `${n} selected` : 'nobody yet')),
      h('div', { class: 'assignee-tools' },
        search,
        h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => setOwners(owners.slice(0, MAX_ASSIGNEES).map((o) => o.id)) }, 'Everyone'),
        h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => setOwners([]) }, 'Clear')),
      h('div', { class: 'check-list assignee-list', role: 'group', 'aria-label': 'Assign to' }, rows),
      h('p', { class: 'hint' }, n > 1
        ? `${n} separate tasks will be created, one for each person, so each can track their own progress.`
        : (cross ? 'You own this project, so you can give this task to anyone, in any team.'
          : 'Tick everyone who should get this task. Each person gets their own copy.')));
  }

  // People a step can be given to: members of the task's team (plus anyone who already has one).
  function stepPeople() {
    const inTeam = state.ref.users.filter((u) => u.active !== false && (u.teamIds || []).includes(draft.teamId));
    for (const item of draft.checklist) {
      if (item.assigneeId && !inTeam.some((u) => u.id === item.assigneeId)) {
        const u = userById(item.assigneeId);
        if (u) inTeam.push({ ...u, name: `${u.name} (not in this team)` });
      }
    }
    return inTeam.sort((a, b) => a.name.localeCompare(b.name));
  }

  const stepWho = (item) => (item.assigneeId ? userName(item.assigneeId) : item.forTeam ? 'Whole team' : '');

  function checklistSection(perms) {
    const list = h('ul', { class: 'checklist' });
    const people = perms.assignSteps ? stepPeople() : [];
    draft.checklist.forEach((item, index) => {
      const mayTick = perms.tickItem(item);
      const box = h('input', {
        type: 'checkbox', checked: item.done, disabled: !mayTick, 'aria-label': `Done: ${item.text}`,
        onchange: () => {
          item.done = box.checked;
          if (item.done) { item.doneBy = user.id; item.doneAt = new Date().toISOString(); }
          else { delete item.doneBy; delete item.doneAt; }
          showDone(); updateSave(); counter.textContent = counts();
          label.querySelector('span').className = item.done ? 'done' : '';
        }
      });
      const value = item.assigneeId || (item.forTeam ? '*team' : '');
      const assign = perms.assignSteps ? h('select', {
        class: 'step-assign', 'aria-label': `Who does: ${item.text}`,
        onchange: (e) => {
          const v = e.target.value;
          delete item.assigneeId; delete item.forTeam;
          if (v === '*team') item.forTeam = true; else if (v) item.assigneeId = v;
          draw();
        }
      }, [
        h('option', { value: '', selected: value === '' }, 'Anyone'),
        h('option', { value: '*team', selected: value === '*team' }, 'Whole team (any one of them)'),
        ...people.map((u) => h('option', { value: u.id, selected: value === u.id }, u.name))
      ]) : (stepWho(item) ? h('span', { class: 'chip chip-step', title: item.forTeam ? 'Any one person in the team can do this step' : 'Given to this person' }, stepWho(item)) : null);
      const doneInfo = h('div', { class: 'step-done muted small' });
      const showDone = () => {
        doneInfo.textContent = item.done && item.doneBy
          ? `Done by ${userName(item.doneBy)}${item.doneAt ? ' on ' + fmtDateTime(item.doneAt) : ''}` : '';
      };
      showDone();
      const label = h('label', null, box, h('span', { class: item.done ? 'done' : '' }, item.text));
      list.append(h('li', { class: 'step' + (mayTick && !isNew && perm.isStepHelper(user, task, item) ? ' mine' : '') },
        label,
        assign,
        perms.details ? h('button', {
          type: 'button', class: 'icon-btn small', 'aria-label': `Remove ${item.text}`,
          onclick: () => { draft.checklist.splice(index, 1); draw(); }
        }, '×') : null,
        doneInfo));
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
    const helpNote = !perms.details && !isNew && draft.checklist.some((i) => perm.isStepHelper(user, task, i))
      ? h('p', { class: 'hint' }, 'The steps marked for you (or your team) are the ones you can tick.') : null;
    return h('div', { class: 'field' },
      h('label', null, 'Checklist ', counter),
      list,
      helpNote,
      perms.details ? h('div', { class: 'checklist-add' },
        newItem = h('input', {
          type: 'text', placeholder: 'Add a step and press Enter', maxlength: 200,
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }
        }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: add }, 'Add')) : null,
      perms.assignSteps && draft.checklist.length
        ? h('p', { class: 'hint' }, 'Give a step to one person, or to the whole team so any one of them can tick it off.') : null);
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
    if (!isNew && draft.status !== task.status && !(await confirmBlockers({ ...task, blockedBy: draft.blockedBy }, statusById(draft.status)))) return;
    saving = true; updateSave();
    saveBtn.textContent = 'Saving...';
    try {
      const result = isNew
        ? await createTasks({ ...draft, titles: draft.bulk ? bulkLines() : null }, multi() ? draft.ownerIds : [draft.ownerId])
        : await updateTask(task, draft);
      if (isNew) {
        const made = result.length;
        toast(made > 1 ? `${made} tasks created.` : 'Task created.', 'success');
        if (result.droppedSteps) toast('Some steps were left unassigned because that person is not in the same team as the task.', 'info');
      } else toast(result ? 'Changes saved.' : 'No changes to save.', 'success');
      panel.close();
      onSaved && onSaved(isNew ? result[0] : result);
    } catch (err) {
      saving = false;
      saveBtn.textContent = saveLabel();
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
    const input = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Write a comment. Type @ to mention a teammate.', 'aria-label': 'New comment' });
    const send = h('button', { type: 'button', class: 'btn btn-primary' }, 'Comment');
    const suggest = h('div', { class: 'mention-pop', role: 'listbox', 'aria-label': 'People you can mention', hidden: true });
    const names = mentionCandidates(task).concat([{ id: user.id, name: user.name }]);   // for highlighting, yourself included
    const people = perm.canComment(user, task) ? mentionCandidates(task) : [];
    clear(commentsBox);
    add(commentsBox, h('h3', null, 'Comments'), list,
      perm.canComment(user, task)
        ? h('div', { class: 'comment-form' }, h('div', { class: 'mention-wrap' }, input, suggest), send) : null);

    // Comments show the names that were mentioned in a highlighted colour. People are those who can read this task.
    const show = (comment) => h('div', { class: 'comment' },
      h('div', { class: 'comment-head' }, h('strong', null, comment.authorName), h('span', { class: 'muted' }, fmtDateTime(comment.createdAt))),
      h('p', null, ...splitMentions(comment.text, names)
        .map((piece) => (piece.mention ? h('span', { class: 'mention' }, piece.text) : piece.text))));

    // ---- suggestions while typing "@..."
    let shown = [];
    const hide = () => { suggest.hidden = true; shown = []; };
    const choose = (p) => {
      const q = mentionQuery(input.value, input.selectionStart);
      if (!q) return hide();
      const before = input.value.slice(0, q.start);
      const after = input.value.slice(input.selectionStart);
      input.value = `${before}@${p.name} ${after}`;
      const caret = before.length + p.name.length + 2;
      input.setSelectionRange(caret, caret);
      input.focus();
      hide();
    };
    const refreshSuggest = () => {
      const q = mentionQuery(input.value, input.selectionStart);
      if (!q || !people.length) return hide();
      shown = suggestPeople(people, q.query);
      if (!shown.length) return hide();
      clear(suggest);
      shown.forEach((p, i) => suggest.append(h('button', {
        type: 'button', class: 'mention-option' + (i === 0 ? ' first' : ''), role: 'option',
        onmousedown: (e) => { e.preventDefault(); choose(p); }
      }, p.name)));
      suggest.hidden = false;
    };
    input.addEventListener('input', refreshSuggest);
    input.addEventListener('click', refreshSuggest);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', (e) => {
      if (suggest.hidden || !shown.length) return;
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(shown[0]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
    });

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
        hide();
        const n = (comment.mentions || []).length;
        if (n) toast(`${n} ${n === 1 ? 'person' : 'people'} will see this in their Alerts.`, 'success');
      } catch (err) { toast(errorMessage(err), 'error'); }
      send.disabled = false;
    });
  }

  return panel;
}

export { statusChip };
