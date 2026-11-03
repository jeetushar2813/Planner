// Sign-in screen.

import { h, clear } from '../core/util.js';
import { appSettings } from '../config.js';
import { getBackend, isDemo } from '../core/store.js';
import { toast } from './components.js';

const DEMO_ACCOUNTS = [
  ['dana@demo.test', 'Dana Tan', 'Director'],
  ['marcus@demo.test', 'Marcus Lim', 'Manager'],
  ['lena@demo.test', 'Lena Wong', 'Team Leader'],
  ['arun@demo.test', 'Arun Raj', 'Assistant Team Leader'],
  ['mei@demo.test', 'Mei Ling', 'Team Member']
];

function friendlyAuthError(err) {
  switch (err && err.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'That email and password do not match. Please check and try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few minutes, or use "Forgot password".';
    case 'auth/network-request-failed':
      return 'No internet connection. Please try again.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact the Director.';
    default:
      return (err && err.message) || 'Could not sign in.';
  }
}

export function renderLogin(root, { message = '', onSignIn }) {
  clear(root);
  const demo = isDemo();
  const email = h('input', { type: 'email', id: 'login-email', autocomplete: 'username', required: true, placeholder: 'you@company.com' });
  const password = h('input', { type: 'password', id: 'login-password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error-text', role: 'alert' }, message);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');

  async function signIn(e, pw) {
    e && e.preventDefault();
    error.textContent = '';
    submit.disabled = true; submit.textContent = 'Signing in...';
    try {
      onSignIn();
      await getBackend().signIn(email.value.trim(), pw ?? password.value);
    } catch (err) {
      error.textContent = friendlyAuthError(err);
      submit.disabled = false; submit.textContent = 'Sign in';
    }
  }

  const forgot = h('button', { type: 'button', class: 'link-btn', onclick: async () => {
    if (!email.value.trim()) { error.textContent = 'Type your email above first, then click "Forgot password".'; email.focus(); return; }
    try {
      await getBackend().resetPassword(email.value.trim());
      error.textContent = '';
      toast('If that email has an account, a reset link is on its way.', 'success');
    } catch (err) { error.textContent = friendlyAuthError(err); }
  } }, 'Forgot password?');

  root.append(h('main', { class: 'login' },
    h('div', { class: 'login-card' },
      h('div', { class: 'brand brand-large' }, h('span', { class: 'brand-mark' }, '✓'), appSettings.appName),
      h('p', { class: 'muted' }, appSettings.organisation),
      demo ? h('div', { class: 'notice' }, h('strong', null, 'Demo mode. '),
        'Firebase is not connected yet, so this uses sample data stored only in your browser. Nothing is shared or sent anywhere.') : null,
      h('form', { onsubmit: signIn },
        h('div', { class: 'field' }, h('label', { for: 'login-email' }, 'Email'), email),
        h('div', { class: 'field' }, h('label', { for: 'login-password' }, 'Password'), password),
        error, submit,
        h('p', { class: 'center' }, forgot)),
      demo ? h('div', { class: 'demo-accounts' },
        h('p', { class: 'muted' }, 'Try it as:'),
        DEMO_ACCOUNTS.map(([mail, name, role]) => h('button', {
          type: 'button', class: 'demo-account',
          onclick: () => { email.value = mail; password.value = 'demo'; signIn(null, 'demo'); }
        }, h('strong', null, name), h('span', { class: 'muted' }, role)))) : null)));
  email.focus();
}
