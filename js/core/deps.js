// "Blocked by": a task can name up to 5 other tasks that must be finished first.
import { FINISHED_CATEGORIES } from './model.js';

export const MAX_BLOCKERS = 5;
const finished = (t) => t.archived || FINISHED_CATEGORIES.includes(t.statusCategory);

// Which of this task's blockers are still open? `lookup(id)` returns a task or null (not loaded).
// Returns { open: [tasks], unknown: n }.
export function openBlockers(task, lookup) {
  const open = [];
  let unknown = 0;
  for (const id of task?.blockedBy || []) {
    const b = lookup(id);
    if (!b) unknown++;
    else if (!finished(b)) open.push(b);
  }
  return { open, unknown };
}

// Would making `taskId` wait for `blockerId` create a loop (A waits for B, B waits for A ...)?
export function wouldLoop(taskId, blockerId, lookup) {
  if (!taskId) return false;               // a task that does not exist yet cannot be waited for
  const seen = new Set();
  const stack = [blockerId];
  while (stack.length) {
    const id = stack.pop();
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of lookup(id)?.blockedBy || []) stack.push(next);
  }
  return false;
}
