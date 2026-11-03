// My profile: who I am (read only), my colour theme, and changing my own password.
// Changing the name, role or teams is for the Director (People page).

import { h, clear, fmtDateTime } from '../core/util.js';
import { roleLabel } from '../core/model.js';
import { THEMES, currentTheme } from '../core/theme.js';
import {
  state, teamName, setMyTheme, changeMyPassword, validateNewPassword, PASSWORD_MIN, isDemo
} from '../core/store.js';
import { toast, errorMessage, field, avatar } from './components.js';

export function renderProfile(container) {
  const user = state.user;
  const teams = (user.teamIds || []).map((id) => teamName(id));

  container.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'My profile'),
      h('p', { class: 'muted' }, 'Your details, your colour theme and your password.')),
    h('div', { class: 'profile-grid' }, aboutCard(), passwordCard(), themeCard()));

  // ------------------------------------------------------------------- about me
  function aboutCard() {
    return h('section', { class: 'card-block' },
      h('div', { class: 'row-head' }, h('h2', null, 'About you'), avatar(user.name, 40)),
      h('dl', { class: 'facts' },
        h('dt', null, 'Name'), h('dd', null, user.name),
        h('dt', null, 'Email'), h('dd', null, user.email),
        h('dt', null, 'Role'), h('dd', null, roleLabel(user)),
        h('dt', null, 'Team'), h('dd', null, teams.length ? teams.join(', ') : 'No team'),
        h('dt', null, 'Last sign-in'), h('dd', null, user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : 'This is your first visit')),
      h('p', { class: 'hint' }, 'To change your name, role or team, ask the Director.'));
  }

  // ------------------------------------------------------------------- password
  function passwordCard() {
    const current = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password', id: 'pw-current' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password', id: 'pw-new' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Type the new password again', id: 'pw-again' });
    const error = h('p', { class: 'error-text', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password');
    const show = h('input', { type: 'checkbox', onchange: () => { for (const i of [current, next, again]) i.type = show.checked ? 'text' : 'password'; } });

    const rules = [
      [`At least ${PASSWORD_MIN} characters`, (v) => v.length >= PASSWORD_MIN],
      ['Letters and at least one number', (v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v)],
      ['Different from your current password', (v) => v.length > 0 && v !== current.value],
      ['Both new passwords match', (v) => v.length > 0 && v === again.value]
    ].map(([text, test]) => ({ item: h('li', null, text), test }));
    const list = h('ul', { class: 'pw-rules' }, rules.map((r) => r.item));
    const tick = () => { for (const r of rules) r.item.classList.toggle('ok', r.test(next.value)); };
    for (const i of [current, next, again]) i.addEventListener('input', () => { tick(); error.textContent = ''; });

    const form = h('form', { class: 'pw-form', novalidate: true },
      field('Current password', current),
      field('New password', next),
      field('Type the new password again', again),
      list,
      h('label', { class: 'check' }, show, ' Show passwords'),
      error,
      h('div', null, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = validateNewPassword(current.value, next.value, again.value);
      if (problem) { error.textContent = problem; return; }
      submit.disabled = true; submit.textContent = 'Changing...';
      try {
        await changeMyPassword(current.value, next.value, again.value);
        for (const i of [current, next, again]) i.value = '';
        tick();
        toast('Your password was changed. Use the new one next time you sign in.', 'success');
      } catch (err) {
        error.textContent = errorMessage(err);
        if (/current password/i.test(error.textContent)) current.focus();
      }
      submit.disabled = false; submit.textContent = 'Change password';
    });
    return h('section', { class: 'card-block' },
      h('h2', null, 'Change password'),
      h('p', { class: 'muted small', style: { margin: '4px 0 12px' } }, isDemo()
        ? 'Demo mode: the password changes only inside this demo.'
        : 'You do not need the Director for this. Forgotten your password? Sign out and use "Forgot password" on the sign-in page.'),
      form);
  }

  // ---------------------------------------------------------------------- theme
  function themeCard() {
    const wrap = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Colour theme' });
    const saved = h('p', { class: 'hint', role: 'status' });
    const pick = async (id) => {
      saved.textContent = 'Saving...';
      try {
        await setMyTheme(id);
        saved.textContent = 'Saved. This theme will follow you on any device.';
      } catch (err) {
        saved.textContent = 'Applied here, but it could not be saved to your account: ' + errorMessage(err);
      }
    };
    const sample = (id) => h('div', { class: 'sample', dataset: { preview: id } },
      h('div', { class: 's-side' }, h('i'), h('i'), h('i')),
      h('div', { class: 's-main' },
        h('div', { class: 's-card' }, h('i'), h('i')),
        h('div', { class: 's-dots' }, h('b'), h('b'), h('b')),
        h('span', { class: 's-btn' })));
    // "Match my device" shows a light half and a dark half.
    const splitSample = () => h('div', { class: 'sample split' },
      h('div', { dataset: { preview: 'light' } }, h('div', { class: 's-card' }, h('i'), h('i')), h('span', { class: 's-btn' })),
      h('div', { dataset: { preview: 'dark' } }, h('div', { class: 's-card' }, h('i'), h('i')), h('span', { class: 's-btn' })));

    const active = currentTheme();
    for (const t of THEMES) {
      const input = h('input', {
        type: 'radio', name: 'theme', value: t.id, checked: t.id === active, 'aria-label': `${t.label}. ${t.hint}`,
        onchange: () => { if (input.checked) pick(t.id); }
      });
      wrap.append(h('label', { class: 'theme-option' }, input,
        h('span', { class: 'theme-card' },
          t.id === 'auto' ? splitSample() : sample(t.id),
          h('span', { class: 'name' }, t.label, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓')),
          h('span', { class: 'hint-line' }, t.hint))));
    }
    return h('section', { class: 'card-block wide' },
      h('h2', null, 'Colour theme'),
      h('p', { class: 'muted small', style: { margin: '4px 0 12px' } }, 'Pick the look you like. It changes straight away and is saved to your account.'),
      wrap, saved);
  }
}
