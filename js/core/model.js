// Constants shared by the whole app: roles, priorities, status categories, defaults.
// The Security Rules in firestore.rules use the same role names and category names.

export const ROLES = ['director', 'manager', 'leader', 'asst_leader', 'member'];

export const ROLE_LABEL = {
  director: 'Director',
  manager: 'Manager',
  leader: 'Team Leader',
  asst_leader: 'Assistant Team Leader',
  member: 'Team Member'
};

// Higher number = more authority.
export const ROLE_LEVEL = { director: 5, manager: 4, leader: 3, asst_leader: 2, member: 1 };

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };

// Every status belongs to a category. Reports and permissions use the category,
// so adding a new status never breaks the numbers.
export const CATEGORIES = ['todo', 'active', 'review', 'paused', 'done', 'closed'];
export const CATEGORY_LABEL = {
  todo: 'To do', active: 'Active', review: 'Review',
  paused: 'Paused', done: 'Done', closed: 'Closed'
};
export const OPEN_CATEGORIES = ['todo', 'active', 'review', 'paused'];
export const FINISHED_CATEGORIES = ['done', 'closed'];

// Seeded once by the Director ("Set up default statuses"). Ids are fixed because
// the Security Rules and the approval gate refer to them.
export const DEFAULT_STATUSES = [
  { id: 'pending',     name: 'Pending',             category: 'todo',   color: '#64748b', order: 10, needsReason: false },
  { id: 'in_progress', name: 'In Progress',         category: 'active', color: '#2563eb', order: 20, needsReason: false },
  { id: 'in_review',   name: 'In Review',           category: 'review', color: '#7c3aed', order: 30, needsReason: false },
  { id: 'rework',      name: 'Returned for Rework', category: 'active', color: '#d97706', order: 40, needsReason: true },
  { id: 'on_hold',     name: 'On Hold',             category: 'paused', color: '#0891b2', order: 50, needsReason: true },
  { id: 'blocked',     name: 'Blocked',             category: 'paused', color: '#dc2626', order: 60, needsReason: true },
  { id: 'completed',   name: 'Completed',           category: 'done',   color: '#16a34a', order: 70, needsReason: false },
  { id: 'cancelled',   name: 'Cancelled',           category: 'closed', color: '#94a3b8', order: 80, needsReason: false }
];

// The status a brand-new task starts in.
export const INITIAL_STATUS_ID = 'pending';

// Log actions (kept short so the log reads well).
export const ACTION_LABEL = {
  'task.create': 'Created task',
  'task.update': 'Edited task',
  'task.status': 'Changed status',
  'task.assign': 'Reassigned task',
  'task.archive': 'Archived task',
  'task.restore': 'Restored task',
  'comment.add': 'Added comment',
  'auth.login': 'Signed in',
  'user.create': 'Created account',
  'user.update': 'Edited account',
  'team.create': 'Created team',
  'team.update': 'Edited team',
  'project.create': 'Created project',
  'project.update': 'Edited project',
  'status.create': 'Created status',
  'status.update': 'Edited status'
};

export const ENTITY_TYPES = ['task', 'comment', 'user', 'team', 'project', 'status'];

// How long cached reference data (people, teams, statuses, projects) is reused
// before it is read again. This is the main protection for the free quota.
export const REFDATA_TTL_MINUTES = 30;

// How many log rows are loaded per click on "Load more".
export const LOG_PAGE_SIZE = 40;
