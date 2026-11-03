// Yearly leave entitlements and balances. Pure functions, no Firebase.
//
// A policy document (one per year) looks like
//   { year: '2026', days: { annual: 14, sick: 14, ... }, overrides: { <userId>: { annual: 18 } } }
// `days` is what everyone gets; `overrides` lists exceptions for named people (only the kinds
// that differ). A kind with no number set is simply not limited or tracked for that year.
//
// A request for a person in two teams is stored once per team (so each team's leader sees it).
// For balances those copies are one leave, so they are grouped before anything is counted.

import { ENTITLED_TYPES } from './model.js';
import { leaveWorkdays } from './calendar.js';

export const yearOf = (iso) => Number(String(iso).slice(0, 4));

// Days a person gets for a kind of leave in the policy's year, or null when nothing is set.
export function entitlementFor(policy, userId, type) {
  if (!policy || !ENTITLED_TYPES.includes(type)) return null;
  const own = policy.overrides && policy.overrides[userId];
  if (own && typeof own[type] === 'number') return own[type];
  const base = policy.days && policy.days[type];
  return typeof base === 'number' ? base : null;
}

// Group the copies of one request. status: 'approved' (every copy approved), 'pending'
// (something still waits), or 'ignore' (declined or cancelled).
export function groupLeaves(leaves) {
  const groups = new Map();
  for (const l of leaves || []) {
    const key = [l.userId, l.type, l.startDate, l.endDate, l.half || 'full'].join('|');
    if (!groups.has(key)) {
      groups.set(key, { key, userId: l.userId, userName: l.userName, type: l.type, startDate: l.startDate, endDate: l.endDate, half: l.half || 'full', docs: [] });
    }
    groups.get(key).docs.push(l);
  }
  for (const g of groups.values()) {
    const live = g.docs.filter((d) => !['declined', 'cancelled'].includes(d.status));
    g.status = !live.length ? 'ignore' : live.every((d) => d.status === 'approved') ? 'approved' : 'pending';
    g.waitingForHr = g.status === 'approved' && live.some((d) => !d.hrAckBy);
    g.teamIds = [...new Set(g.docs.map((d) => d.teamId))];
  }
  return [...groups.values()];
}

// Working days of this leave that fall inside the given year.
export function daysInYear(group, person, holidays, year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const startDate = group.startDate < from ? from : group.startDate;
  const endDate = group.endDate > to ? to : group.endDate;
  if (endDate < startDate) return 0;
  return leaveWorkdays({ startDate, endDate, half: startDate === endDate ? group.half : 'full', teamId: group.docs[0].teamId }, person, holidays);
}

// One person's numbers for a year: for each kind with a limit, { entitled, used, pending, left }.
export function personBalance({ person, groups, policy, holidays, year }) {
  const mine = groups.filter((g) => g.userId === person.id && g.status !== 'ignore');
  const out = {};
  for (const type of ENTITLED_TYPES) {
    const entitled = entitlementFor(policy, person.id, type);
    let used = 0, pending = 0;
    for (const g of mine.filter((x) => x.type === type)) {
      const d = daysInYear(g, person, holidays, year);
      if (g.status === 'approved') used += d; else pending += d;
    }
    out[type] = { entitled, used, pending, left: entitled === null ? null : entitled - used - pending };
  }
  return out;
}

export function balances({ people, leaves, policy, holidays, year }) {
  const groups = groupLeaves(leaves);
  return people.map((person) => ({ person, byType: personBalance({ person, groups, policy, holidays, year }) }));
}

export const dayText = (n) => (n === null || n === undefined ? '–' : `${Math.round(n * 10) / 10}`);

// Validate what HR typed: a number of days from 0 to 366 in steps of half a day.
export function parseDays(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 366 || Math.round(n * 2) !== n * 2) return { ok: false };
  return { ok: true, value: n };
}

// Build the document to save. `days` and each override hold only kinds that have a number.
export function buildPolicy(year, days, overrides) {
  const clean = (o) => Object.fromEntries(ENTITLED_TYPES.filter((t) => typeof o?.[t] === 'number').map((t) => [t, o[t]]));
  const ov = {};
  for (const [uid, o] of Object.entries(overrides || {})) { const c = clean(o); if (Object.keys(c).length) ov[uid] = c; }
  return { year: String(year), days: clean(days), overrides: ov };
}
