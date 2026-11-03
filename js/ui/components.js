// Shared interface pieces: toasts, side panel, dialogs, chips, avatars.

import { h, clear, initials } from '../core/util.js';
import { CATEGORY_LABEL, PRIORITY_LABEL } from '../core/model.js';

// ------------------------------------------------------------------- toasts

let toastHost;
export function toast(message, kind = 'info') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(node);
  setTimeout(() => node.classList.add('toast-out'), kind === 'error' ? 6000 : 3200);
  setTimeout(() => node.remove(), kind === 'error' ? 6400 : 3600);
}

export function errorMessage(err) {
  const code = err && err.code ? String(err.code) : '';
  if (code === 'permission-denied') return 'Your role does not allow that action.';
  if (code === 'unavailable') return 'No connection to Firebase right now. Please try again.';
  if (code === 'resource-exhausted') return 'The free daily Firebase limit has been reached. It resets daily. Please try again tomorrow.';
  if (code === 'failed-precondition' && /index/i.test(err.message || '')) {
    return 'Firestore needs an index for this view. Open SETUP.md, section "Indexes", and deploy firestore.indexes.json.';
  }
  return (err && err.message) || 'Something went wrong.';
}

// -------------------------------------------------------------- side panel

// Opens a panel on the right. Returns { body, close }.
export function openPanel({ title, subtitle, wide = false, onClose }) {
  const previouslyFocused = document.activeElement;
  const body = h('div', { class: 'panel-body' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close panel' }, '×');
  const panel = h('aside', { class: 'panel' + (wide ? ' panel-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'panel-head' },
      h('div', null, h('h2', null, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
      closeBtn),
    body);
  const overlay = h('div', { class: 'overlay' }, panel);
  document.body.append(overlay);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => overlay.classList.add('open'));

  let closed = false;
  async function requestClose() {
    if (closed) return;
    if (onClose) {
      const allowed = await onClose();
      if (allowed === false) return;
    }
    close();
  }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('open');
    document.body.classList.remove('no-scroll');
    setTimeout(() => overlay.remove(), 180);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  }
  function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.dialog-overlay')) requestClose(); }
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', requestClose);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) requestClose(); });
  return { body, close, requestClose };
}

// ----------------------------------------------------------------- dialogs

// Generic dialog. actions: [{ label, kind: 'primary'|'danger'|'ghost', value }]. Resolves to the clicked value.
export function dialog({ title, message, content, actions }) {
  return new Promise((resolve) => {
    const finish = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
    const buttons = actions.map((a) =>
      h('button', {
        class: 'btn ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'),
        type: 'button',
        onclick: () => finish(a.value)
      }, a.label));
    const box = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', null, title),
      message ? h('p', null, message) : null,
      content || null,
      h('div', { class: 'dialog-actions' }, buttons));
    const overlay = h('div', { class: 'dialog-overlay' }, box);
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    const first = box.querySelector('input, textarea, select') || buttons[buttons.length - 1];
    first && first.focus();
  });
}

export async function confirmDialog(message, { title = 'Please confirm', confirm = 'Yes', cancel = 'Cancel', danger = false } = {}) {
  const result = await dialog({
    title, message,
    actions: [{ label: cancel, kind: 'ghost', value: false }, { label: confirm, kind: danger ? 'danger' : 'primary', value: true }]
  });
  return result === true;
}

// Asks for a short piece of text (for example, why a task is blocked).
export async function promptDialog({ title, message, label, placeholder = '', confirm = 'Save', initial = '' }) {
  const input = h('textarea', { rows: 3, placeholder, maxlength: 500, 'aria-label': label || title }, initial);
  const result = await dialog({
    title, message,
    content: h('div', { class: 'field' }, label ? h('label', null, label) : null, input),
    actions: [{ label: 'Cancel', kind: 'ghost', value: 'cancel' }, { label: confirm, kind: 'primary', value: 'ok' }]
  });
  return result === 'ok' ? input.value.trim() : null;
}

// ------------------------------------------------------------------- chips

export function statusChip(status) {
  if (!status) return h('span', { class: 'chip' }, 'No status');
  return h('span', {
    class: 'chip chip-status', style: { '--chip': status.color || '#64748b' },
    title: CATEGORY_LABEL[status.category] || ''
  }, h('span', { class: 'dot' }), status.name);
}

export function priorityChip(priority) {
  return h('span', { class: `chip chip-priority p-${priority}` }, PRIORITY_LABEL[priority] || priority);
}

export function avatar(name, size = 28) {
  return h('span', { class: 'avatar', style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' }, title: name }, initials(name));
}

export function personTag(name) {
  return h('span', { class: 'person' }, avatar(name, 22), h('span', null, name));
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null, action || null);
}

export function spinner(label = 'Loading') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), label + '...');
}

// Form helpers ---------------------------------------------------------------

export function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('label', null, label),
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
}

export function select(options, value, attrs = {}) {
  const el = h('select', attrs, options.map((o) =>
    h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  el.value = value ?? '';
  return el;
}

export function setChildren(node, ...children) {
  clear(node);
  for (const c of children.flat(Infinity)) if (c) node.append(c);
  return node;
}
