// Recurring tasks. Pure date maths, no screen and no database.
//
// A template has a `repeat` (weekly, monthly ...) and a `nextDate`: the date its next task is
// due to be made. With no server, the app of a Team Leader, Manager or Director makes the task
// when they open it (see store.runRecurring). If several occurrences were missed, only the latest
// one is made, so nobody gets a pile of old tasks after a holiday.

import { addDays, addMonths, endOfMonth } from './util.js';

export const REPEATS = ['none', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];
export const REPEAT_LABEL = {
  none: 'Does not repeat (use it by hand)',
  weekly: 'Every week', fortnightly: 'Every 2 weeks', monthly: 'Every month',
  quarterly: 'Every 3 months', yearly: 'Every year'
};
export const REPEAT_SHORT = {
  none: 'Manual', weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly'
};
const MONTH_STEP = { monthly: 1, quarterly: 3, yearly: 12 };
export const MAX_TEMPLATE_OWNERS = 5; // one batch must stay inside the rules' document-access limit

// The date after `iso` for this repeat. `anchorDay` keeps "the 31st" from drifting to the 28th
// after February: each month uses the anchor day, or its last day if the month is shorter.
export function nextOccurrence(iso, repeat, anchorDay = null) {
  if (repeat === 'weekly') return addDays(iso, 7);
  if (repeat === 'fortnightly') return addDays(iso, 14);
  const step = MONTH_STEP[repeat];
  if (!step) return null;
  const first = addMonths(iso, step);                 // first day of the target month
  const last = Number(endOfMonth(first).slice(8));
  const day = Math.min(anchorDay || Number(iso.slice(8)), last);
  return first.slice(0, 8) + String(day).padStart(2, '0');
}

// Is a task due from this template today? Returns { date, next, skipped } or null.
//   date    the occurrence to make (the latest one that is not in the future)
//   next    the template's new nextDate
//   skipped how many earlier occurrences were passed over
export function dueOccurrence(tpl, today) {
  if (!tpl || tpl.active === false || !tpl.repeat || tpl.repeat === 'none' || !tpl.nextDate || tpl.nextDate > today) return null;
  let date = tpl.nextDate;
  let skipped = 0;
  for (let i = 0; i < 2000; i++) {
    const after = nextOccurrence(date, tpl.repeat, tpl.anchorDay);
    if (!after || after > today) return { date, next: after, skipped };
    date = after; skipped++;
  }
  return null;
}

// One task per person and occurrence, with a fixed id, so two people opening the app at the same
// moment cannot make it twice (the second write is refused because the task already exists).
export const occurrenceTaskId = (templateId, date, ownerId) => `rec-${templateId}-${date}-${ownerId}`;

export const dueDateFor = (tpl, date) => (tpl.dueInDays === null || tpl.dueInDays === undefined || tpl.dueInDays === '' ? null : addDays(date, Number(tpl.dueInDays)));
