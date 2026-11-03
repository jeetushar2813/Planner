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

// "Superuser" is not a role: it is a switch on a person's account (users/{id}.superuser) that gives
// them everything a Director can do while they keep their own role (for example Team Leader).
export const roleLabel = (u) => `${ROLE_LABEL[u?.role] || u?.role || ''}${u?.superuser ? ' · Superuser' : ''}${u?.hr ? ' · HR' : ''}`;

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
  'user.password': 'Changed own password',
  'team.create': 'Created team',
  'team.update': 'Edited team',
  'project.create': 'Created project',
  'project.update': 'Edited project',
  'status.create': 'Created status',
  'status.update': 'Edited status',
  'leave.request': 'Requested leave',
  'leave.record': 'Recorded leave',
  'leave.approve': 'Approved leave',
  'leave.decline': 'Declined leave',
  'leave.cancel': 'Cancelled leave',
  'leave.leader': 'Team Leader approved leave',
  'leave.ack': 'HR acknowledged leave',
  'policy.update': 'Updated leave entitlements',
  'holiday.create': 'Added holiday',
  'holiday.update': 'Edited holiday',
  'template.create': 'Created task template',
  'template.update': 'Edited task template',
  'template.run': 'Made a recurring task'
};

export const ENTITY_TYPES = ['task', 'comment', 'user', 'team', 'project', 'status', 'leave', 'holiday', 'policy'];

// Leave. Only APPROVED leave counts towards availability on the calendar.
export const LEAVE_TYPES = ['annual', 'sick', 'hospitalization', 'compassionate', 'marriage', 'training', 'other'];
// The kinds HR sets a yearly number of days for. Training and Other are not counted.
export const ENTITLED_TYPES = ['annual', 'sick', 'hospitalization', 'compassionate', 'marriage'];
export const LEAVE_TYPE_LABEL = {
  annual: 'Annual leave', sick: 'Medical leave', hospitalization: 'Hospitalization leave',
  compassionate: 'Compassionate leave', marriage: 'Marriage leave', training: 'Training', other: 'Other'
};
export const LEAVE_STATUS_LABEL = {
  pending: 'Waiting for Team Leader', leader_ok: 'Team Leader approved, waiting for Director',
  approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled'
};
export const HALF_LABEL = { full: 'Full day', am: 'Morning only', pm: 'Afternoon only' };

// How long cached reference data (people, teams, statuses, projects) is reused
// before it is read again. This is the main protection for the free quota.
export const REFDATA_TTL_MINUTES = 30;

// How many log rows are loaded per click on "Load more".
export const LOG_PAGE_SIZE = 40;
