// People (Director only): add team members with their own login, change roles and teams,
// deactivate accounts.

import { h, add, clear, fmtAgo, uid20 } from '../core/util.js';
import { ROLES, ROLE_LABEL } from '../core/model.js';
import {
  state, bus, teamName, createPerson, updatePerson, loadRefData, getBackend, isDemo
} from '../core/store.js';
import {
  openPanel, toast, errorMessage, field, select, dialog, emptyState, confirmDialog
} from './components.js';

const ROLE_HELP = {
  director: 'Sees and manages everything. Creates accounts.',
  manager: 'Manages the teams ticked below.',
  leader: 'Leads the team ticked below: assigns, edits, approves.',
  asst_leader: 'Deputy: assigns and edits, but cannot change deadlines or archive.',
  member: 'Updates their own tasks. Cannot alter task details.'
};

function tempPassword() {
  const words = ['maple', 'river', 'cloud', 'stone', 'lemon', 'tiger', 'amber', 'ocean'];
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return `${words[bytes[0] % words.length]}-${words[bytes[1] % words.length]}-${100 + (bytes[2] % 900)}`;
}

export function renderPeople(container) {
  const content = h('div');
  container.append(
    h('div', { class: 'page-head row-head' },
      h('div', null,
        h('h1', null, 'People'),
        h('p', { class: 'muted' }, 'Everyone who can sign in. Accounts are deactivated, never deleted, so history stays attached to a name.')),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => { await loadRefData({ force: true }); paint(); toast('List refreshed.'); } }, 'Refresh'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openPersonPanel(null, paint) }, '+ Add person'))),
    content);

  function paint() {
    clear(content);
    const users = state.ref.users;
    if (!users.length) { content.append(emptyState('No people yet', 'Add the first person.')); return; }
    const rows = users.map((u) => h('tr', { class: u.active === false ? 'row-muted' : '' },
      h('td', null, h('strong', null, u.name), h('div', { class: 'sub muted' }, u.email)),
      h('td', null, ROLE_LABEL[u.role] || u.role),
      h('td', null, (u.teamIds || []).map(teamName).join(', ') || h('span', { class: 'muted' }, 'None')),
      h('td', null, u.lastLoginAt ? fmtAgo(u.lastLoginAt) : h('span', { class: 'muted' }, 'Never')),
      h('td', null, u.active === false ? h('span', { class: 'chip chip-off' }, 'Deactivated') : h('span', { class: 'chip chip-on' }, 'Active')),
      h('td', null, h('button', { type: 'button', class: 'btn btn-ghost small', onclick: () => openPersonPanel(u, paint) }, 'Edit'))));
    content.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tasks' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Role'), h('th', null, 'Teams'), h('th', null, 'Last sign-in'), h('th', null, 'Status'), h('th'))),
      h('tbody', null, rows))));
  }

  paint();
  const onRef = () => paint();
  bus.addEventListener('ref', onRef);
  return () => bus.removeEventListener('ref', onRef);
}

function openPersonPanel(person, onDone) {
  const isNew = !person;
  const isSelf = person && person.id === state.user.id;
  const draft = isNew
    ? { name: '', email: '', role: 'member', teamIds: [], password: tempPassword(), sendReset: true }
    : { name: person.name, email: person.email, role: person.role, teamIds: [...(person.teamIds || [])], active: person.active !== false };

  const panel = openPanel({ title: isNew ? 'Add person' : 'Edit person', subtitle: isNew ? 'Creates a login for them.' : person.email });
  const form = h('form', { class: 'task-form', novalidate: true });
  panel.body.append(form);
  let busy = false;

  function draw() {
    clear(form);
    const teamBoxes = state.ref.teams.filter((t) => t.active !== false).map((t) => {
      const box = h('input', {
        type: 'checkbox', checked: draft.teamIds.includes(t.id), disabled: draft.role === 'director',
        onchange: () => {
          draft.teamIds = box.checked ? [...draft.teamIds, t.id] : draft.teamIds.filter((x) => x !== t.id);
        }
      });
      return h('label', { class: 'check' }, box, ' ', t.name);
    });
    const nameInput = h('input', { type: 'text', value: draft.name, maxlength: 100, oninput: (e) => { draft.name = e.target.value; } });
    const emailInput = h('input', { type: 'email', value: draft.email, disabled: !isNew, oninput: (e) => { draft.email = e.target.value; } });
    const roleSelect = select(ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })), draft.role, {
      disabled: isSelf,
      onchange: (e) => { draft.role = e.target.value; if (draft.role === 'director') draft.teamIds = []; draw(); }
    });
    add(form,
      field('Full name', nameInput),
      field('Email (their login)', emailInput, isNew ? null : 'The email cannot be changed here.'),
      field('Role', roleSelect, isSelf ? 'You cannot change your own role.' : ROLE_HELP[draft.role]),
      field('Teams', h('div', { class: 'check-list' }, teamBoxes.length ? teamBoxes : h('p', { class: 'muted' }, 'No teams yet. Create one under Teams & projects first.')),
        draft.role === 'director' ? 'Directors see every team, so no team is needed.' : null),
      isNew ? field('Temporary password',
        h('div', { class: 'inline' },
          h('input', { type: 'text', value: draft.password, id: 'temp-pass', oninput: (e) => { draft.password = e.target.value; } }),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { draft.password = tempPassword(); draw(); } }, 'New')),
        'At least 8 characters. Share it with them privately.') : null,
      isNew ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: draft.sendReset, onchange: (e) => { draft.sendReset = e.target.checked; } }),
        ' Also email them a link to choose their own password') : null,
      !isNew ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: draft.active, disabled: isSelf, onchange: (e) => { draft.active = e.target.checked; } }),
        ' Account is active', isSelf ? h('span', { class: 'muted' }, ' (you cannot deactivate yourself)') : null) : null,
      h('div', { class: 'form-actions' },
        !isNew ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: async () => {
          try { await getBackend().resetPassword(person.email); toast('Password reset email sent.', 'success'); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Send password reset email') : h('span'),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => panel.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Create account' : 'Save changes')));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true; submit.textContent = 'Saving...';
    try {
      if (isNew) {
        if (draft.role !== 'director' && !draft.teamIds.length) {
          const ok = await confirmDialog('No team is selected, so this person will not see any tasks. Continue anyway?', { confirm: 'Continue' });
          if (!ok) { busy = false; submit.disabled = false; submit.textContent = 'Create account'; return; }
        }
        await createPerson(draft);
        panel.close();
        await dialog({
          title: 'Account created',
          content: h('div', null,
            h('p', null, `${draft.name} can now sign in with:`),
            h('p', { class: 'credentials' }, h('strong', null, 'Email: '), draft.email, h('br'), h('strong', null, 'Temporary password: '), draft.password),
            h('p', { class: 'muted' }, draft.sendReset && !isDemo() ? 'A password reset email was also sent.' : 'Share the password privately.')),
          actions: [{ label: 'Done', kind: 'primary', value: true }]
        });
      } else {
        await updatePerson(person, { name: draft.name.trim(), role: draft.role, teamIds: draft.teamIds, active: draft.active });
        toast('Saved.', 'success');
        panel.close();
      }
      onDone();
    } catch (err) {
      toast(errorMessage(err), 'error');
      busy = false; submit.disabled = false; submit.textContent = isNew ? 'Create account' : 'Save changes';
    }
  });

  draw();
}

export { uid20 };
