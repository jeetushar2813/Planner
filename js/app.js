// App start-up: connects to the backend, handles sign-in and sign-out, builds the
// page shell (sidebar, header) and switches between screens by the address hash.

import { h, clear, $, fmtAgo } from './core/util.js';
import { roleLabel } from './core/model.js';
import { appSettings } from './config.js';
import * as perm from './core/perm.js';
import {
  state, bus, setBackend, getBackend, startSession, endSession, loadRefData, isDemo, SessionError, hrQueue, refreshHrQueue,
  watchMyTasks, runRecurring
} from './core/store.js';
import { computeAlerts, getSeen, markSeen } from './core/alerts.js';
import { fmtDate } from './core/util.js';
import { renderTemplates } from './ui/templates.js';
import { loadBackend } from './backend/index.js';
import { renderLogin } from './ui/login.js';
import { renderHome } from './ui/home.js';
import { renderMyTasks, renderTeamTasks } from './ui/tasks.js';
import { renderActivity } from './ui/activity.js';
import { renderCalendar } from './ui/calendar.js';
import { renderLeave } from './ui/leave.js';
import { renderOverview } from './ui/overview.js';
import { renderReports } from './ui/reports.js';
import { renderProjects } from './ui/projects.js';
import { renderProfile } from './ui/profile.js';
import { applyTheme, savedTheme } from './core/theme.js';
import { renderPeople } from './ui/people.js';
import { renderHr } from './ui/hr.js';
import { renderTeams } from './ui/teams.js';
import { renderStatuses } from './ui/statuses.js';
import { avatar, toast, errorMessage, spinner } from './ui/components.js';
import { userName } from './core/store.js';
import { openTaskPanel } from './ui/taskform.js';

applyTheme(savedTheme(), { remember: false });   // the colour theme chosen on this device
const root = $('#app');

