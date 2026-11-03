// App start-up: connects to the backend, handles sign-in and sign-out, builds the
// page shell (sidebar, header) and switches between screens by the address hash.

import { h, clear, $, fmtAgo } from './core/util.js';
import { ROLE_LABEL } from './core/model.js';
import { appSettings } from './config.js';
import * as perm from './core/perm.js';
import {
  state, bus, setBackend, getBackend, startSession, endSession, loadRefData, isDemo, SessionError
} from './core/store.js';
import { loadBackend } from './backend/index.js';
import { renderLogin } from './ui/login.js';
import { renderHome } from './ui/home.js';
import { renderMyTasks, renderTeamTasks } from './ui/tasks.js';
import { renderActivity } from './ui/activity.js';
import { renderPeople } from './ui/people.js';
import { renderTeams } from './ui/teams.js';
import { renderStatuses } from './ui/statuses.js';
import { avatar, toast, errorMessage, spinner } from './ui/components.js';
import { openTaskPanel } from './ui/taskform.js';

const root = $('#app');

// path, label, who may open it, screen
const ROUTES = [
  { path: 'home', label: 'Home', icon: '⌂', allow: () => true, render: renderHome },
  { path: 'my', label: 'My tasks', icon: '☑', allow: () => true, render: renderMyTasks },
  { path: 'team', label: 'Team tasks', icon: '▦', allow: () => true, render: renderTeamTasks },
  { path: 'activity', label: 'Activity', icon: '↻', allow: () => true, render: renderActivity },
  { path: 'people', label: 'People', icon: '☺', group: 'Manage', allow: perm.canManageUsers, render: renderPeople },
  { path: 'teams', label: 'Teams & projects', icon: '◎', group: 'Manage', allow: perm.isLeaderUp, render: renderTeams },
  { path: 'statuses', label: 'Statuses', icon: '●', group: 'Manage', allow: perm.canManageStatuses, render: renderStatuses }
];

let cleanup = null;        // function returned by the current screen
let main = null;           // <main> element of the shell
let navLinks = [];
let freshSignIn = false;
let starting = false;
let pendingMessage = '';

// ---------------------------------------------------------------- start-up

async function boot() {
  clear(root).append(spinner('Starting'));
  try {
    setBackend(await loadBackend());
  } catch (err) {
    clear(root).append(h('main', { class: 'login' }, h('div', { class: 'login-card' },
      h('h1', null, 'Could not start'),
      h('p', { class: 'error-text' }, errorMessage(err)),
      h('p', { class: 'muted' }, 'Check js/config.js and your internet connection.'))));
    return;
  }
  getBackend().onAuth(handleAuth);
  window.addEventListener('hashchange', route);
}

async function handleAuth(authUser) {
  if (!authUser) {
    stopScreen();
    state.user = null;
    showLogin(pendingMessage);
    pendingMessage = '';
    return;
  }
  if (starting || state.user?.id === authUser.uid) return;
  starting = true;
  clear(root).append(spinner('Signing in'));
  try {
    await startSession(authUser, { freshSignIn });
    freshSignIn = false;
    showShell();
  } catch (err) {
    freshSignIn = false;
    pendingMessage = err instanceof SessionError ? err.message : errorMessage(err);
    await endSession().catch(() => {});
    if (isDemo()) showLogin(pendingMessage);
  } finally {
    starting = false;
  }
}

function showLogin(message = '') {
  stopScreen();
  document.body.classList.remove('nav-open');
  renderLogin(root, { message, onSignIn: () => { freshSignIn = true; } });
  document.title = `Sign in · ${appSettings.appName}`;
}

// -------------------------------------------------------------------- shell

