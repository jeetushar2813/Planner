// Key dates: days worth marking on the calendar that are not tasks and not days off, such as
// "Semester 1 starts", "Exam week" or "Open day". Pure functions (no screen, no database).
//
// A key date has a first and last day (the same day for a one-day date), belongs to one team or
// to everyone (teamId null), and may repeat every year. A yearly date is shown again each year on
// the same month and day; if the day moves, edit the date. 29 February falls on 28 February in a
// year that has no 29 February.

import { addDays, daysBetween } from './util.js';

export const KEY_CATEGORIES = ['term', 'exam', 'event', 'deadline', 'other'];
export const KEY_CATEGORY_LABEL = {
  term: 'Semester or term', exam: 'Exams', event: 'Event', deadline: 'Deadline', other: 'Other'
};
export const MAX_SPAN_DAYS = 60;                        // one key date may cover at most this many days

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Moves an ISO date by whole years, keeping month and day (29 Feb becomes 28 Feb when needed).
export function shiftYears(iso, years) {
  if (!years) return iso;
  const y = Number(iso.slice(0, 4)) + years;
  const m = iso.slice(5, 7);
  let d = iso.slice(8, 10);
  if (m === '02' && d === '29') {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!leap) d = '28';
  }
  return `${String(y).padStart(4, '0')}-${m}-${d}`;
}

export function validateKeyDate(d) {
  if (!(d.title || '').trim()) return 'Please give the key date a title.';
  if (d.title.trim().length > 100) return 'The title is too long (100 characters at most).';
  if (!DATE_RE.test(d.startDate || '')) return 'Please choose the first day.';
  const end = d.endDate || d.startDate;
  if (!DATE_RE.test(end)) return 'Please choose a valid last day, or leave it empty for a one-day date.';
  if (end < d.startDate) return 'The last day cannot be before the first day.';
  if (daysBetween(d.startDate, end) + 1 > MAX_SPAN_DAYS) return `A key date can cover at most ${MAX_SPAN_DAYS} days. Add a second one for a longer period.`;
  if (!KEY_CATEGORIES.includes(d.category || 'other')) return 'Please choose the type.';
  if ((d.note || '').length > 500) return 'The note is too long (500 characters at most).';
  return null;
}

// Every showing of the key dates that touches [from, to]. A yearly date is repeated for each year
// that reaches into the range (a date that runs over New Year is handled too). One entry per showing:
//   { key, kd, startDate, endDate, years }   key is unique per showing, for "seen" tracking.
export function occurrencesIn(keyDates, from, to) {
  const out = [];
  for (const kd of keyDates) {
    if (kd.active === false || !kd.startDate) continue;
    const end = kd.endDate || kd.startDate;
    const firstYear = Number(kd.startDate.slice(0, 4));
    const spanYears = Number(end.slice(0, 4)) - firstYear;
    const lo = Number(from.slice(0, 4)) - spanYears - 1;
    const hi = Number(to.slice(0, 4)) + 1;
    const range = kd.yearly === true ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i - firstYear).filter((n) => n >= 0) : [0];
    for (const n of range) {
      const startDate = shiftYears(kd.startDate, n);
      const endDate = shiftYears(end, n);
      if (endDate < from || startDate > to) continue;
      out.push({ key: `${kd.id}:${startDate}`, kd, startDate, endDate, years: n });
    }
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.kd.title.localeCompare(b.kd.title));
}

export const coversDay = (occ, iso) => occ.startDate <= iso && iso <= occ.endDate;

// Where this day sits in a multi-day key date: { day: 2, of: 5 }, or null for a one-day date.
export function dayOf(occ, iso) {
  const of = daysBetween(occ.startDate, occ.endDate) + 1;
  return of > 1 ? { day: daysBetween(occ.startDate, iso) + 1, of } : null;
}

// Key dates that have started or will start in the next `days` days, including ones already under way,
// soonest first. `daysAway` is 0 for something that starts today or is under way.
export function comingUp(keyDates, today, days) {
  return occurrencesIn(keyDates, today, addDays(today, days))
    .filter((o) => o.endDate >= today)
    .map((o) => ({ ...o, daysAway: Math.max(0, daysBetween(today, o.startDate)), underway: o.startDate < today }));
}

// Key dates starting today or in the next `lead` days. They appear in the Alerts bell once each,
// until the person clears them. `dismissed` is the set of keys already cleared.
export function keyDateAlerts(keyDates, today, lead = 3, dismissed = new Set()) {
  return occurrencesIn(keyDates, today, addDays(today, lead))
    .filter((o) => o.startDate >= today && o.startDate <= addDays(today, lead) && !dismissed.has(o.key))
    .map((o) => ({ ...o, daysAway: daysBetween(today, o.startDate) }));
}

// "today", "tomorrow", "in 5 days", or "under way" for something that started already.
export function whenText(item) {
  if (item.underway) return 'under way';
  if (item.daysAway === 0) return 'today';
  if (item.daysAway === 1) return 'tomorrow';
  return `in ${item.daysAway} days`;
}
