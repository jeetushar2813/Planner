// Builds the activity log entry for a change. Every save in the app writes the
// change and its log entry together in one batch (see store.js).

import { ACTION_LABEL, PRIORITY_LABEL } from './model.js';
import { fmtDate } from './util.js';

// Field names shown in the log, in plain words.
const FIELD_LABEL = {
  title: 'Title', description: 'Description', teamId: 'Team', projectId: 'Project',
  ownerId: 'Owner', status: 'Status', statusNote: 'Status note', priority: 'Priority',
  startDate: 'Start date', dueDate: 'Due date', estimateHours: 'Estimate (hours)',
  checklist: 'Checklist', archived: 'Archived', name: 'Name', role: 'Role',
  teamIds: 'Teams', active: 'Active', superuser: 'Superuser access', hr: 'HR access', overrides: 'Exceptions', hrAck: 'HR',
  annual: 'Annual leave days', sick: 'Medical leave days', hospitalization: 'Hospitalization leave days', compassionate: 'Compassionate leave days', marriage: 'Marriage leave days', checklistAssignees: 'Step helpers', approvalGate: 'Approval gate',
  category: 'Category', color: 'Colour', order: 'Order', needsReason: 'Needs reason',
  email: 'Email', text: 'Comment', mentions: 'Mentioned',
  type: 'Type', endDate: 'To', half: 'Day part', reason: 'Reason', decisionNote: 'Decision note',
  date: 'Date', userId: 'Person',
  tags: 'Tags', blockedBy: 'Blocked by', recurring: 'Recurring', repeat: 'Repeats', nextDate: 'Next date',
  ownerIds: 'People', dueInDays: 'Due after (days)'
};

export const fieldLabel = (f) => FIELD_LABEL[f] || f;

// Compare old and new values for the listed fields and return [{field, from, to}].
// `resolve(field, value)` turns ids into names (owner, team, status...).
export function diffFields(before, after, fields, resolve = (f, v) => v) {
  const changes = [];
  for (const field of fields) {
    const a = before ? before[field] : undefined;
    const b = after[field];
    if (sameValue(a, b)) continue;
    changes.push({ field, from: shorten(resolve(field, a)), to: shorten(resolve(field, b)) });
  }
  return changes;
}

function sameValue(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  return JSON.stringify(na) === JSON.stringify(nb);
}

// Keeps log entries small. Long text is cut; lists become a short description.
function shorten(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === 'object') {
      const done = value.filter((i) => i.done).length;
      return `${value.length} item${value.length === 1 ? '' : 's'} (${done} done)`;
    }
    return value.join(', ');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

// One readable line for the log table and for reports.
export function summarize(action, entityTitle, changes) {
  const base = ACTION_LABEL[action] || action;
  const what = entityTitle ? ` "${entityTitle}"` : '';
  if (!changes || !changes.length) return `${base}${what}`;
  const parts = changes.slice(0, 4).map((c) =>
    c.from === '' || c.from === undefined
      ? `${fieldLabel(c.field)} set to ${c.to || 'empty'}`
      : `${fieldLabel(c.field)}: ${c.from} to ${c.to || 'empty'}`);
  const more = changes.length > 4 ? ` (+${changes.length - 4} more)` : '';
  return `${base}${what}: ${parts.join('; ')}${more}`.slice(0, 590);
}

// Pick the most specific action for a task edit.
export function taskAction(changes) {
  const fields = changes.map((c) => c.field);
  if (fields.includes('archived')) {
    const c = changes.find((x) => x.field === 'archived');
    return c.to === 'yes' ? 'task.archive' : 'task.restore';
  }
  if (fields.includes('ownerId')) return 'task.assign';
  if (fields.length === 1 && fields[0] === 'status') return 'task.status';
  if (fields.includes('status') && fields.every((f) => ['status', 'statusNote'].includes(f))) {
    return 'task.status';
  }
  return 'task.update';
}

export const formatters = { PRIORITY_LABEL, fmtDate };
