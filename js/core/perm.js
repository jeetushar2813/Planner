// Permission helpers. These mirror firestore.rules so the screens can hide buttons
// that would be refused. The rules remain the real protection.

import { ROLE_LEVEL } from './model.js';

export const isDirector = (u) => u?.role === 'director';
export const isManager = (u) => u?.role === 'manager';
export const isLeader = (u) => u?.role === 'leader';
export const isDeputy = (u) => u?.role === 'asst_leader';
export const isMember = (u) => u?.role === 'member';

// "Leader and above" in the planning document = Team Leader, Manager, Director.
export const isLeaderUp = (u) => ROLE_LEVEL[u?.role] >= ROLE_LEVEL.leader;

// Anyone who can lead work: adds the Assistant Team Leader.
export const isDeputyUp = (u) => ROLE_LEVEL[u?.role] >= ROLE_LEVEL.asst_leader;

export const teamIdsOf = (u) => (u?.teamIds || []);
export const inTeam = (u, teamId) => teamIdsOf(u).includes(teamId);
export const inScope = (u, teamId) => isDirector(u) || inTeam(u, teamId);

// Teams a person may see tasks for.
export function visibleTeams(user, allTeams) {
  const active = allTeams.filter((t) => t.active !== false);
  return isDirector(user) ? active : active.filter((t) => inTeam(user, t.id));
}

export function canViewTask(user, task) {
  return isDirector(user) || task.ownerId === user.id || inTeam(user, task.teamId);
}

// Can this person create tasks at all, and for whom?
export function canCreateTask(user) { return !!user; } // members: own tasks only (see canAssignTo)

export function canAssignTo(user, owner, teamId) {
  if (!owner) return false;
  if (isDirector(user)) return true;
  if (isMember(user)) return owner.id === user.id && inTeam(user, teamId);
  return isDeputyUp(user) && inTeam(user, teamId) && (owner.teamIds || []).includes(teamId);
}

// Edit title, description, priority, project, estimate, dates (except deadline for deputies).
export function canEditDetails(user, task) {
  if (isDirector(user)) return true;
  if (isMember(user)) return false;
  return isDeputyUp(user) && inTeam(user, task.teamId);
}

export function canChangeDeadline(user, task) {
  if (isDirector(user)) return true;
  return isLeaderUp(user) && inTeam(user, task.teamId);
}

export function canReassign(user, task) { return canEditDetails(user, task); }

export function canArchive(user, task) {
  if (isDirector(user)) return true;
  return isLeaderUp(user) && inTeam(user, task.teamId);
}

// Which statuses may this person move this task into?
// Members are limited to non-finished categories unless their team switched the approval gate off.
export function allowedStatuses(user, task, statuses, team) {
  const usable = statuses.filter((s) => s.active !== false);
  if (isDirector(user)) return usable;
  if (!isMember(user)) {
    return inTeam(user, task.teamId) ? usable : [];
  }
  if (task.ownerId !== user.id || !inTeam(user, task.teamId)) return [];
  if (['done', 'closed'].includes(task.statusCategory)) return []; // only leaders reopen
  const gateOff = team && team.approvalGate === false;
  return usable.filter((s) => ['todo', 'active', 'review', 'paused'].includes(s.category)
    || (gateOff && s.category === 'done'));
}

export function canChangeStatus(user, task, statuses, team) {
  return allowedStatuses(user, task, statuses, team).length > 0;
}

export function canTickChecklist(user, task) {
  if (isMember(user)) return task.ownerId === user.id && !['done', 'closed'].includes(task.statusCategory);
  return canEditDetails(user, task) || task.ownerId === user.id;
}

export function canComment(user, task) { return canViewTask(user, task); }

// Whether any edit at all is possible (shows the Save button).
export function canEditAnything(user, task, statuses, team) {
  return canEditDetails(user, task) || canChangeStatus(user, task, statuses, team)
    || canTickChecklist(user, task);
}

// ---- admin areas
export const canManageUsers = isDirector;
export const canManageStatuses = isDirector;
export const canCreateTeams = isDirector;
export const canEditTeam = (u, team) => isDirector(u) || (isManager(u) && inTeam(u, team.id));
export const canManageProjects = (u) => isLeaderUp(u);
export const canSeeLog = (u) => isLeaderUp(u) || isDeputy(u) || isMember(u); // members: own activity only
export const canSeeTeamLog = isLeaderUp; // director, manager, leader see team activity

// Who can the person see in team lists?
export function logScopeLabel(user) {
  if (isDirector(user)) return 'Everyone';
  if (isLeaderUp(user)) return 'Your team(s)';
  return 'Your own activity';
}
