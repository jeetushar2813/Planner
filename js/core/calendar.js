// Calendar and availability maths. Pure functions: no screen, no database. That keeps
// them easy to test and means the Calendar, Leave and Team Overview pages agree.
//
// Working week: weekends come from appSettings.weekendDays (default Saturday and Sunday,
// 0 = Sunday). Public holidays belong to one team or to everybody (teamId null).
// Only APPROVED leave reduces availability.

import { appSettings } from '../config.js';
import { dow, eachDay, addDays } from './util.js';

export const weekendDays = () => appSettings.weekendDays ?? [0, 6];
export const weekStartsOn = () => appSettings.weekStartsOn ?? 1;

export const isWeekend = (iso) => weekendDays().includes(dow(iso));

// The holiday that applies to this team on this date, if any.
export function holidayFor(iso, teamId, holidays) {
  return (holidays || []).find((x) => x.active !== false && x.date === iso && (!x.teamId || x.teamId === teamId)) || null;
}

// A working day for this person: not a weekend and not a holiday for any of their teams.
export function isWorkingDay(iso, teamIds, holidays) {
  if (isWeekend(iso)) return false;
  const ids = teamIds && teamIds.length ? teamIds : [null];
  return !ids.some((t) => holidayFor(iso, t, holidays));
}

export const covers = (leave, iso) => leave.startDate <= iso && iso <= leave.endDate;
export const isApproved = (leave) => leave.status === 'approved';

// What is this person doing on this day?
//  state: 'weekend' | 'holiday' | 'leave' | 'half' | 'available'
export function dayStatus(person, iso, leaves, holidays) {
  if (isWeekend(iso)) return { state: 'weekend' };
  const holiday = (person.teamIds || [null]).map((t) => holidayFor(iso, t, holidays)).find(Boolean)
    || holidayFor(iso, null, holidays);
  if (holiday) return { state: 'holiday', holiday };
  const leave = (leaves || []).find((l) => l.userId === person.id && isApproved(l) && covers(l, iso));
  if (leave) return { state: leave.half && leave.half !== 'full' ? 'half' : 'leave', leave };
  return { state: 'available' };
}

// People expected at work on this day, and how many of them are actually in.
export function capacity(people, iso, leaves, holidays) {
  let expected = 0, away = 0, half = 0;
  for (const p of people) {
    const s = dayStatus(p, iso, leaves, holidays);
    if (s.state === 'weekend' || s.state === 'holiday') continue;
    expected += 1;
    if (s.state === 'leave') away += 1;
    else if (s.state === 'half') half += 1;
  }
  return { expected, away, half, available: expected - away - half * 0.5 };
}

// Warnings for one day. `due` = number of tasks due that day.
//  short:  half the team or more is away (and somebody is expected)
//  heavy:  three or more deadlines for each person who is in
//  nobody: deadlines exist but nobody is working
export function dayFlags(cap, due) {
  const flags = [];
  if (cap.expected > 0 && cap.away + cap.half * 0.5 >= cap.expected / 2 && cap.away + cap.half > 0) flags.push('short');
  if (due >= 3 && cap.available > 0 && due / cap.available >= 3) flags.push('heavy');
  if (due > 0 && cap.expected > 0 && cap.available <= 0) flags.push('nobody');
  return flags;
}

export const FLAG_TEXT = {
  short: 'Short-staffed: half the team or more is away',
  heavy: 'Heavy day: three or more deadlines for each person available',
  nobody: 'Deadlines fall on a day when nobody is available'
};

// Working days a leave request takes (holidays and weekends do not count; half day = 0.5).
export function leaveWorkdays(leave, person, holidays) {
  const days = eachDay(leave.startDate, leave.endDate)
    .filter((d) => isWorkingDay(d, person?.teamIds?.length ? person.teamIds : [leave.teamId], holidays));
  if (leave.half && leave.half !== 'full') return days.length ? 0.5 : 0;
  return days.length;
}

// Is this task due on a day its owner is away (approved leave, holiday, weekend)?
export function ownerAwayOnDue(task, owner, leaves, holidays) {
  if (!task.dueDate || !owner) return null;
  const s = dayStatus(owner, task.dueDate, leaves, holidays);
  return s.state === 'leave' || s.state === 'half' ? s : null;
}

// Next approved leave (today or later) for a person.
export function nextLeave(personId, todayStr, leaves) {
  return (leaves || [])
    .filter((l) => l.userId === personId && isApproved(l) && l.endDate >= todayStr)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || null;
}

export { addDays };
