// What a new task must have before it can be saved. The Director can change these in
// js/config.js (appSettings.taskRules). They are checked by the app, not by the database:
// the database only checks that what is stored is well formed.
import { appSettings } from '../config.js';
import { PRIORITY_RANK } from './model.js';
import { dayStatus } from './calendar.js';
import { fmtDate, fmtWeekday, todayISO } from './util.js';

export const DEFAULT_TASK_RULES = {
  requireDueDate: true,        // every new task needs a due date
  requireEstimate: false,      // every new task needs an estimate in hours
  requireEstimateFrom: '',     // ...or only tasks at this priority or above, e.g. 'high' ('' = never)
  requireProject: false,       // every new task must belong to a project
  requireDescription: false    // every new task needs a description
};

export const taskRules = () => ({ ...DEFAULT_TASK_RULES, ...(appSettings.taskRules || {}) });

const blank = (v) => v === '' || v === null || v === undefined || (typeof v === 'string' && !v.trim());

// Messages for everything a NEW task is missing (empty list = fine).
export function missingForNew(draft, rules = taskRules()) {
  const out = [];
  if (rules.requireDueDate && blank(draft.dueDate)) out.push('Please set a due date.');
  const needsEstimate = rules.requireEstimate
    || (rules.requireEstimateFrom && PRIORITY_RANK[draft.priority] >= PRIORITY_RANK[rules.requireEstimateFrom]);
  if (needsEstimate && blank(draft.estimateHours)) {
    out.push(rules.requireEstimate ? 'Please give an estimate in hours.'
      : `Please give an estimate in hours for ${draft.priority} priority tasks.`);
  }
  if (rules.requireProject && blank(draft.projectId)) out.push('Please choose a project.');
  if (rules.requireDescription && blank(draft.description)) out.push('Please add a description.');
  return out;
}

// Small "required" hints shown next to the fields.
export function requiredHints(draft, rules = taskRules()) {
  const est = rules.requireEstimate
    || (rules.requireEstimateFrom && PRIORITY_RANK[draft.priority] >= PRIORITY_RANK[rules.requireEstimateFrom]);
  return { dueDate: !!rules.requireDueDate, estimate: !!est, project: !!rules.requireProject, description: !!rules.requireDescription };
}

// Warnings for the due date, for the people who would get the task: weekend, public holiday, or
// approved leave. `people` are staff records; `data` is { leaves, holidays }. The text never says
// what kind of leave it is (sick leave is private).
export function availabilityWarnings(people, dueDate, data) {
  if (!dueDate || dueDate < todayISO()) return [];
  const out = [];
  const seen = new Set();
  const push = (text) => { if (!seen.has(text)) { seen.add(text); out.push(text); } };
  for (const p of people) {
    const s = dayStatus({ id: p.id, teamIds: p.teamIds }, dueDate, data.leaves, data.holidays);
    if (s.state === 'weekend') push(`${fmtDate(dueDate)} is a ${fmtWeekday(dueDate, true)}, a weekend.`);
    else if (s.state === 'holiday') push(`${fmtDate(dueDate)} is a public holiday (${s.holiday.name}).`);
    else if (s.state === 'leave') push(`${p.name} is on leave on ${fmtDate(dueDate)}.`);
    else if (s.state === 'half') push(`${p.name} is on half-day leave on ${fmtDate(dueDate)}.`);
  }
  return out;
}
