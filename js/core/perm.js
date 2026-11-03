// Permission helpers. These mirror firestore.rules so the screens can hide buttons
// that would be refused. The rules remain the real protection.

import { ROLE_LEVEL } from './model.js';

// A Superuser has every power of the Director while keeping their own role. Only a Director or
// another Superuser can switch it on (People page), and it is enforced in firestore.rules.
export const isSuperuser = (u) => u?.superuser === true;
export const isDirector = (u) => u?.role === 'director' || isSuperuser(u);
export const isManager = (u) => u?.role === 'manager';
export const isLeader = (u) => u?.role === 'leader';
export const isDeputy = (u) => u?.role === 'asst_leader';
export const isMember = (u) => u?.role === 'member' && !isSuperuser(u);

// "Leader and above" in the planning document = Team Leader, Manager, Director.
export const isLeaderUp = (u) => isSuperuser(u) || ROLE_LEVEL[u?.role] >= ROLE_LEVEL.leader;

// Anyone who can lead work: adds the Assistant Team Leader.
export const isDeputyUp = (u) => isSuperuser(u) || ROLE_LEVEL[u?.role] >= ROLE_LEVEL.asst_leader;

export const teamIdsOf = (u) => (u?.teamIds || []);
export const inTeam = (u, teamId) => teamIdsOf(u).includes(teamId);
export const inScope = (u, teamId) => isDirector(u) || inTeam(u, teamId);

// Teams a person may see tasks for.
export function visibleTeams(user, allTeams) {
  const active = allTeams.filter((t) => t.active !== false);
  return isDirector(user) ? active : active.filter((t) => inTeam(user, t.id));
}

// ---- project owners
// One person owns each project (set by a Team Leader, Manager or Director). The store keeps
// the ids of the projects a person owns on their user record as `ownedProjectIds`.
export const ownsProject = (u, projectId) => !!projectId && (u?.ownedProjectIds || []).includes(projectId);
export const ownsAnyProject = (u) => (u?.ownedProjectIds || []).length > 0;
// A project owner's reach over a task: it is in their project and belongs to someone else.
export const ownsProjectTask = (u, task) => ownsProject(u, task.projectId) && task.ownerId !== u.id;

export function canViewTask(user, task) {
  return isDirector(user) || task.ownerId === user.id || inTeam(user, task.teamId)
    || task.createdBy === user.id || ownsProject(user, task.projectId);
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

// Project owners can hand a task of their project to anyone (in that person's team).
export function canReassign(user, task) { return canEditDetails(user, task) || ownsProjectTask(user, task); }

export function canArchive(user, task) {
  if (isDirector(user)) return true;
  return isLeaderUp(user) && inTeam(user, task.teamId);
}

// Which statuses may this person move this task into?
// Members are limited to non-finished categories unless their team switched the approval gate off.
export function allowedStatuses(user, task, statuses, team) {
  const usable = statuses.filter((s) => s.active !== false);
  if (isDirector(user)) return usable;
  // A project owner approves or sends back work that is waiting in Review (not their own).
  const reviewer = ownsProjectTask(user, task) && task.statusCategory === 'review' ? usable : [];
  if (!isMember(user)) {
    return inTeam(user, task.teamId) ? usable : reviewer;
  }
  if (task.ownerId !== user.id) return reviewer;
  if (!inTeam(user, task.teamId)) return [];
  if (['done', 'closed'].includes(task.statusCategory)) return []; // only leaders reopen
  const gateOff = team && team.approvalGate === false;
  return usable.filter((s) => ['todo', 'active', 'review', 'paused'].includes(s.category)
    || (gateOff && s.category === 'done'));
}

export function canChangeStatus(user, task, statuses, team) {
  return allowedStatuses(user, task, statuses, team).length > 0;
}

// Steps given to someone: they (or, for a step given to the whole team, anyone in the task's
// team) may tick it while the task is still open. Nothing else on the task.
export function isStepHelper(user, task, item) {
  return !!item && !['done', 'closed'].includes(task.statusCategory) && inTeam(user, task.teamId)
    && (item.assigneeId === user.id || (item.forTeam === true && !item.assigneeId));
}

function canTickAllSteps(user, task) {
  if (isMember(user)) return task.ownerId === user.id && !['done', 'closed'].includes(task.statusCategory);
  return canEditDetails(user, task) || task.ownerId === user.id;
}

export function canTickItem(user, task, item) {
  return canTickAllSteps(user, task) || isStepHelper(user, task, item);
}

export function canTickChecklist(user, task) {
  return canTickAllSteps(user, task) || (task.checklist || []).some((i) => isStepHelper(user, task, i));
}

// Who may give steps to people: the same people who edit the task's details.
export const canAssignSteps = canEditDetails;

export function canComment(user, task) { return canViewTask(user, task); }

// Whether any edit at all is possible (shows the Save button).
export function canEditAnything(user, task, statuses, team) {
  return canEditDetails(user, task) || canChangeStatus(user, task, statuses, team)
    || canTickChecklist(user, task) || canReassign(user, task);
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

// ---- leave
// Anyone requests leave for themselves. Approving and recording leave for others is for
// Team Leaders, Managers and the Director (inside their own team; the Director anywhere).
export const canApproveLeave = (u, leave) =>
  (isDirector(u) || (isLeaderUp(u) && inTeam(u, leave.teamId))) && (leave.userId !== u.id || isDirector(u));
export const canRecordLeaveFor = (u, person, teamId) =>
  isDirector(u) || (isLeaderUp(u) && inTeam(u, teamId) && (person.teamIds || []).includes(teamId));
export const canCancelLeave = (u, leave) =>
  leave.status === 'pending' || leave.status === 'approved'
    ? (leave.userId === u.id || isDirector(u) || (isLeaderUp(u) && inTeam(u, leave.teamId)))
    : false;
// Who can see other people's leave: leaders and deputies (inside their teams), the Director everywhere.
export const canSeeTeamLeave = (u) => isDeputyUp(u);
// Public holidays: the Director for everyone, Managers and Team Leaders for their own team.
export const canManageHolidays = (u) => isLeaderUp(u);
export const canEditHoliday = (u, holiday) =>
  isDirector(u) || (isLeaderUp(u) && !!holiday.teamId && inTeam(u, holiday.teamId));
// The Team Overview and resource planning are for people who run work.
export const canSeeOverview = (u) => isDeputyUp(u);

// Reports (week, month, quarter, year) for teams and people: Assistant Team Leaders and above.
// Project owners get reports for their own projects, even when they are team members.
export const canSeeReports = (u) => isDeputyUp(u) || ownsAnyProject(u);
export const canSeeTeamReports = (u) => isDeputyUp(u);
// The "My projects" page is for people who own a project, and for leaders who hand work to others.
export const canSeeProjects = (u) => ownsAnyProject(u) || isDeputyUp(u);
