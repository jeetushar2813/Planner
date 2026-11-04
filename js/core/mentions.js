// @mentions in comments. Pure functions, so the page and the tests use the same rules.
//   "@Omar Hakim please check this" names Omar. The comment keeps a list of the people it names
//   (their ids, at most 5) and each of them gets a note in the Alerts bell.

export const MAX_MENTIONS = 5;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Who a comment names. `people` is [{ id, name }]. A name counts when it follows "@", starts a
// word, and is followed by a space, punctuation or the end. The longest names are tried first, so
// "@Mei Ling Tan" is not read as "@Mei Ling". Returns unique ids in the order they appear.
export function findMentions(text, people, max = MAX_MENTIONS) {
  const body = String(text || '');
  const found = [];
  const byLength = [...people].filter((p) => p && p.name).sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    const re = new RegExp(`(^|[\\s(\\[{"'])@${escapeRe(p.name)}(?=$|[\\s.,;:!?)\\]}"'])`, 'gi');
    let m;
    while ((m = re.exec(body))) {
      found.push({ id: p.id, at: m.index + m[1].length, end: m.index + m[0].length });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  // Drop a match that sits inside a longer one, then keep the first mention of each person.
  const kept = found.filter((a) => !found.some((b) => b !== a && b.at <= a.at && b.end >= a.end && (b.end - b.at) > (a.end - a.at)));
  kept.sort((a, b) => a.at - b.at);
  const ids = [];
  for (const k of kept) if (!ids.includes(k.id)) ids.push(k.id);
  return ids.slice(0, max);
}

// Cuts a comment into plain pieces and mention pieces, for showing it with the names highlighted.
// [{ text, mention: true|false }]
export function splitMentions(text, people) {
  const body = String(text || '');
  const spans = [];
  const byLength = [...people].filter((p) => p && p.name).sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    const re = new RegExp(`(^|[\\s(\\[{"'])(@${escapeRe(p.name)})(?=$|[\\s.,;:!?)\\]}"'])`, 'gi');
    let m;
    while ((m = re.exec(body))) {
      const at = m.index + m[1].length;
      const end = at + m[2].length;
      if (!spans.some((s) => at < s.end && end > s.at)) spans.push({ at, end });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  spans.sort((a, b) => a.at - b.at);
  const out = [];
  let pos = 0;
  for (const s of spans) {
    if (s.at > pos) out.push({ text: body.slice(pos, s.at), mention: false });
    out.push({ text: body.slice(s.at, s.end), mention: true });
    pos = s.end;
  }
  if (pos < body.length) out.push({ text: body.slice(pos), mention: false });
  return out.length ? out : [{ text: body, mention: false }];
}

// The "@word" being typed right before the caret, or null. Used for the suggestion list.
export function mentionQuery(text, caret) {
  const before = String(text || '').slice(0, caret);
  const m = /(^|[\s(])@([^\s@]{0,30})$/.exec(before);
  return m ? { query: m[2], start: before.length - m[2].length - 1 } : null;
}

// People matching what has been typed after "@": any word of the name starts with it.
export function suggestPeople(people, query, limit = 6) {
  const q = String(query || '').toLowerCase();
  return people
    .filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

// A short line for the alert: the comment's first 140 characters.
export const snippetOf = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 137) + '...' : t;
};