// path, label, who may open it, screen
const ROUTES = [
  { path: 'home', label: 'Home', icon: '⌂', allow: () => true, render: renderHome },
  { path: 'my', label: 'My tasks', icon: '☑', allow: () => true, render: renderMyTasks },
  { path: 'team', label: 'Team tasks', icon: '▦', allow: () => true, render: renderTeamTasks },
  { path: 'templates', label: 'Templates', icon: '⟳', allow: perm.isLeaderUp, render: renderTemplates },
  { path: 'calendar', label: 'Calendar', icon: '▤', allow: () => true, render: renderCalendar },
  { path: 'leave', label: 'Leave', icon: '☂', allow: () => true, render: renderLeave },
  { path: 'hr', label: 'HR leave', icon: '✚', allow: perm.canSeeHr, render: renderHr },
  { path: 'projects', label: 'My projects', icon: '◇', allow: perm.canSeeProjects, render: renderProjects },
  { path: 'overview', label: 'Team overview', icon: '▥', allow: perm.canSeeOverview, render: renderOverview },
  { path: 'reports', label: 'Reports', icon: '▨', allow: perm.canSeeReports, render: renderReports },
  { path: 'activity', label: 'Activity', icon: '↻', allow: () => true, render: renderActivity },
  { path: 'profile', label: 'My profile', icon: '◉', allow: () => true, render: renderProfile },
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
    if (stopAlerts) stopAlerts();
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

let shellRefListener = null;
let hrBadgeListener = null;
let stopAlerts = null;      // stops the live listener behind the alerts bell

// The alerts bell: tasks given to you, overdue, due soon. Worked out from your own open tasks,
// which are kept up to date live, so it costs no extra reads.
function buildBell() {
  const user = state.user;
  const count = h('span', { class: 'bell-count', hidden: true });
  const btn = h('button', { type: 'button', class: 'btn btn-ghost bell', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'New tasks, overdue and due soon' }, 'Alerts', count);
  let pop = null;
  let alerts = computeAlerts([], user, { seenAt: getSeen(user.id) });
  const refresh = () => {
    alerts = computeAlerts(state.tasks.values(), user, { seenAt: getSeen(user.id) });
    count.textContent = alerts.count;
    count.hidden = !alerts.count;
    if (pop) drawPop();
  };
  const close = () => { if (pop) { pop.remove(); pop = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey); } };
  const outside = (e) => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const item = (t, sub) => h('button', { type: 'button', class: 'alert-item', onclick: () => { close(); openTaskPanel({ task: t, onSaved: () => route() }); } },
    h('strong', null, t.title), h('span', { class: 'sub' }, sub));
  function drawPop() {
    clear(pop);
    const a = alerts;
    if (!a.count) pop.append(h('p', { class: 'muted' }, 'Nothing needs your attention right now.'));
    if (a.assigned.length) pop.append(h('h3', null, 'New for you'), ...a.assigned.map((t) => item(t, `From ${userName(t.assignedBy || t.createdBy)}${t.dueDate ? `, due ${fmtDate(t.dueDate)}` : ''}`)));
    if (a.overdue.length) pop.append(h('h3', null, 'Overdue'), ...a.overdue.map((t) => item(t, `Was due ${fmtDate(t.dueDate)}`)));
    if (a.dueSoon.length) pop.append(h('h3', null, 'Due soon'), ...a.dueSoon.map((t) => item(t, `Due ${fmtDate(t.dueDate)}`)));
    pop.append(h('div', { class: 'alert-foot' },
      h('a', { href: '#/my', onclick: close }, 'Open My tasks'),
      a.assigned.length ? h('button', { type: 'button', class: 'link-btn', onclick: () => { markSeen(user.id); refresh(); } }, 'Mark new as seen') : null));
  }
  btn.addEventListener('click', () => {
    if (pop) { close(); return; }
    pop = h('div', { class: 'alert-pop', role: 'dialog', 'aria-label': 'Alerts' });
    document.body.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey);
    drawPop();
  });
  const onTasks = () => refresh();
  bus.addEventListener('tasks', onTasks);
  let unwatch = null;
  try { unwatch = watchMyTasks(refresh, () => {}); } catch { /* alerts just stay empty */ }
  if (stopAlerts) stopAlerts();
  stopAlerts = () => { bus.removeEventListener('tasks', onTasks); if (unwatch) unwatch(); close(); stopAlerts = null; };
  refresh();
  return btn;
}
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
    if (r.path === 'hr') {
      // Approved leave HR has not acknowledged yet.
      const badge = h('span', { class: 'nav-badge', hidden: true, 'aria-label': 'waiting to acknowledge' });
      link.append(badge);
      const show = () => { badge.textContent = hrQueue.count; badge.hidden = !hrQueue.count; };
      if (hrBadgeListener) bus.removeEventListener('hr', hrBadgeListener);
      hrBadgeListener = show;
      bus.addEventListener('hr', show);
      show();
      refreshHrQueue({ force: true }).catch(() => {});
    }
  }

  const freshness = h('p', { class: 'freshness muted' });
  const drawFreshness = () => {
    freshness.textContent = state.ref.loadedAt ? `People and teams updated ${fmtAgo(state.ref.loadedAt)}.` : '';
  };
  drawFreshness();
  // If this person's own role, Superuser switch or owned projects change (for example a
  // Director edits themselves), rebuild the menu so it shows what they can now do.
  const sig = (u) => [u?.role, u?.superuser === true, u?.hr === true, (u?.ownedProjectIds || []).join(',')].join('|');
  const built = sig(user);
  const onRef = () => {
    drawFreshness();
    if (state.user && sig(state.user) !== built) { bus.removeEventListener('ref', onRef); showShell(); }
  };
  bus.addEventListener('ref', onRef);
  if (shellRefListener) bus.removeEventListener('ref', shellRefListener);
  shellRefListener = onRef;

  const demoSwitch = isDemo() ? h('label', { class: 'demo-switch' }, 'Viewing as ',
    (() => {
      const sel = h('select', { 'aria-label': 'Switch demo person', onchange: () => switchDemoUser(sel.value) },
        state.ref.users.map((u) => h('option', { value: u.email, selected: u.id === user.id }, `${u.name} (${roleLabel(u)})`)));
      return sel;
    })()) : null;

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '✓'), appSettings.appName),
    h('button', { type: 'button', class: 'btn btn-primary btn-block new-task', onclick: () => openTaskPanel({ onSaved: () => route() }) }, '+ New task'),
    nav,
    h('div', { class: 'sidebar-foot' },
      h('a', { class: 'who', href: '#/profile', title: 'My profile', onclick: () => document.body.classList.remove('nav-open') }, avatar(user.name, 34),
        h('div', null, h('strong', null, user.name), h('div', { class: 'muted small' }, roleLabel(user)))),
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
    buildBell(),
    demoSwitch);

  clear(root).append(h('div', { class: 'shell' }, sidebar,
    h('div', { class: 'content' }, topbar, main),
    h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') })));

  if (!location.hash || location.hash === '#') location.hash = '#/home';
  route();
  // Recurring tasks that are due are made now (Team Leader, Manager, Director).
  if (perm.isLeaderUp(user)) {
    runRecurring().then((n) => { if (n) toast(`${n} recurring task${n === 1 ? '' : 's'} made.`, 'success'); }).catch(() => {});
  }
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
