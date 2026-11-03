// Small chart kit for the Team Overview. No libraries: bars are HTML, the column chart is SVG.
//
// Rules followed (see the data-visualisation notes):
//  - Colour means one thing everywhere: blue = on track / on time, orange = overdue / late.
//    Colours come from CSS variables (--viz-1, --viz-2) that have their own light and dark steps.
//  - Bars are thin (14 to 24px), the data end is rounded, touching parts are separated by a
//    2px gap in the surface colour, and values sit at the tip of the bar.
//  - A legend is shown whenever there are two series, and every chart has a table view.
//  - Text uses text colours, never the series colour; identity comes from the swatch beside it.

import { h, add, clear } from '../core/util.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

// ------------------------------------------------------------------ tooltip

let tip;
export function attachTip(node, text) {
  const show = (x, y) => {
    if (!tip) { tip = h('div', { class: 'viz-tip', role: 'tooltip' }); document.body.append(tip); }
    tip.textContent = typeof text === 'function' ? text() : text;
    tip.style.display = 'block';
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - hgt - 12) + 'px';
  };
  const hide = () => { if (tip) tip.style.display = 'none'; };
  node.addEventListener('mousemove', (e) => show(e.clientX, e.clientY));
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
  node.addEventListener('blur', hide);
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
}

// -------------------------------------------------------------- legend / table

export function legend(items) {
  return h('ul', { class: 'viz-legend' }, items.map((i) =>
    h('li', null, h('span', { class: 'viz-swatch', style: { background: i.color } }), i.name)));
}

export function tableView(headers, rows) {
  return h('details', { class: 'viz-table' },
    h('summary', null, 'View as table'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tasks compact' },
      h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : '' }, String(c)))))))));
}

export function noData(text) { return h('p', { class: 'muted viz-empty' }, text); }

// ------------------------------------------------------- single-series bars

// rows: [{ label, value, note? }]. Value is printed at the tip of the bar.
export function hbars({ rows, ariaLabel, unit = '' }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'hbars', role: 'list', 'aria-label': ariaLabel },
    rows.map((r) => {
      const row = h('div', { class: 'hbar-row', role: 'listitem' },
        h('span', { class: 'hbar-label', title: r.label }, r.label),
        h('span', { class: 'hbar-track' },
          h('span', { class: 'hbar-bar', style: { width: (r.value / max * 82) + '%', background: 'var(--viz-1)' } }),
          h('span', { class: 'hbar-value' }, String(r.value) + unit)));
      attachTip(row, `${r.label}: ${r.value}${unit}${r.note ? ' (' + r.note + ')' : ''}`);
      return row;
    }));
}

// ------------------------------------------------------------ stacked bars

// rows: [{ label, parts: [{ value, color, name }], tail?: string, note?: string }]
export function stackedHbars({ rows, ariaLabel }) {
  const max = Math.max(1, ...rows.map((r) => r.parts.reduce((n, p) => n + p.value, 0)));
  return h('div', { class: 'hbars', role: 'list', 'aria-label': ariaLabel },
    rows.map((r) => {
      const total = r.parts.reduce((n, p) => n + p.value, 0);
      const row = h('div', { class: 'hbar-row', role: 'listitem' },
        h('span', { class: 'hbar-label', title: r.label }, r.label),
        h('span', { class: 'hbar-track' },
          h('span', { class: 'hbar-stack', style: { width: (total / max * 82) + '%' } },
            r.parts.filter((p) => p.value > 0).map((p) => h('span', { class: 'hbar-seg', style: { flexGrow: p.value, background: p.color } }))),
          h('span', { class: 'hbar-value' }, String(total), r.tail ? h('span', { class: 'hbar-tail' }, ' ' + r.tail) : null)));
      attachTip(row, `${r.label}: ${r.parts.map((p) => `${p.value} ${p.name.toLowerCase()}`).join(', ')}${r.note ? '. ' + r.note : ''}`);
      return row;
    }));
}

// ------------------------------------------------------------ column chart

function niceMax(v) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function colPath(x, y, w, hgt, r, roundTop) {
  if (hgt <= 0) return '';
  const rr = roundTop ? Math.min(r, hgt, w / 2) : 0;
  return `M${x},${y + hgt} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + hgt} Z`;
}

// weeks: [{ label, tip, a, b }]  a = bottom segment (on time), b = top segment (late)
export function columns({ weeks, aName, bName, ariaLabel }) {
  const wrap = h('div', { class: 'cols' });
  const maxTotal = Math.max(0, ...weeks.map((w) => w.a + w.b));
  const draw = () => {
    clear(wrap);
    const W = Math.max(260, wrap.clientWidth || 520), H = 210;
    const m = { l: 30, r: 8, t: 18, b: 28 };
    const top = niceMax(maxTotal);
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const y = (v) => m.t + ih - (v / top) * ih;
    const band = iw / weeks.length;
    const bw = Math.min(24, band * 0.6);
    const peak = weeks.reduce((best, w, i) => (w.a + w.b > (weeks[best].a + weeks[best].b) ? i : best), 0);
    const ticks = [0, top / 4, top / 2, (top * 3) / 4, top].filter((t, i, arr) => arr.indexOf(t) === i && Number.isInteger(t));
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': ariaLabel },
      ticks.map((t) => svg('g', null,
        svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-axis' : 'viz-grid' }),
        svg('text', { x: m.l - 6, y: y(t) + 4, class: 'viz-tick', 'text-anchor': 'end' }, String(t)))),
      weeks.map((w, i) => {
        const x = m.l + band * i + (band - bw) / 2;
        const ha = (w.a / top) * ih, hb = (w.b / top) * ih;
        const gap = w.a > 0 && w.b > 0 ? 2 : 0;
        const label = i === peak || i === weeks.length - 1;
        const total = w.a + w.b;
        const hit = svg('rect', { x: m.l + band * i, y: m.t, width: band, height: ih + 6, fill: 'transparent', tabindex: 0, 'aria-label': w.tip, class: 'viz-hit' });
        attachTip(hit, w.tip);
        return svg('g', null,
          svg('path', { d: colPath(x, y(w.a), bw, ha, 4, w.b === 0), fill: 'var(--viz-1)' }),
          svg('path', { d: colPath(x, y(w.a + w.b) , bw, Math.max(0, hb - gap), 4, true), fill: 'var(--viz-2)' }),
          label && total > 0 ? svg('text', { x: x + bw / 2, y: y(total) - 5, class: 'viz-value', 'text-anchor': 'middle' }, String(total)) : null,
          svg('text', { x: x + bw / 2, y: H - 8, class: 'viz-tick', 'text-anchor': 'middle' }, w.label),
          hit);
      }));
    wrap.append(chart);
  };
  draw();
  if (typeof ResizeObserver !== 'undefined') {
    let last = 0;
    new ResizeObserver(() => { const w = wrap.clientWidth; if (Math.abs(w - last) > 4) { last = w; draw(); } }).observe(wrap);
  }
  return h('div', null,
    legend([{ name: aName, color: 'var(--viz-1)' }, { name: bName, color: 'var(--viz-2)' }]),
    wrap,
    tableView(['Week starting', aName, bName, 'Total'], weeks.map((w) => [w.label, w.a, w.b, w.a + w.b])));
}

export { add };
