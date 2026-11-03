// Small helpers: DOM building, dates, formatting. No dependencies.

// h('div', {class:'x', onclick: fn}, 'text', childNode) builds DOM safely.
// Text is always inserted with textContent, so user input can never inject HTML.
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'readOnly') {
        node[key] = !!value;
      } else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Like node.append(...) but skips null, undefined and false instead of printing them.
export function add(node, ...children) {
  append(node, children);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(selector, root = document) { return root.querySelector(selector); }

// ---------------------------------------------------------------- dates
// Task dates are stored as plain 'YYYY-MM-DD' text so there are no time zone surprises.

const pad = (n) => String(n).padStart(2, '0');

export function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayISO() { return toISO(new Date()); }

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return toISO(date);
}

export function daysBetween(fromISO, toISOstr) {
  const a = parseISO(fromISO), b = parseISO(toISOstr);
  return Math.round((b - a) / 86400000);
}

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---- calendar helpers (all on 'YYYY-MM-DD' text)

export function dow(iso) { return parseISO(iso).getDay(); }   // 0 = Sunday

// First day of the week containing `iso`. weekStartsOn: 1 = Monday, 0 = Sunday.
export function startOfWeek(iso, weekStartsOn = 1) {
  const diff = (dow(iso) - weekStartsOn + 7) % 7;
  return addDays(iso, -diff);
}

export function startOfMonth(iso) { return iso.slice(0, 8) + '01'; }

export function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  return toISO(new Date(y, m - 1 + n, 1));
}

export function endOfMonth(iso) { return addDays(addMonths(iso, 1), -1); }

// Every date from `fromISO` to `toISOstr`, inclusive.
export function eachDay(fromISO, toISOstr) {
  const out = [];
  for (let d = fromISO; d <= toISOstr; d = addDays(d, 1)) out.push(d);
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM-DD' -> '3 Nov'  (adds the year when it is not the current year)
export function fmtDate(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ' ' + d.getFullYear()}`;
}

export function fmtMonthYear(iso) {
  const d = parseISO(iso);
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtWeekday(iso, long = false) {
  const names = long ? WEEKDAYS_LONG : WEEKDAYS;
  return names[dow(iso)];
}

export function fmtDateLong(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Firestore Timestamp, JS Date, ISO text or number -> JS Date (or null)
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value === 'number' || typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d) ? null : d;
  }
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  return null;
}

export function fmtDateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`;
}

export function fmtAgo(value) {
  const d = toDate(value);
  if (!d) return 'never';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return fmtDate(toISO(d));
}

// ---------------------------------------------------------------- misc

export function uid20() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

export function unique(list) { return [...new Set(list)]; }

export function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

export function pluralize(n, word, plural) {
  return `${n} ${n === 1 ? word : (plural || word + 's')}`;
}
