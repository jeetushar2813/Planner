// Tags: short lower-case labels on a task. At most 8 per task, 24 characters each.
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;

export function cleanTag(text) {
  return String(text || '').replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, MAX_TAG_LENGTH);
}

export function cleanTags(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const c = cleanTag(t);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, MAX_TAGS);
}

// Every tag in use on the given tasks, most used first (for suggestions and the filter).
export function tagCounts(tasks) {
  const n = new Map();
  for (const t of tasks) for (const tag of t.tags || []) n.set(tag, (n.get(tag) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