function showShell() {
  const user = state.user;
  navLinks = [];
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  let lastGroup = null;
  for (const r of ROUTES.filter((x) => x.allow(user))) {
    if (r.group && r.group !== lastGroup) nav.append(h('div', { class: 'nav-group' }, r.group));
    lastGroup = r.group || lastGroup;
    const link = h('a', { href: '#/' + r.path, class: 'nav-link', dataset: { path: r.path }, onclick: () => document.body.classList.remove('nav-open') },
      h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, r.icon), r.label);
    navLinks.push(link);
    nav.append(link);
  }

  const freshness = h('p', { class: 'freshness muted' });
  const drawFreshness = () => {
    freshness.textContent = state.ref.loadedAt ? `People and teams updated ${fmtAgo(state.ref.loadedAt)}.` : '';
  };
  drawFreshness();
  bus.addEventListener('ref', drawFreshness);

  const demoSwitch = isDemo() ? h('label', { class: 'demo-switch' }, 'Viewing as ',
    (() => {
      const sel = h('select', { 'aria-label': 'Switch demo person', onchange: () => switchDemoUser(sel.value) },
        state.ref.users.map((u) => h('option', { value: u.email, selected: u.id === user.id }, `${u.name} (${ROLE_LABEL[u.role]})`)));
      return sel;
    })()) : null;

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '✓'), appSettings.appName),
    h('button', { type: 'button', class: 'btn btn-primary btn-block new-task', onclick: () => openTaskPanel({ onSaved: () => route() }) }, '+ New task'),
    nav,
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'who' }, avatar(user.name, 34),
        h('div', null, h('strong', null, user.name), h('div', { class: 'muted small' }, ROLE_LABEL[user.role]))),
      freshness,
      h('div', { class: 'foot-actions' },
        h('button', { type: 'button', class: 'link-btn', onclick: async () => {
          try { await loadRefData({ force: true }); toast('People and teams refreshed.', 'success'); route(); } catch (err) { toast(errorMessage(err), 'error'); }
        } }, 'Refresh people & teams'),
        h('button', { type: 'button', class: 'link-btn', onclick: () => endSession() }, 'Sign out'))));

  main = h('main', { id: 'main', class: 'main', tabindex: -1 });
  const topbar = h('header', { class: 'topbar' },
    h('button', { type: 'button', class: 'icon-btn menu-btn', 'aria-label': 'Open menu', onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
    h('div', { class: 'brand brand-top' }, h('span', { class: 'brand-mark' }, '✓'), appSettings.appName),
    h('div', { class: 'spacer' }),
    isDemo() ? h('span', { class: 'demo-pill', title: 'Sample data kept only in this browser' }, 'Demo mode') : null,
    demoSwitch);

  clear(root).append(h('div', { class: 'shell' }, sidebar,
    h('div', { class: 'content' }, topbar, main),
    h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') })));

  if (!location.hash || location.hash === '#') location.hash = '#/home';
  route();
}

async function switchDemoUser(email) {
  stopScreen();
  state.user = null;
  state.tasks.clear();
  freshSignIn = true;
  location.hash = '#/home';
  try {
    await getBackend().signIn(email, 'demo');
  } catch (err) { toast(errorMessage(err), 'error'); }
}

// ------------------------------------------------------------------- routing

function stopScreen() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
}

function route() {
  if (!state.user || !main) return;
  const path = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
  let entry = ROUTES.find((r) => r.path === path);
  if (!entry || !entry.allow(state.user)) {
    if (entry) toast('Your role does not include that page.', 'error');
    location.hash = '#/home';
    return;
  }
  stopScreen();
  document.body.classList.remove('nav-open');
  navLinks.forEach((l) => {
    const on = l.dataset.path === entry.path;
    l.classList.toggle('active', on);
    on ? l.setAttribute('aria-current', 'page') : l.removeAttribute('aria-current');
  });
  clear(main);
  document.title = `${entry.label} · ${appSettings.appName}`;
  try {
    cleanup = entry.render(main) || null;
  } catch (err) {
    console.error(err);
    main.append(h('div', { class: 'empty' }, h('h3', null, 'Something went wrong on this page'),
      h('p', { class: 'muted' }, errorMessage(err))));
  }
  window.scrollTo(0, 0);
}

boot();
