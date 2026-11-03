// Teams and projects.
// Director: creates teams, switches the approval gate, activates or deactivates.
// Manager: renames their own teams. Leaders and above: manage projects for their teams.

import { h, clear } from '../core/util.js';
import * as perm from '../core/perm.js';
import {
  state, bus, teamName, userName, createTeam, updateTeam, createProject, updateProject, myTeams, assignableUsers, userWithTeams
} from '../core/store.js';
import { openPanel, toast, errorMessage, field, select, emptyState } from './components.js';

export function renderTeams(container) {
  const user = state.user;
  const teamsBox = h('section', { class: 'card-block' });
  const projectsBox = h('section', { class: 'card-block' });
  container.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'Teams & projects'),
      h('p', { class: 'muted' }, 'Teams decide who sees which tasks. Projects group related tasks inside a team.')),
    teamsBox, projectsBox);

  function drawTeams() {
    clear(teamsBox);
    const canCreate = perm.canCreateTeams(user);
    const teams = canCreate ? state.ref.teams : myTeams();
    teamsBox.append(h('div', { class: 'row-head' },
      h('h2', null, 'Teams'),
      canCreate ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => teamPanel(null) }, '+ Add team') : null));
    if (!teams.length) { teamsBox.append(emptyState('No teams yet', canCreate ? 'Create the first team to get started.' : 'You are not in a team yet.')); return; }
    const rows = teams.map((t) => {
      const members = state.ref.users.filter((u) => u.active !== false && (u.teamIds || []).includes(t.id));
      const gate = h('input', {
        type: 'checkbox', checked: t.approvalGate !== false, disabled: !perm.isDirector(user),
        'aria-label': `Leader approval required in ${t.name}`,
        onchange: async () => {
          try { await updateTeam(t, { approvalGate: gate.checked }); toast('Saved.', 'success'); }
          catch (err) { gate.checked = !gate.checked; toast(errorMessage(err), 'error'); }
        }
      });
      return h('tr', { class: t.active === false ? 'row-muted' : '' },
        h('td', null, h('strong', null, t.name), t.active === false ? h('span', { class: 'chip chip-off' }, 'Inactive') : null),
        h('td', null, members.length ? members.map((m) => m.name).join(', ') : h('span', { class: 'muted' }, 'No one yet')),
        h('td', null, h('label', { class: 'check' }, gate, ' Leader approves completion')),
        h('td', null, perm.canEditTeam(user, t) ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => teamPanel(t) }, 'Edit') : null));
    });
    teamsBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Team'), h('th', null, 'Members'), h('th', null, 'Approval gate'), h('th'))),
      h('tbody', null, rows))),
      h('p', { class: 'hint' }, 'With the approval gate on, members move work up to In Review and a leader marks it Completed. Switch it off for a team that should complete its own tasks.'));
  }

  function teamPanel(team) {
    const isNew = !team;
    const panel = openPanel({ title: isNew ? 'Add team' : 'Edit team' });
    const nameInput = h('input', { type: 'text', value: team?.name || '', maxlength: 80, placeholder: 'For example, Content Team' });
    const activeBox = h('input', { type: 'checkbox', checked: team ? team.active !== false : true, disabled: !perm.isDirector(user) });
    const form = h('form', { class: 'task-form', novalidate: true },
      field('Team name', nameInput),
      !isNew ? h('label', { class: 'check' }, activeBox, ' Team is active') : null,
      h('div', { class: 'form-actions' }, h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Create team' : 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (isNew) await createTeam(nameInput.value);
        else await updateTeam(team, { name: nameInput.value.trim(), active: activeBox.checked });
        toast('Saved.', 'success'); panel.close(); drawTeams(); drawProjects();
      } catch (err) { toast(errorMessage(err), 'error'); }
    });
    panel.body.append(form);
    setTimeout(() => nameInput.focus(), 60);
  }

  function drawProjects() {
    clear(projectsBox);
    const canManage = perm.canManageProjects(user);
    const visible = new Set(myTeams().map((t) => t.id));
    // Projects of my teams, plus any project I own (it may belong to another team).
    const projects = state.ref.projects.filter((p) => visible.has(p.teamId) || perm.ownsProject(user, p.id));
    projectsBox.append(h('div', { class: 'row-head' },
      h('h2', null, 'Projects'),
      canManage ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => projectPanel(null) }, '+ Add project') : null));
    if (!projects.length) { projectsBox.append(emptyState('No projects yet', canManage ? 'A project groups related tasks, for example a product or a term.' : 'Projects are added by Team Leaders and above.')); return; }
    projectsBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Project'), h('th', null, 'Team'), h('th', null, 'Owner'), h('th', null, 'Description'), h('th'))),
      h('tbody', null, projects.map((p) => h('tr', { class: p.active === false ? 'row-muted' : '' },
        h('td', null, h('strong', null, p.name), p.active === false ? h('span', { class: 'chip chip-off' }, 'Inactive') : null),
        h('td', null, teamName(p.teamId)),
        h('td', null, p.ownerId ? userName(p.ownerId) : h('span', { class: 'muted' }, 'Not set')),
        h('td', { class: 'muted' }, p.description || ''),
        h('td', null, canManage && perm.inScope(user, p.teamId)
          ? h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => projectPanel(p) }, 'Edit') : null)))))));
  }

  function projectPanel(project) {
    const isNew = !project;
    const panel = openPanel({ title: isNew ? 'Add project' : 'Edit project' });
    const teams = myTeams();
    const nameInput = h('input', { type: 'text', value: project?.name || '', maxlength: 120 });
    const teamSelect = select(teams.map((t) => ({ value: t.id, label: t.name })), project?.teamId || teams[0]?.id || '', { disabled: !isNew && !perm.isDirector(user) });
    const description = h('textarea', { rows: 3, maxlength: 1000, value: project?.description || '' });
    // One owner per project: any active person, in any team. They see every task in the
    // project, hand tasks out, and approve work in Review.
    const people = assignableUsers();
    const ownerSelect = select([{ value: '', label: 'No owner' },
      ...people.map((u) => ({ value: u.id, label: userWithTeams(u) })),
      ...(project?.ownerId && !people.some((u) => u.id === project.ownerId)
        ? [{ value: project.ownerId, label: userName(project.ownerId) }] : [])], project?.ownerId || '');
    const activeBox = h('input', { type: 'checkbox', checked: project ? project.active !== false : true });
    const form = h('form', { class: 'task-form', novalidate: true },
      field('Project name', nameInput), field('Team', teamSelect),
      field('Project owner', ownerSelect, 'The owner sees every task in this project, even in other teams, can hand tasks to anyone, and approves or returns work in Review. They cannot edit other people\'s task details.'),
      field('Description', description),
      !isNew ? h('label', { class: 'check' }, activeBox, ' Project is active') : null,
      h('div', { class: 'form-actions' }, h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Create project' : 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (isNew) await createProject({ name: nameInput.value, teamId: teamSelect.value, description: description.value, ownerId: ownerSelect.value || null });
        else await updateProject(project, { name: nameInput.value.trim(), teamId: teamSelect.value, description: description.value, ownerId: ownerSelect.value || null, active: activeBox.checked });
        toast('Saved.', 'success'); panel.close(); drawProjects();
      } catch (err) { toast(errorMessage(err), 'error'); }
    });
    panel.body.append(form);
    setTimeout(() => nameInput.focus(), 60);
  }

  drawTeams();
  drawProjects();
  const onRef = () => { drawTeams(); drawProjects(); };
  bus.addEventListener('ref', onRef);
  return () => bus.removeEventListener('ref', onRef);
}
