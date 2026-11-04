// Checklist steps that are given to someone. A step is
//   { id, text, done, assigneeId?, forTeam?, doneBy?, doneAt? }
// assigneeId = one person; forTeam = the whole team of the task, so any one of them can do it.
// Only people in the task's team can be given a step (the Security Rules read the team's
// members from the task, not from the step).

// The two summary fields stored on the task. Security Rules cannot look inside the list, so
// they use these to decide who may tick steps: checklistAssignees (people named on any step)
// and checklistForTeam (true when any step belongs to the whole team).
export function deriveStepFields(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return {
    checklistAssignees: [...new Set(list.map((s) => s.assigneeId).filter(Boolean))],
    checklistForTeam: list.some((s) => s.forTeam === true)
  };
}

// Keeps only the keys a step may have and drops empty ones (Firestore has no "undefined").
export function cleanSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((s) => {
    const out = { id: s.id, text: String(s.text || '').slice(0, 200), done: s.done === true };
    if (s.assigneeId) out.assigneeId = s.assigneeId;
    if (s.forTeam === true && !s.assigneeId) out.forTeam = true;
    // who gave the step to this person, and when (their "given to you" alert reads these)
    if (s.assigneeId && s.assignedAt) out.assignedAt = s.assignedAt;
    if (s.assigneeId && s.assignedBy) out.assignedBy = s.assignedBy;
    if (out.done && s.doneBy) out.doneBy = s.doneBy;
    if (out.done && s.doneAt) out.doneAt = s.doneAt;
    return out;
  });
}

// When a task moves to another team, steps given to people outside that team lose their helper.
// `teamIdsOf(userId)` returns the teams of a person. Returns { steps, dropped }.
export function dropOutsiders(steps, teamId, teamIdsOf) {
  let dropped = 0;
  const out = (steps || []).map((s) => {
    if (s.assigneeId && !teamIdsOf(s.assigneeId).includes(teamId)) {
      const { assigneeId, ...rest } = s; // eslint-disable-line no-unused-vars
      dropped++;
      return rest;
    }
    return s;
  });
  return { steps: out, dropped };
}

// Steps that still wait for this person: given to them, or to their whole team.
export function stepsForUser(task, user) {
  if (!user || !task) return [];
  const inTeam = (user.teamIds || []).includes(task.teamId);
  return (task.checklist || []).filter((s) => !s.done
    && (s.assigneeId === user.id || (s.forTeam === true && inTeam)));
}

// Stamps "given by / given at" on every step that has a person. A step keeps its old stamp only
// when the same person still holds it; a new or changed person gets a fresh one. `original` is
// the task's steps before the change (empty for a new task, so a copied task stamps again).
export function stampSteps(steps, original, userId, nowISO = new Date().toISOString()) {
  const before = new Map((original || []).map((s) => [s.id, s]));
  return (steps || []).map((s) => {
    if (!s.assigneeId) {
      const { assignedAt, assignedBy, ...rest } = s; // eslint-disable-line no-unused-vars
      return rest;
    }
    const prev = before.get(s.id);
    if (prev && prev.assigneeId === s.assigneeId) {
      // Same person as before: keep the old stamp. Steps given before this feature have none and
      // stay that way, so an unrelated edit never rewrites them.
      return prev.assignedAt ? { ...s, assignedAt: prev.assignedAt, assignedBy: prev.assignedBy || s.assignedBy } : s;
    }
    return { ...s, assignedAt: nowISO, assignedBy: userId };
  });
}

// Steps given to this person by someone else after `seenAt` (ms), still waiting, on open tasks.
// Returns [{ task, step, at }] newest first.
export function newStepsFor(tasks, user, seenAt, isOpen) {
  const out = [];
  for (const task of tasks) {
    if (task.archived || !isOpen(task)) continue;
    for (const step of task.checklist || []) {
      if (step.done || step.assigneeId !== user.id || !step.assignedAt) continue;
      if (step.assignedBy === user.id) continue;
      const at = new Date(step.assignedAt).getTime();
      if (at > seenAt) out.push({ task, step, at });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export const hasSteps =(task) => (task.checklist || []).some((s) => s.assigneeId || s.forTeam);
