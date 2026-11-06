'use strict';
(function () {
  // ===================================================================================
  // Data & helpers
  // ===================================================================================
  const DATA = JSON.parse(document.getElementById('asiair-data').textContent);
  const SESSIONS = DATA.sessions.slice().sort((a, b) => (a.start < b.start ? 1 : -1)); // newest first
  const S_BY_ID = {};
  DATA.sessions.forEach(s => { S_BY_ID[s.id] = s; });

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const T = s => (s ? new Date(s).getTime() : null);
  const pad2 = n => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fmtTime = d => (d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : '—');
  const fmtHM = d => (d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '—');
  const fmtDate = d => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const fmtDateShort = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const fmtDur = s => {
    if (s == null) return '—';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${pad2(m)}m`;
    if (m) return `${m}m ${pad2(sec)}s`;
    return `${sec}s`;
  };
  const fmtHours = s => (s == null ? '—' : (s / 3600).toFixed(s >= 36000 ? 1 : 2) + ' h');
  const fmtExp = s => (s == null ? 'auto' : s >= 1 ? (Number.isInteger(s) ? s + 's' : s.toFixed(1) + 's') : Math.round(s * 1000) + 'ms');
  const fmtNum = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));
  const arcsec = v => (v == null || isNaN(v) ? '—' : `${Number(v).toFixed(2)}″`);
  const fmtTick = v => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number.isInteger(v) ? String(v) : String(+v.toFixed(2)));
  const sum = arr => arr.reduce((a, b) => a + (b || 0), 0);
  const clamp = (v, d) => Math.max(d[0], Math.min(d[1], v));
  const median = arr => { const a = arr.filter(v => v != null && !isNaN(v)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // Filter colours: fixed slot per filter name by first appearance across all sessions (never re-assigned).
  const FILTER_SLOTS = {};
  (function () {
    const names = [];
    DATA.sessions.slice().sort((a, b) => (a.start < b.start ? -1 : 1)).forEach(s => (s.summary.filters || []).forEach(f => { if (!names.includes(f)) names.push(f); }));
    DATA.sessions.forEach(s => (s.summary.integration || []).forEach(d => { if (d.filter && d.filter !== '?' && !names.includes(d.filter)) names.push(d.filter); }));
    names.forEach((n, i) => { FILTER_SLOTS[n] = i < 8 ? i + 1 : null; });
  })();
  const filterColor = name => {
    if (!name || name === '?') return 'var(--cal-frame)';
    const slot = FILTER_SLOTS[name];
    return slot ? `var(--cat-${slot})` : 'var(--muted)';
  };
  const filterChip = name => `<span class="chip"><i style="--c:${filterColor(name)}"></i>${esc(name && name !== '?' ? name : 'unknown filter')}</span>`;
  const filterLegend = names => `<div class="legend">${names.map(n => `<span><i style="--c:${filterColor(n)}"></i>${esc(n === '?' ? 'unknown filter' : n)}</span>`).join('')}</div>`;

  const sessTitle = s => (s.summary.targets.length ? s.summary.targets.join(' · ') : s.summary.plans.length ? s.summary.plans.join(' · ') : 'Session');
  const sessKind = s => (s.summary.light_frames > 0 ? 'imaging' : Object.keys(s.summary.frames_by_type || {}).length ? 'calibration' : s.guiding.sections.length ? 'guiding' : 'other');
  const FRAME = s => s.autorun.frames;
  const RUN = (s, id) => (id == null ? null : s.autorun.runs[id]);

  // ===================================================================================
  // State & routing
  // ===================================================================================
  const store = {
    get(k, d) { try { const v = localStorage.getItem('asiair.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('asiair.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const ui = { view: 'all', id: null, tab: 'overview', theme: store.get('theme', 'dark'), railQuery: '', per: {} };
  const perSession = id => ui.per[id] || (ui.per[id] = {
    section: null, af: null,
    frames: { sort: 't', dir: 1, type: 'light', filter: '', target: '' },
    log: { q: '', cats: new Set(), levels: new Set(), src: new Set(['autorun', 'phd2']), limit: 400 },
  });
  const TABS = [['overview', 'Overview'], ['autofocus', 'Autofocus'], ['guiding', 'Guiding'], ['frames', 'Frames'], ['log', 'Log'], ['equipment', 'Equipment']];

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
    if (parts[0] === 's' && S_BY_ID[parts[1]]) return { view: 'session', id: parts[1], tab: TABS.some(t => t[0] === parts[2]) ? parts[2] : 'overview' };
    if (parts[0] === 'all') return { view: 'all' };
    const first = SESSIONS.find(s => sessKind(s) === 'imaging') || SESSIONS[0];
    return first ? { view: 'session', id: first.id, tab: 'overview' } : { view: 'all' };
  }
  function nav(hash) { if (location.hash === hash) render(); else location.hash = hash; }
  const sessHref = (id, tab) => `#/s/${id}/${tab || 'overview'}`;
  window.addEventListener('hashchange', () => { Object.assign(ui, parseHash()); render(); });
  window.addEventListener('resize', debounce(() => renderMain(true), 150));

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function applyTheme() { document.documentElement.dataset.theme = ui.theme; }

  // ===================================================================================
  // Tooltip
  // ===================================================================================
  const tipEl = document.getElementById('tooltip');
  function showTip(ev, html) { tipEl.innerHTML = html; tipEl.hidden = false; positionTip(ev); }
  function positionTip(ev) {
    const gap = 14; const r = tipEl.getBoundingClientRect();
    let x = ev.clientX + gap, y = ev.clientY + gap;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - gap;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - gap;
    tipEl.style.left = Math.max(4, x) + 'px'; tipEl.style.top = Math.max(4, y) + 'px';
  }
  function hideTip() { tipEl.hidden = true; }
  document.addEventListener('mouseover', ev => { const t = ev.target.closest && ev.target.closest('[data-tip]'); if (t) showTip(ev, t.getAttribute('data-tip')); });
  document.addEventListener('mousemove', ev => { if (tipEl.hidden) return; const t = ev.target.closest && ev.target.closest('[data-tip]'); if (t) positionTip(ev); });
  document.addEventListener('mouseout', ev => { const t = ev.target.closest && ev.target.closest('[data-tip]'); if (t && !(ev.relatedTarget && t.contains(ev.relatedTarget))) hideTip(); });
  const ttRow = (label, value, color) => `<div class="tt-row"><span>${color ? `<i style="--c:${color}"></i>` : ''}${esc(label)}</span><b>${value}</b></div>`;

  // ===================================================================================
  // SVG chart library
  // ===================================================================================
  const NS = 'http://www.w3.org/2000/svg';
  let CHART_ID = 0;
  function el(tag, attrs, ...children) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    children.flat().forEach(c => { if (c != null) e.append(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function scale(d0, d1, r0, r1) {
    const span = (d1 - d0) || 1;
    const f = v => r0 + ((v - d0) / span) * (r1 - r0);
    f.invert = p => d0 + ((p - r0) / (r1 - r0)) * span;
    f.d = [d0, d1]; f.r = [r0, r1];
    return f;
  }
  function niceStep(span, n) {
    const raw = span / Math.max(1, n);
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  }
  function linTicks(d0, d1, n = 5) {
    if (!(d1 > d0)) return [d0];
    const step = niceStep(d1 - d0, n); const out = [];
    for (let v = Math.ceil(d0 / step) * step; v <= d1 + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const TSTEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440].map(m => m * 60000);
  function timeTicks(t0, t1, n = 6) {
    const span = t1 - t0;
    const step = TSTEPS.find(s => span / s <= n) || TSTEPS[TSTEPS.length - 1];
    const off = new Date(t0).getTimezoneOffset() * 60000;
    let t = Math.floor((t0 - off) / step) * step + off;
    const out = [];
    for (; t <= t1; t += step) if (t >= t0) out.push(t);
    return out;
  }
  function extent(vals) { let lo = Infinity, hi = -Infinity; for (const v of vals) { if (v == null || isNaN(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; } return lo === Infinity ? [0, 1] : [lo, hi]; }
  function padDomain(d, f = 0.08) { const span = (d[1] - d[0]) || Math.abs(d[0]) || 1; return [d[0] - span * f, d[1] + span * f]; }
  function niceDomain(d, n = 4) { const step = niceStep(d[1] - d[0], n); return [Math.floor(d[0] / step) * step, Math.ceil(d[1] / step) * step]; }

  function baseChart(container, o) {
    const w = Math.max(280, container.clientWidth || 640);
    const h = o.height || 220;
    const pad = Object.assign({ t: o.yLabel ? 24 : 14, r: 16, b: o.xLabel ? 40 : 30, l: 52 }, o.pad);
    const sx = scale(o.x[0], o.x[1], pad.l, w - pad.r);
    const sy = scale(o.y[0], o.y[1], h - pad.b, pad.t);
    const svg = el('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const uid = 'clip' + (++CHART_ID);
    svg.append(el('defs', {}, el('clipPath', { id: uid }, el('rect', { x: pad.l, y: pad.t, width: w - pad.l - pad.r, height: h - pad.t - pad.b }))));
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const yt = o.yTicks || linTicks(o.y[0], o.y[1], o.yTickCount || Math.max(2, Math.floor(ph / 45)));
    const xt = o.xTicks || (o.xTime ? timeTicks(o.x[0], o.x[1], Math.max(3, Math.floor(pw / 90))) : linTicks(o.x[0], o.x[1], Math.max(3, Math.floor(pw / 80))));
    const grid = el('g', { class: 'grid' });
    if (!o.noYGrid) yt.forEach(v => grid.append(el('line', { x1: pad.l, x2: w - pad.r, y1: sy(v), y2: sy(v) })));
    if (!o.noXGrid) xt.forEach(v => grid.append(el('line', { x1: sx(v), x2: sx(v), y1: pad.t, y2: h - pad.b })));
    svg.append(grid);
    const ax = el('g', { class: 'axis' });
    ax.append(el('line', { x1: pad.l, x2: w - pad.r, y1: h - pad.b, y2: h - pad.b }));
    const yFmt = o.yFmt || fmtTick;
    yt.forEach(v => ax.append(el('text', { x: pad.l - 8, y: sy(v) + 3.5, 'text-anchor': 'end' }, yFmt(v))));
    const xFmt = o.xFmt || (o.xTime ? v => fmtHM(new Date(v)) : fmtTick);
    xt.forEach(v => ax.append(el('text', { x: sx(v), y: h - pad.b + 15, 'text-anchor': 'middle' }, xFmt(v))));
    if (o.yLabel) ax.append(el('text', { class: 'lab', x: pad.l, y: pad.t - 9, 'text-anchor': 'start' }, o.yLabel));
    if (o.xLabel) ax.append(el('text', { class: 'lab', x: w - pad.r, y: h - 6, 'text-anchor': 'end' }, o.xLabel));
    svg.append(ax);
    if (o.y[0] < 0 && o.y[1] > 0) svg.append(el('line', { class: 'zero', x1: pad.l, x2: w - pad.r, y1: sy(0), y2: sy(0) }));
    const g = el('g', { 'clip-path': `url(#${uid})` });
    const over = el('g');
    svg.append(g, over);
    container.innerHTML = '';
    container.append(svg);
    return { svg, g, over, sx, sy, w, h, pad, pw, ph, x: o.x, y: o.y };
  }
  function pathD(pts, sx, sy, yd) {
    let d = '', pen = false;
    for (const p of pts) {
      if (p[1] == null || isNaN(p[1])) { pen = false; continue; }
      const y = yd ? clamp(p[1], yd) : p[1];
      d += (pen ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sy(y).toFixed(1);
      pen = true;
    }
    return d;
  }
  function nearestIdx(pts, x) {
    if (!pts.length) return -1;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < x) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(pts[lo - 1][0] - x) < Math.abs(pts[lo][0] - x)) lo--;
    return lo;
  }
  // Crosshair + tooltip for line charts. series: [{name, color, pts:[[x,y]], unit, fmt}]
  function addCrosshair(c, series, opts = {}) {
    const line = el('line', { class: 'xhair', y1: c.pad.t, y2: c.h - c.pad.b, style: 'display:none' });
    const dots = series.map(s => el('circle', { r: 4.5, class: 'pt', style: `fill:${s.color};display:none` }));
    const hit = el('rect', { class: 'hit', x: c.pad.l, y: c.pad.t, width: c.pw, height: c.ph });
    c.over.append(line, ...dots, hit);
    hit.addEventListener('mousemove', ev => {
      const r = c.svg.getBoundingClientRect();
      const x = c.sx.invert(((ev.clientX - r.left) * c.w) / r.width);
      const rows = []; let ax = null;
      series.forEach((s, i) => {
        const j = nearestIdx(s.pts, x);
        const p = j >= 0 ? s.pts[j] : null;
        if (!p || p[1] == null || Math.abs(p[0] - x) > (opts.maxDist || Infinity)) { dots[i].style.display = 'none'; return; }
        if (ax == null) ax = p[0];
        dots[i].style.display = '';
        dots[i].setAttribute('cx', c.sx(p[0])); dots[i].setAttribute('cy', c.sy(clamp(p[1], c.y)));
        rows.push(ttRow(s.name, (s.fmt || (v => fmtNum(v))) (p[1]) + (s.unit || ''), s.color));
      });
      if (ax == null) { line.style.display = 'none'; hideTip(); return; }
      line.style.display = ''; line.setAttribute('x1', c.sx(ax)); line.setAttribute('x2', c.sx(ax));
      showTip(ev, `<div class="tt-title">${opts.xFmt ? opts.xFmt(ax) : fmtTime(new Date(ax))}</div>${rows.join('')}${opts.extra ? opts.extra(ax) : ''}`);
    });
    hit.addEventListener('mouseleave', () => { line.style.display = 'none'; dots.forEach(d => { d.style.display = 'none'; }); hideTip(); });
  }
  function lineChart(container, o) {
    const allY = o.series.flatMap(s => s.pts.map(p => p[1]));
    const allX = o.series.flatMap(s => s.pts.map(p => p[0]));
    const x = o.x || extent(allX);
    const y = o.y || niceDomain(padDomain(extent(allY), 0.1));
    const c = baseChart(container, Object.assign({ x, y }, o));
    (o.bands || []).forEach(b => c.g.append(el('rect', { class: 'band', x: c.sx(b.x0), y: c.pad.t, width: Math.max(1, c.sx(b.x1) - c.sx(b.x0)), height: c.ph, style: b.color ? `fill:${b.color}` : null })));
    (o.hlines || []).forEach(l => { c.g.append(el('line', { class: 'threshold', x1: c.pad.l, x2: c.w - c.pad.r, y1: c.sy(l.y), y2: c.sy(l.y), style: l.color ? `stroke:${l.color}` : null })); if (l.label) c.over.append(el('text', { x: c.w - c.pad.r - 4, y: c.sy(l.y) - 4, 'text-anchor': 'end' }, l.label)); });
    (o.vlines || []).forEach(l => c.g.append(el('line', { x1: c.sx(l.x), x2: c.sx(l.x), y1: c.pad.t, y2: c.h - c.pad.b, style: `stroke:${l.color || 'var(--muted)'};stroke-width:${l.width || 1}`, 'data-tip': l.tip || null })));
    o.series.forEach(s => {
      if (s.area) c.g.append(el('path', { d: pathD(s.pts, c.sx, c.sy, y) + `L${c.sx(s.pts[s.pts.length - 1][0])} ${c.sy(y[0])}L${c.sx(s.pts[0][0])} ${c.sy(y[0])}Z`, style: `fill:${s.color};opacity:.12` }));
      c.g.append(el('path', { class: 'ln' + (s.thin ? ' thin' : ''), d: pathD(s.pts, c.sx, c.sy, y), style: `stroke:${s.color}` }));
      if (s.dots) s.pts.forEach(p => { if (p[1] != null) c.g.append(el('circle', { class: 'pt', cx: c.sx(p[0]), cy: c.sy(clamp(p[1], y)), r: s.dots === true ? 3.5 : s.dots, style: `fill:${p[2] || s.color}`, 'data-tip': p[3] || null })); });
    });
    addCrosshair(c, o.series, o.hover || {});
    return c;
  }

  // ===================================================================================
  // Rendering
  // ===================================================================================
  const POST = [];
  const defer = fn => POST.push(fn);
  function runPost() { const fns = POST.splice(0); fns.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

  function render() {
    applyTheme();
    const app = document.getElementById('app');
    app.innerHTML = `<div class="shell">${topbar()}<nav class="rail" id="rail">${rail()}</nav><main class="main" id="main"></main></div>`;
    renderMain();
    bindTop();
  }
  function renderMain(keepScroll) {
    const main = document.getElementById('main');
    if (!main) return;
    const st = keepScroll ? main.scrollTop : 0;
    main.innerHTML = ui.view === 'all' ? allView() : sessionView(S_BY_ID[ui.id]);
    runPost();
    bindMain();
    main.scrollTop = st;
  }
  function rerenderRail() { const r = document.getElementById('rail'); if (r) { r.innerHTML = rail(); bindRail(); } }

  function topbar() {
    const gen = new Date(DATA.generated_at);
    return `<header class="topbar">
      <div class="brand"><div class="mark"></div><div class="name">ASIAIR<small>Session reader</small></div></div>
      <div class="seg" id="theme-seg">${['dark', 'light', 'night'].map(t => `<button data-theme="${t}" class="${ui.theme === t ? 'on' : ''}">${t === 'night' ? 'Night vision' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="src"><b>${esc(DATA.source_dir)}</b><br>${DATA.files.autorun.length} Autorun · ${DATA.files.phd2.length} PHD2 logs · built ${fmtDate(gen)} ${fmtHM(gen)}</div>
    </header>`;
  }
  function bindTop() {
    document.getElementById('theme-seg').addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      ui.theme = b.dataset.theme; store.set('theme', ui.theme); applyTheme();
      document.querySelectorAll('#theme-seg button').forEach(x => x.classList.toggle('on', x.dataset.theme === ui.theme));
    });
    bindRail();
  }
  function bindRail() {
    const q = document.getElementById('rail-q');
    if (q) q.addEventListener('input', () => { ui.railQuery = q.value; const list = document.getElementById('rail-list'); list.innerHTML = railItems(); });
  }

  // ---------- rail ----------
  function rail() {
    const totalL = sum(DATA.sessions.map(s => s.summary.light_frames));
    const totalH = sum(DATA.sessions.map(s => s.summary.light_integration_s));
    return `<input class="search" id="rail-q" type="search" placeholder="Filter sessions by target or date…" value="${esc(ui.railQuery)}">
      <a class="rail-all ${ui.view === 'all' ? 'on' : ''}" href="#/all"><div class="ic">Σ</div><div><b>All sessions</b><span>${DATA.sessions.length} sessions · ${totalL} lights · ${fmtHours(totalH)}</span></div></a>
      <div id="rail-list">${railItems()}</div>`;
  }
  function railItems() {
    const q = ui.railQuery.trim().toLowerCase();
    const list = SESSIONS.filter(s => !q || (sessTitle(s) + ' ' + s.start + ' ' + fmtDate(new Date(s.start)) + ' ' + s.summary.plans.join(' ')).toLowerCase().includes(q));
    if (!list.length) return `<div class="empty small">No sessions match.</div>`;
    let lastMonth = '';
    return list.map(s => {
      const d = new Date(s.start), e = new Date(s.end);
      const month = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      const head = month !== lastMonth ? `<div class="rail-group">${month}</div>` : '';
      lastMonth = month;
      const sm = s.summary;
      const kind = sessKind(s);
      const integ = sm.integration || [];
      const tot = sum(integ.map(i => i.seconds));
      const bar = tot ? `<div class="ri-bar">${integ.map(i => `<i style="width:${(100 * i.seconds / tot).toFixed(1)}%;background:${filterColor(i.filter)}" title="${esc(i.filter)}"></i>`).join('')}</div>` : `<div class="ri-bar empty"></div>`;
      const warnN = s.issues.filter(i => i.level === 'warn').length, errN = s.issues.filter(i => i.level === 'error').length;
      const stats = [];
      if (sm.light_frames) stats.push(`${sm.light_frames} L`);
      if (sm.light_integration_s) stats.push(fmtHours(sm.light_integration_s));
      if (sm.guiding.rms_tot != null) stats.push(`RMS ${arcsec(sm.guiding.rms_tot)}`);
      if (sm.autofocus.runs) stats.push(`${sm.autofocus.runs} AF`);
      if (!sm.light_frames) { const t = sm.frames_by_type || {}; Object.keys(t).forEach(k => stats.push(`${t[k]} ${k}`)); }
      if (errN) stats.push(`<span class="err">${errN} ✕</span>`);
      if (warnN) stats.push(`<span class="warn">${warnN} ▲</span>`);
      return `${head}<a class="rail-item ${ui.view === 'session' && ui.id === s.id ? 'on' : ''}" href="${sessHref(s.id, ui.tab)}">
        <div class="ri-date"><span class="d">${d.getDate()}</span><span class="m">${MONTHS[d.getMonth()]}</span><span class="k">${kind === 'imaging' ? '☾' : kind === 'calibration' ? '☀' : '◌'} ${DAYS[d.getDay()].slice(0, 3)}</span></div>
        <div class="ri-body"><div class="ri-title" title="${esc(sessTitle(s))}">${esc(sessTitle(s))}</div>
          <div class="ri-meta">${fmtHM(d)} – ${fmtHM(e)} · ${fmtDur(s.duration_s)}</div>${bar}
          <div class="ri-stats">${stats.join('<span class="muted">·</span>')}</div></div></a>`;
    }).join('');
  }

  // ---------- session view ----------
  function sessionView(s) {
    if (!s) return `<div class="empty">Session not found.</div>`;
    const d = new Date(s.start), e = new Date(s.end);
    const counts = { overview: s.issues.length || null, autofocus: s.autorun.autofocus.length || null, guiding: s.guiding.sections.length || null, frames: s.autorun.frames.length || null, log: s.events.length || null, equipment: null };
    const tabs = TABS.map(([k, label]) => `<a class="tab ${ui.tab === k ? 'on' : ''}" href="${sessHref(s.id, k)}">${label}${counts[k] ? `<span class="n">${counts[k]}</span>` : ''}</a>`).join('');
    const title = s.summary.targets.length ? s.summary.targets.map(esc).join('<span class="sep">·</span>') : esc(sessTitle(s));
    const plans = s.summary.plans.map(p => `<span class="chip accent">Plan ${esc(p)}</span>`).join('');
    const body = { overview: overviewTab, autofocus: autofocusTab, guiding: guidingTab, frames: framesTab, log: logTab, equipment: equipmentTab }[ui.tab](s);
    return `<div class="sess-head fade-in"><h1>${title}</h1>
        <div class="when"><b>${DAYS[d.getDay()]}, ${fmtDate(d)}</b><br>${fmtHM(d)} → ${fmtHM(e)}${e.getDate() !== d.getDate() ? ' (+1 day)' : ''} · ${fmtDur(s.duration_s)}</div>
        <div class="plans">${plans}${s.meta.filter_carried ? `<span class="chip" data-tip="No filter change was logged in this session; the filter is carried over from the previous session.">filter carried over</span>` : ''}</div></div>
      <div class="tabs">${tabs}</div><div class="stagger" id="tab-body">${body}</div>`;
  }

  const tile = (label, value, sub, tone = '', unit = '') => `<div class="tile ${tone}"><div class="l">${label}</div><div class="v">${value}${unit ? `<small>${unit}</small>` : ''}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const chartBox = (id, height) => `<div class="chart-wrap" id="${id}" style="min-height:${height || 200}px"></div>`;
  const emptyBox = msg => `<div class="chart-empty">${msg}</div>`;

  // ===================================================================================
  // Overview tab
  // ===================================================================================
  function overviewTab(s) {
    const sm = s.summary, g = sm.guiding, af = sm.autofocus, di = sm.dithers;
    const errN = s.issues.filter(i => i.level === 'error').length, warnN = s.issues.filter(i => i.level === 'warn').length;
    const tiles = [
      tile('Light frames', sm.light_frames, Object.entries(sm.frames_by_type).filter(([k]) => k !== 'light').map(([k, v]) => `${v} ${k}`).join(' · ') || 'no calibration frames'),
      tile('Integration', fmtHours(sm.light_integration_s).replace(' h', ''), (sm.integration || []).slice(0, 3).map(i => `${esc(i.filter)} ${fmtDur(i.seconds)}`).join(' · '), 'accent', 'h'),
      tile('Guiding RMS', g.rms_tot != null ? fmtNum(g.rms_tot) : '—', g.rms_tot != null ? `RA ${arcsec(g.rms_ra)} · DEC ${arcsec(g.rms_dec)} · ${fmtDur(g.guided_s)} guided` : 'no PHD2 data', g.rms_tot == null ? '' : g.rms_tot < 1 ? 'good' : g.rms_tot < 2 ? '' : 'warn', g.rms_tot != null ? '″' : ''),
      tile('Autofocus', af.runs, af.runs ? `${af.success} ok${af.failed ? ` · ${af.failed} failed` : ''}${af.cancelled ? ` · ${af.cancelled} cancelled` : ''}${af.positions.length ? ` · EAF ${Math.min(...af.positions)}–${Math.max(...af.positions)}` : ''}` : 'no runs', af.failed ? 'warn' : ''),
      tile('Dithers', di.n, di.n ? `settle avg ${fmtNum(di.avg_settle_s, 0)}s · max ${fmtNum(di.max_settle_s, 0)}s${di.timeouts ? ` · ${di.timeouts} timeouts` : ''}${di.failed ? ` · ${di.failed} failed` : ''}` : '', di.timeouts || di.failed ? 'warn' : ''),
      tile('Star lost', g.star_lost_events + sm.star_lost_autorun, `${g.star_lost_events} PHD2 events · ${sm.star_lost_autorun} Autorun`, (g.star_lost_events + sm.star_lost_autorun) > 3 ? 'warn' : ''),
      tile('Auto-center', sm.autocenter.groups, `${plural(sm.autocenter.attempts, 'attempt')}${sm.autocenter.failed ? ` · ${sm.autocenter.failed} retried` : ''}${sm.autocenter.avg_error_arcmin != null ? ` · avg error ${fmtNum(sm.autocenter.avg_error_arcmin, 1)}′` : ''} · ${plural(sm.flips.n, 'meridian flip')}${sm.flips.n && sm.flips.ok < sm.flips.n ? ' (failed)' : ''}`, sm.flips.n && sm.flips.ok < sm.flips.n ? 'err' : ''),
      tile('Issues', s.issues.length, `${errN} errors · ${warnN} warnings`, errN ? 'err' : warnN ? 'warn' : s.issues.length ? '' : 'good'),
    ].join('');
    defer(() => timeline(document.getElementById('ov-timeline'), s));
    const integ = sm.integration || [];
    const byTarget = {};
    integ.forEach(i => { (byTarget[i.target] = byTarget[i.target] || []).push(i); });
    const maxT = Math.max(1, ...Object.values(byTarget).map(a => sum(a.map(i => i.seconds))));
    const integHtml = integ.length ? `<div class="hbars">${Object.entries(byTarget).map(([t, arr]) => {
      const tot = sum(arr.map(i => i.seconds));
      return `<div class="lab">${esc(t)}</div><div class="bar-row">${arr.map(i => `<i style="width:${(100 * i.seconds / maxT).toFixed(1)}%;--c:${filterColor(i.filter)}" data-tip="<b>${esc(t)}</b> · ${esc(i.filter)}<br>${i.frames} frames · ${fmtDur(i.seconds)}"></i>`).join('')}</div><div class="val">${fmtDur(tot)} · ${sum(arr.map(i => i.frames))} fr</div>`;
    }).join('')}</div>${filterLegend([...new Set(integ.map(i => i.filter))])}` : emptyBox('No light frames in this session.');
    const seqs = s.autorun.sequences;
    const seqHtml = seqs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Target</th><th>Type</th><th>Filter</th><th class="num">Exposure</th><th class="num">Bin</th><th class="num">Planned</th><th class="num">Taken</th><th></th></tr></thead><tbody>${seqs.map(q => {
      const run = RUN(s, q.run_id); const done = q.taken >= q.count;
      return `<tr><td class="mono">${fmtHM(new Date(q.t))}</td><td>${esc(run ? run.target : '—')}</td><td>${esc(q.type)}</td><td>${filterChip(q.filter)}</td><td class="num">${fmtExp(q.exposure_s)}</td><td class="num">${q.bin}</td><td class="num">${q.count}</td><td class="num">${q.taken}</td><td>${done ? '<span class="chip good">complete</span>' : q.taken ? `<span class="chip warn">${Math.round(100 * q.taken / q.count)}%</span>` : '<span class="chip">none</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>` : emptyBox('No capture sequences logged.');
    const runs = s.autorun.runs;
    const runsHtml = runs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Start</th><th>End</th><th>Target</th><th>Plan</th><th>Coordinates</th><th class="num">Frames</th><th>Outcome</th></tr></thead><tbody>${runs.map(r => `<tr><td class="mono">${fmtHM(new Date(r.start))}</td><td class="mono">${r.end ? fmtHM(new Date(r.end)) : '—'}</td><td>${esc(r.target)}</td><td>${esc(r.plan || '—')}</td><td class="mono small">${r.ra ? `${esc(r.ra)} ${esc(r.dec)}` : '—'}</td><td class="num">${r.frames.length}</td><td>${runOutcome(r)}</td></tr>`).join('')}</tbody></table></div>` : emptyBox('No Autorun activity in this session.');
    return `<div class="tiles">${tiles}</div>
      <div class="card"><h3>Session timeline <span class="sub">hover for details · click autofocus or guiding bars to open them</span></h3>${chartBox('ov-timeline', 170)}
        <div class="legend"><span><i style="--c:var(--af)"></i>Autofocus</span><span><i style="--c:var(--guide)"></i>Guiding</span><span><i style="--c:var(--cal-frame)"></i>Calibration frames</span><span><i style="--c:var(--serious)"></i>Star lost / failed</span><span><i style="--c:var(--warn)"></i>Settle timeout</span><span><i style="--c:var(--mass)"></i>Meridian flip</span><span><i class="ring" style="--c:var(--good)"></i>Auto-center</span>${(sm.filters || []).map(f => `<span><i style="--c:${filterColor(f)}"></i>${esc(f)} lights</span>`).join('')}</div></div>
      <div class="grid-2"><div class="card"><h3>Integration by target</h3>${integHtml}</div>
        <div class="card"><h3>Issues <span class="sub">${s.issues.length ? `${errN} errors · ${warnN} warnings` : 'nothing flagged'}</span></h3>${issuesList(s)}</div></div>
      <div class="card"><h3>Autorun runs</h3>${runsHtml}</div>
      <div class="card"><h3>Capture sequences</h3>${seqHtml}</div>`;
  }
  function runOutcome(r) {
    const m = { finished: ['good', 'finished'], paused: ['warn', r.stopped_manually ? 'stopped manually' : 'paused'], interrupted: ['warn', 'interrupted'], 'log ended': ['', 'log ended'] };
    const [tone, label] = m[r.end_reason] || ['', r.end_reason || 'unknown'];
    return `<span class="chip ${tone}">${esc(label)}</span>`;
  }
  function issuesList(s) {
    if (!s.issues.length) return `<div class="chart-empty">No problems detected: autofocus, centering, guiding and settling all completed normally.</div>`;
    return `<ul class="issues">${s.issues.map(i => {
      const ref = i.ref || {};
      const href = ref.af != null ? sessHref(s.id, 'autofocus') + `?af=${ref.af}` : ref.section != null ? sessHref(s.id, 'guiding') + `?sec=${ref.section}` : '';
      return `<li class="${href ? 'clickable' : ''}" ${href ? `data-go="${href}"` : ''}><span class="t">${fmtTime(new Date(i.t))}</span><span class="x"><span class="dot ${i.level === 'error' ? 'crit' : i.level}"></span><span>${esc(i.text)}</span></span></li>`;
    }).join('')}</ul>`;
  }

  // Timeline ------------------------------------------------------------------------
  function timeline(container, s) {
    if (!container) return;
    const t0 = T(s.start), t1 = T(s.end);
    const lanes = [['imaging', 'Imaging'], ['af', 'Autofocus'], ['guide', 'Guiding'], ['dither', 'Dither'], ['mount', 'Mount']];
    const laneH = 26, labW = 84;
    const h = lanes.length * laneH + 34;
    const c = baseChart(container, { x: [t0, t1], y: [0, 1], xTime: true, height: h, pad: { t: 6, r: 12, b: 26, l: labW }, yTicks: [], noYGrid: true });
    const laneY = i => c.pad.t + i * laneH;
    lanes.forEach(([k, label], i) => {
      c.over.append(el('rect', { class: 'tl-row' + (i % 2 ? ' alt' : ''), x: c.pad.l, y: laneY(i), width: c.pw, height: laneH }));
      c.over.append(el('text', { class: 'tl-lab', x: c.pad.l - 10, y: laneY(i) + laneH / 2 + 4, 'text-anchor': 'end' }, label));
    });
    const g = el('g'); c.over.append(g);
    const X = t => c.sx(T(t));
    const rect = (lane, a, b, color, tip, extra = {}) => {
      const x = X(a), w = Math.max(1.5, X(b) - x);
      const r = el('rect', Object.assign({ class: 'bar', x, y: laneY(lane) + 5, width: w, height: laneH - 10, style: `fill:${color}`, 'data-tip': tip }, extra));
      g.append(r); return r;
    };
    const tick = (lane, a, color, tip, tall) => g.append(el('rect', { x: X(a) - 1, y: laneY(lane) + (tall ? 3 : 7), width: 2, height: laneH - (tall ? 6 : 14), style: `fill:${color}`, 'data-tip': tip }));
    // imaging
    FRAME(s).forEach(f => {
      const light = f.type === 'light';
      const gd = f.guide;
      const tip = `<div class="tt-title">${esc(f.type)} #${f.image} · ${esc(f.target || '')}</div>${ttRow('Time', fmtTime(new Date(f.t)))}${ttRow('Filter', esc(f.filter || '—'))}${ttRow('Exposure', fmtExp(f.exposure_s) + ` · bin${f.bin}`)}${gd && gd.rms_tot != null ? ttRow('Guide RMS', arcsec(gd.rms_tot)) : ''}${f.settle_s != null ? ttRow('Settle before', `${fmtNum(f.settle_s, 0)}s ${f.settle_result}`) : ''}${f.star_lost ? ttRow('Star lost', f.star_lost) : ''}`;
      rect(0, f.t, f.end, light ? filterColor(f.filter) : 'var(--cal-frame)', tip, light ? {} : { opacity: 0.7 });
    });
    // autofocus
    s.autorun.autofocus.forEach(a => {
      const tip = `<div class="tt-title">Autofocus #${a.id + 1} · ${esc(a.trigger)}</div>${ttRow('Time', fmtTime(new Date(a.start)) + (a.duration_s ? ` · ${fmtDur(a.duration_s)}` : ''))}${ttRow('Result', esc(a.result))}${a.final_pos != null ? ttRow('Position', `${a.start_pos} → ${a.final_pos}`) : ''}${a.temperature != null ? ttRow('Temperature', `${a.temperature} °C`) : ''}${a.filter ? ttRow('Filter', esc(a.filter)) : ''}`;
      const r = rect(1, a.start, a.end || a.start, a.result === 'success' ? 'var(--af)' : 'var(--serious)', tip, { class: 'bar clickable' });
      r.addEventListener('click', () => nav(sessHref(s.id, 'autofocus') + `?af=${a.id}`));
    });
    // guiding
    s.guiding.sections.forEach((sec, i) => {
      const st = sec.stats, gs = st.guided || {};
      const tip = `<div class="tt-title">Guiding section ${i + 1}</div>${ttRow('Time', `${fmtTime(new Date(sec.start))} · ${fmtDur(sec.duration_s)}`)}${gs.rms_tot != null ? ttRow('RMS', `RA ${arcsec(gs.rms_ra)} · DEC ${arcsec(gs.rms_dec)} · ${arcsec(gs.rms_tot)}`) : ''}${ttRow('Frames', `${st.mount_frames} (${st.dropped} dropped)`)}${st.star_lost_events ? ttRow('Star lost', st.star_lost_events) : ''}${st.runaway_frames ? ttRow('Far from lock (excluded)', st.runaway_frames) : ''}`;
      const r = rect(2, sec.start, sec.end, 'var(--guide)', tip, { class: 'bar clickable', opacity: 0.7 });
      r.addEventListener('click', () => nav(sessHref(s.id, 'guiding') + `?sec=${i}`));
    });
    s.events.forEach(e => {
      if (e.kind === 'phd2_star_lost') tick(2, e.t, 'var(--serious)', `<b>${fmtTime(new Date(e.t))}</b> ${esc(e.text)}`, true);
      else if (e.kind === 'phd2_settle_failed') tick(2, e.t, 'var(--crit)', `<b>${fmtTime(new Date(e.t))}</b> settling failed`, true);
      else if (e.kind === 'select_star_failed') tick(2, e.t, 'var(--crit)', `<b>${fmtTime(new Date(e.t))}</b> ${esc(e.text)}`, true);
    });
    // dither
    s.autorun.settles.forEach(d => {
      const col = d.result === 'timeout' ? 'var(--warn)' : d.result === 'failed' ? 'var(--crit)' : d.kind === 'dither' ? 'var(--muted)' : 'var(--faint)';
      tick(3, d.start, col, `<b>${fmtTime(new Date(d.start))}</b> ${d.kind === 'dither' ? 'Dither' : 'Guide settle'} · ${d.duration_s != null ? `${fmtNum(d.duration_s, 0)}s` : ''} ${esc(d.result || 'no result')}${d.star_lost ? ` · star lost ×${d.star_lost}` : ''}`, d.result !== 'done');
    });
    // mount
    s.autorun.flips.forEach(f => {
      rect(4, f.start, f.flip_start || f.end || f.start, 'var(--mass)', `<div class="tt-title">Meridian flip</div>${ttRow('Wait', f.wait_s != null ? fmtDur(f.wait_s) : '—')}${ttRow('Flip at', f.flip_start ? fmtTime(new Date(f.flip_start)) : '—')}${ttRow('Result', f.ok ? 'succeeded' : f.ok === false ? 'failed' : 'unknown')}${ttRow('Centering attempts', f.attempts)}`, { opacity: 0.35 });
      if (f.flip_start) rect(4, f.flip_start, f.end || f.flip_start, 'var(--mass)', `<div class="tt-title">Meridian flip executing</div>${ttRow('Duration', f.end ? fmtDur((T(f.end) - T(f.flip_start)) / 1000) : '—')}`);
    });
    s.autorun.autocenter.forEach(a => {
      const x = X(a.start), y = laneY(4) + laneH / 2;
      g.append(el('circle', { cx: x, cy: y, r: 5, style: `fill:var(--surface);stroke:${a.ok ? 'var(--good)' : a.ok === false ? 'var(--warn)' : 'var(--muted)'};stroke-width:2`, 'data-tip': `<div class="tt-title">Auto-center attempt ${a.attempt}${a.context === 'flip' ? ' (after flip)' : ''}</div>${ttRow('Time', fmtTime(new Date(a.start)))}${ttRow('Result', esc(a.result || '—'))}${a.error_arcmin != null ? ttRow('Pointing error', `${fmtNum(a.error_arcmin, 1)}′`) : ''}${a.stars != null ? ttRow('Stars solved', a.stars) : ''}` }));
    });
  }

  // ===================================================================================
  // Autofocus tab
  // ===================================================================================
  function autofocusTab(s) {
    const afs = s.autorun.autofocus;
    if (!afs.length) return `<div class="card"><div class="chart-empty">No autofocus runs were logged in this session.</div></div>`;
    const ok = afs.filter(a => a.result === 'success');
    const pos = ok.map(a => a.final_pos).filter(p => p != null);
    const temps = afs.map(a => a.temperature).filter(t => t != null);
    const sizes = ok.map(a => a.final_size).filter(v => v != null);
    const tiles = [
      tile('Runs', afs.length, `${ok.length} succeeded${afs.length - ok.length ? ` · ${afs.length - ok.length} failed/cancelled` : ''}`, afs.length - ok.length ? 'warn' : 'good'),
      tile('Focus position', pos.length ? `${Math.min(...pos)}–${Math.max(...pos)}` : '—', pos.length > 1 ? `drift ${pos[pos.length - 1] - pos[0] >= 0 ? '+' : ''}${pos[pos.length - 1] - pos[0]} steps over the session` : ''),
      tile('Temperature', temps.length ? `${Math.min(...temps)}–${Math.max(...temps)}` : '—', temps.length ? (temps.length > 1 && Math.max(...temps) - Math.min(...temps) > 0 && pos.length > 1 ? tempSlopeText(ok) : 'as reported by the EAF') : '', '', temps.length ? '°C' : ''),
      tile('Best star size', sizes.length ? fmtNum(Math.min(...sizes), 1) : '—', 'smallest final HFD-like star size', '', sizes.length ? 'px' : ''),
      tile('Avg duration', fmtDur(s.summary.autofocus.avg_duration_s), `${sum(afs.map(a => a.duration_s))  ? fmtDur(sum(afs.map(a => a.duration_s))) + ' total time not imaging' : ''}`),
    ].join('');
    const triggers = {};
    afs.forEach(a => { triggers[a.trigger] = (triggers[a.trigger] || 0) + 1; });
    const trigHtml = Object.entries(triggers).map(([k, v]) => `<span class="chip">${esc(TRIG[k] || k)} <b>${v}</b></span>`).join(' ');
    defer(() => focusTrend(document.getElementById('af-trend'), s));
    const table = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Time</th><th>Trigger</th><th>Filter</th><th class="num">Temp</th><th class="num">Start</th><th class="num">Final</th><th class="num">Δ</th><th class="num">Min size</th><th class="num">V-fit</th><th class="num">Duration</th><th>Result</th></tr></thead><tbody>${afs.map(a => `<tr class="row-click" data-go="${sessHref(s.id, 'autofocus')}?af=${a.id}"><td class="mono">${a.id + 1}</td><td class="mono">${fmtTime(new Date(a.start))}</td><td>${esc(TRIG[a.trigger] || a.trigger)}</td><td>${a.filter ? filterChip(a.filter) : '—'}</td><td class="num">${a.temperature != null ? a.temperature + ' °C' : '—'}</td><td class="num">${a.start_pos ?? '—'}</td><td class="num">${a.final_pos ?? '—'}</td><td class="num">${a.delta != null ? (a.delta > 0 ? '+' : '') + a.delta : '—'}</td><td class="num">${a.final_size != null ? fmtNum(a.final_size, 1) : '—'}</td><td class="num">${a.fit && a.fit.best_pos != null ? Math.round(a.fit.best_pos) : '—'}</td><td class="num">${fmtDur(a.duration_s)}</td><td>${resultChip(a.result)}</td></tr>`).join('')}</tbody></table></div>`;
    const cards = afs.map(a => afCard(s, a)).join('');
    afs.forEach(a => defer(() => vcurveChart(document.getElementById(`vc-${a.id}`), a)));
    return `<div class="tiles">${tiles}</div>
      <div class="card"><h3>Focus position &amp; temperature through the session <span class="sub">successful runs; hover for details</span><span class="spacer"></span>${trigHtml}</h3>${chartBox('af-trend', 230)}</div>
      <div class="card"><h3>All runs</h3>${table}</div>
      <div class="af-grid" id="af-cards">${cards}</div>`;
  }
  const TRIG = { start: 'Before autorun', periodic: 'Timer', filter: 'Filter change', flip: 'After flip', temperature: 'Temperature', manual: 'Manual', other: 'Other' };
  const resultChip = r => `<span class="chip ${r === 'success' ? 'good' : r === 'cancelled' ? 'warn' : r === 'failed' ? 'err' : ''}">${esc(r)}</span>`;
  function tempSlopeText(ok) {
    const pts = ok.filter(a => a.temperature != null && a.final_pos != null).map(a => [a.temperature, a.final_pos]);
    const f = linfit(pts);
    return f ? `≈ ${fmtNum(f.slope, 1)} steps/°C (${pts.length} runs)` : '';
  }
  function linfit(pts) {
    const n = pts.length; if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(([x, y]) => { sx += x; sy += y; sxx += x * x; sxy += x * y; });
    const den = n * sxx - sx * sx; if (Math.abs(den) < 1e-9) return null;
    const slope = (n * sxy - sx * sy) / den, intercept = (sy - slope * sx) / n;
    const ybar = sy / n; let tot = 0, res = 0;
    pts.forEach(([x, y]) => { tot += (y - ybar) ** 2; res += (y - slope * x - intercept) ** 2; });
    return { slope, intercept, r2: tot ? 1 - res / tot : 1, n };
  }
  function afCard(s, a) {
    const fit = a.fit || {};
    const run = RUN(s, a.run_id);
    const stats = [
      ['Position', a.start_pos != null ? `${a.start_pos} → <b>${a.final_pos ?? '?'}</b>` : '—'],
      ['Δ steps', a.delta != null ? (a.delta > 0 ? '+' : '') + a.delta : '—'],
      ['Final size', a.final_size != null ? fmtNum(a.final_size, 1) + ' px' : '—'],
      ['Min sample', fit.min_size != null ? `${fmtNum(fit.min_size, 1)} px @ ${fit.min_pos}` : '—'],
      ['V-fit best', fit.best_pos != null ? `${Math.round(fit.best_pos)}${a.final_pos != null ? ` (${Math.round(fit.best_pos - a.final_pos) >= 0 ? '+' : ''}${Math.round(fit.best_pos - a.final_pos)})` : ''}` : '—'],
      ['Slopes', fit.left_slope != null ? `${fmtNum(Math.abs(fit.left_slope), 3)} / ${fmtNum(Math.abs(fit.right_slope), 3)}` : '—'],
      ['Fit R²', fit.left_r2 != null ? `${fmtNum(fit.left_r2, 2)} / ${fmtNum(fit.right_r2, 2)}` : '—'],
      ['Samples', `${a.vcurve.length} V + ${a.focus_points.length} approach`],
    ];
    return `<div class="card" id="af-card-${a.id}"><div class="af-head"><span class="n">#${a.id + 1}</span><span class="t">${fmtTime(new Date(a.start))} · ${fmtDur(a.duration_s)}</span>${resultChip(a.result)}<span class="chip">${esc(TRIG[a.trigger] || a.trigger)}</span>${a.filter ? filterChip(a.filter) : ''}${a.temperature != null ? `<span class="chip mono">${a.temperature} °C</span>` : ''}${run ? `<span class="chip">${esc(run.target)}</span>` : ''}</div>
      <div class="note">${esc(a.reason)} · exposure ${fmtExp(a.exposure_s)} bin${a.bin ?? '?'}</div>
      ${chartBox(`vc-${a.id}`, 210)}
      <div class="legend"><span><i style="--c:var(--cat-1)"></i>V-curve samples</span><span><i style="--c:var(--cat-2)"></i>Focus-point approach</span><span><i class="line" style="--c:var(--af)"></i>Chosen position</span><span><i class="line" style="--c:var(--muted)"></i>V fit</span></div>
      <div class="af-stats">${stats.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('')}</div></div>`;
  }
  function vcurveChart(container, a) {
    if (!container) return;
    const pts = a.vcurve.map(p => [p.pos, p.size, p.t]);
    const fps = a.focus_points.map(p => [p.pos, p.size, p.t]);
    const all = pts.concat(fps);
    if (!all.length) { container.innerHTML = emptyBox('No V-curve samples recorded' + (a.result === 'cancelled' ? ' (cancelled)' : '') + '.'); return; }
    const xs = all.map(p => p[0]).concat(a.final_pos != null ? [a.final_pos] : []);
    const x = padDomain(extent(xs), 0.08);
    const y = [0, Math.max(1, ...all.map(p => p[1])) * 1.12];
    const c = baseChart(container, { x, y, height: 210, yLabel: 'star size (px)', xLabel: 'EAF position', xFmt: v => String(Math.round(v)) });
    const fit = a.fit;
    if (fit && fit.left_line && fit.right_line) {
      const [la, lb] = fit.left_line, [ra, rb] = fit.right_line;
      const seg = (m, b, x0, x1) => el('line', { class: 'fitln', x1: c.sx(x0), y1: c.sy(m * x0 + b), x2: c.sx(x1), y2: c.sy(m * x1 + b), style: 'stroke:var(--muted)' });
      c.g.append(seg(la, lb, x[0], fit.best_pos), seg(ra, rb, fit.best_pos, x[1]));
      c.over.append(el('circle', { cx: c.sx(fit.best_pos), cy: c.sy(Math.max(0, fit.best_size)), r: 4, style: 'fill:none;stroke:var(--muted);stroke-width:1.5', 'data-tip': `<b>V-fit intersection</b><br>${Math.round(fit.best_pos)} · ${fmtNum(fit.best_size, 1)} px` }));
    }
    if (a.final_pos != null) {
      c.g.append(el('line', { x1: c.sx(a.final_pos), x2: c.sx(a.final_pos), y1: c.pad.t, y2: c.h - c.pad.b, style: 'stroke:var(--af);stroke-width:2', 'data-tip': `<b>Chosen position ${a.final_pos}</b>` }));
      c.over.append(el('text', { x: c.sx(a.final_pos) + 5, y: c.pad.t + 11, style: 'fill:var(--af)' }, String(a.final_pos)));
    }
    const sorted = pts.slice().sort((p, q) => p[0] - q[0]);
    c.g.append(el('path', { class: 'ln thin', d: pathD(sorted, c.sx, c.sy), style: 'stroke:var(--cat-1);opacity:.6' }));
    const fsorted = fps.slice().sort((p, q) => p[0] - q[0]);
    if (fsorted.length > 1) c.g.append(el('path', { class: 'ln thin', d: pathD(fsorted, c.sx, c.sy), style: 'stroke:var(--cat-2);opacity:.6' }));
    pts.forEach((p, i) => c.over.append(el('circle', { class: 'pt', cx: c.sx(p[0]), cy: c.sy(p[1]), r: 4.5, style: 'fill:var(--cat-1)', 'data-tip': `<b>V-curve sample ${i + 1}</b><br>EAF ${p[0]} · star size ${fmtNum(p[1], 1)} px<br><span class="muted">${fmtTime(new Date(p[2]))}</span>` })));
    fps.forEach((p, i) => c.over.append(el('rect', { class: 'pt', x: c.sx(p[0]) - 4, y: c.sy(p[1]) - 4, width: 8, height: 8, style: 'fill:var(--cat-2)', 'data-tip': `<b>Approach step ${i + 1}</b><br>EAF ${p[0]} · star size ${fmtNum(p[1], 1)} px<br><span class="muted">${fmtTime(new Date(p[2]))}</span>` })));
  }
  function focusTrend(container, s) {
    if (!container) return;
    const ok = s.autorun.autofocus.filter(a => a.result === 'success' && a.final_pos != null);
    if (ok.length < 1) { container.innerHTML = emptyBox('No successful runs to plot.'); return; }
    const pts = ok.map(a => [T(a.start), a.final_pos, filterColor(a.filter), `<b>Autofocus #${a.id + 1}</b> · ${fmtTime(new Date(a.start))}<br>EAF ${a.final_pos} · ${a.temperature != null ? a.temperature + ' °C · ' : ''}${esc(a.filter || '')}`]);
    const tpts = ok.filter(a => a.temperature != null).map(a => [T(a.start), a.temperature]);
    const x = [T(s.start), T(s.end)];
    container.innerHTML = `<div id="af-trend-pos"></div><div id="af-trend-temp" style="margin-top:4px"></div>`;
    const ypos = niceDomain(padDomain(extent(pts.map(p => p[1])), 0.25), 4);
    lineChart(container.querySelector('#af-trend-pos'), { x, y: ypos, xTime: true, height: 150, yLabel: 'EAF position', series: [{ name: 'Focus position', color: 'var(--af)', pts, dots: 4.5, unit: '', fmt: v => String(Math.round(v)) }], pad: { b: 22 } });
    if (tpts.length) lineChart(container.querySelector('#af-trend-temp'), { x, y: niceDomain(padDomain(extent(tpts.map(p => p[1])), 0.4), 3), xTime: true, height: 110, yLabel: 'temperature (°C)', series: [{ name: 'Temperature', color: 'var(--cat-2)', pts: tpts, dots: 3.5, unit: ' °C', fmt: v => fmtNum(v, 1) }] });
  }

  // ===================================================================================
  // Guiding tab
  // ===================================================================================
  function guidingTab(s) {
    const secs = s.guiding.sections, cals = s.guiding.calibrations, g = s.summary.guiding;
    if (!secs.length && !cals.length) return `<div class="card"><div class="chart-empty">No PHD2 guide log covers this session.</div></div>`;
    const ps = perSession(s.id);
    const qp = new URLSearchParams((location.hash.split('?')[1] || ''));
    if (qp.has('sec') && secs[+qp.get('sec')]) ps.section = +qp.get('sec');
    if (ps.section == null || !secs[ps.section]) ps.section = secs.length ? secs.reduce((best, x, i) => (x.duration_s > secs[best].duration_s ? i : best), 0) : null;
    const tiles = [
      tile('Total RMS', g.rms_tot != null ? fmtNum(g.rms_tot) : '—', g.pixel_scale ? `${fmtNum(g.rms_tot / g.pixel_scale, 2)} px @ ${g.pixel_scale}″/px · excl. settling` : '', g.rms_tot == null ? '' : g.rms_tot < 1 ? 'good' : g.rms_tot < 2 ? '' : 'warn', '″'),
      tile('RA RMS', g.rms_ra != null ? fmtNum(g.rms_ra) : '—', g.peak_ra != null ? `peak ${arcsec(g.peak_ra)}` : '', '', '″'),
      tile('DEC RMS', g.rms_dec != null ? fmtNum(g.rms_dec) : '—', g.peak_dec != null ? `peak ${arcsec(g.peak_dec)}` : '', '', '″'),
      tile('Guided time', fmtDur(g.guided_s), `${secs.length} sections · ${g.guided_frames} frames`),
      tile('Dropped frames', g.dropped, `${plural(g.star_lost_events, 'star-lost event')}`, g.star_lost_events > 3 ? 'warn' : ''),
      tile('Calibrations', cals.length, cals.length ? `${cals.filter(c => c.complete).length} complete${g.calibrations_incomplete ? ` · ${g.calibrations_incomplete} aborted` : ''}` : 'none in this session', g.calibrations_incomplete ? 'warn' : ''),
    ].join('');
    const calHtml = cals.map((c, i) => calCard(c, i)).join('');
    cals.forEach((c, i) => defer(() => calChart(document.getElementById(`cal-${i}`), c)));
    defer(() => sectionBars(document.getElementById('sec-bars'), s));
    const secTable = secs.length ? `<div class="tbl-wrap"><table class="tbl" id="sec-table"><thead><tr><th>#</th><th>Start</th><th class="num">Duration</th><th class="num">Frames</th><th class="num">RA RMS</th><th class="num">DEC RMS</th><th class="num">Total</th><th class="num">Peak RA/DEC</th><th class="num">SNR</th><th class="num">Dropped</th><th class="num">Lost</th><th class="num">Dithers</th><th>Target</th><th></th></tr></thead><tbody>${secs.map((sec, i) => {
      const st = sec.stats, gs = st.guided || {};
      const target = secTarget(s, sec);
      const flags = [];
      if (st.runaway_frames) flags.push(`<span class="chip warn" data-tip="${st.runaway_frames} frames more than ${st.runaway_arcsec}″ from the lock position (excluded from RMS)">star drifted</span>`);
      if (st.settle_failed) flags.push(`<span class="chip err">settle failed</span>`);
      if (!sec.ended_cleanly) flags.push(`<span class="chip">no end record</span>`);
      return `<tr class="row-click ${ps.section === i ? 'on' : ''}" data-sec="${i}"><td class="mono">${i + 1}</td><td class="mono">${fmtTime(new Date(sec.start))}</td><td class="num">${fmtDur(sec.duration_s)}</td><td class="num">${st.mount_frames}</td><td class="num">${arcsec(gs.rms_ra)}</td><td class="num">${arcsec(gs.rms_dec)}</td><td class="num"><b>${arcsec(gs.rms_tot)}</b></td><td class="num">${fmtNum(gs.peak_ra, 1)} / ${fmtNum(gs.peak_dec, 1)}</td><td class="num">${fmtNum(st.snr_mean, 1)}</td><td class="num">${st.dropped}</td><td class="num">${st.star_lost_events}</td><td class="num">${st.dithers}</td><td>${esc(target || '—')}</td><td>${flags.join(' ')}</td></tr>`;
    }).join('')}</tbody></table></div>` : '';
    const detail = ps.section != null ? sectionDetail(s, ps.section) : '';
    return `<div class="tiles">${tiles}</div>
      ${cals.length ? `<div class="grid-2">${calHtml}</div>` : ''}
      <div class="card"><h3>Guiding sections <span class="sub">RMS per section (excluding settling and dropped frames) · click to inspect</span></h3>${chartBox('sec-bars', 150)}<div class="legend"><span><i style="--c:var(--ra)"></i>RA RMS</span><span><i style="--c:var(--dec)"></i>DEC RMS</span></div>${secTable}</div>
      <div id="sec-detail">${detail}</div>`;
  }
  function secTarget(s, sec) {
    const t0 = T(sec.start), t1 = T(sec.end);
    const f = FRAME(s).find(f => T(f.t) < t1 && T(f.end) > t0 && f.type === 'light');
    if (f) return f.target;
    const r = s.autorun.runs.find(r => T(r.start) <= t1 && (r.end ? T(r.end) : Infinity) >= t0);
    return r ? r.target : null;
  }
  function calCard(c, i) {
    const w = c.results.West || c.results.East, n = c.results.North || c.results.South;
    const st = c.settings;
    const orth = c.orthogonality_error;
    return `<div class="card"><h3>Calibration ${i + 1} <span class="sub">${fmtTime(new Date(c.start))}</span><span class="spacer"></span>${c.complete ? '<span class="chip good">complete</span>' : '<span class="chip warn">not completed</span>'}</h3>
      ${chartBox(`cal-${i}`, 200)}
      <div class="legend"><span><i style="--c:var(--ra)"></i>West (RA)</span><span><i class="ring" style="--c:var(--ra)"></i>East (return)</span><span><i style="--c:var(--dec)"></i>North (DEC)</span><span><i class="ring" style="--c:var(--dec)"></i>South (return)</span><span><i style="--c:var(--muted)"></i>Backlash clearing</span></div>
      <dl class="kv"><dt>RA axis</dt><dd>${w ? `angle ${w.angle}° · rate ${w.rate} px/s (${st.pixel_scale ? fmtNum(w.rate * st.pixel_scale, 2) + '″/s' : ''})` : '—'}</dd>
        <dt>DEC axis</dt><dd>${n ? `angle ${n.angle}° · rate ${n.rate} px/s (${st.pixel_scale ? fmtNum(n.rate * st.pixel_scale, 2) + '″/s' : ''})` : '—'}</dd>
        <dt>Orthogonality</dt><dd>${orth != null ? `${fmtNum(orth, 1)}° off ${orth > 10 ? '<span class="chip warn">check</span>' : orth > 5 ? '<span class="chip">acceptable</span>' : '<span class="chip good">good</span>'}` : '—'}</dd>
        <dt>Steps</dt><dd>${Object.entries(c.step_counts).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'} · step ${st.cal_step_ms ?? '?'} ms</dd>
        <dt>Position</dt><dd>${st.dec != null ? `DEC ${st.dec}° · HA ${st.hour_angle} h · pier ${st.pier_side}` : '—'}</dd>
        <dt>Star</dt><dd>${st.hfd != null ? `HFD ${st.hfd} px at ${fmtNum(st.star_x, 0)}, ${fmtNum(st.star_y, 0)}` : '—'}</dd></dl></div>`;
  }
  function calChart(container, c) {
    if (!container) return;
    const dirs = ['West', 'East', 'Backlash', 'North', 'South'];
    const all = dirs.flatMap(d => (c.steps[d] || []).map(s => [s[1], s[2]]));
    if (!all.length) { container.innerHTML = emptyBox('No calibration steps recorded.'); return; }
    const m = Math.max(1, ...all.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1])))) * 1.1;
    const w = Math.max(280, container.clientWidth || 400), h = 200;
    const ch = baseChart(container, { x: [-m * (w - 68) / (h - 44), m * (w - 68) / (h - 44)], y: [-m, m], height: h, pad: { l: 52, r: 16, t: 14, b: 30 }, xLabel: 'dx (px)', yLabel: 'dy (px)' });
    ch.g.append(el('line', { class: 'zero', x1: ch.sx(0), x2: ch.sx(0), y1: ch.pad.t, y2: ch.h - ch.pad.b }));
    const style = { West: ['var(--ra)', true], East: ['var(--ra)', false], North: ['var(--dec)', true], South: ['var(--dec)', false], Backlash: ['var(--muted)', true] };
    dirs.forEach(d => {
      const steps = c.steps[d] || []; if (!steps.length) return;
      const [color, filled] = style[d];
      ch.g.append(el('path', { class: 'ln thin', d: pathD(steps.map(s => [s[1], s[2]]), ch.sx, ch.sy), style: `stroke:${color};opacity:${filled ? 0.9 : 0.5}` }));
      steps.forEach(s => ch.over.append(el('circle', { cx: ch.sx(s[1]), cy: ch.sy(s[2]), r: 3, style: filled ? `fill:${color}` : `fill:var(--surface);stroke:${color};stroke-width:1.5`, 'data-tip': `<b>${d} step ${s[0]}</b><br>dx ${fmtNum(s[1], 2)} · dy ${fmtNum(s[2], 2)} · dist ${fmtNum(s[5], 2)} px` })));
    });
  }
  function sectionBars(container, s) {
    if (!container) return;
    const secs = s.guiding.sections;
    if (!secs.length) { container.innerHTML = emptyBox('No guiding sections.'); return; }
    const ps = perSession(s.id);
    const x = [T(s.start), T(s.end)];
    const ymax = Math.max(0.5, ...secs.map(sec => Math.max((sec.stats.guided || {}).rms_ra || 0, (sec.stats.guided || {}).rms_dec || 0)));
    const c = baseChart(container, { x, y: [0, niceDomain([0, ymax * 1.15], 3)[1]], xTime: true, height: 150, yLabel: 'RMS (″)' });
    secs.forEach((sec, i) => {
      const gs = sec.stats.guided || {};
      const x0 = c.sx(T(sec.start)), x1 = Math.max(x0 + 3, c.sx(T(sec.end)));
      const w = x1 - x0, half = Math.max(1, (w - 2) / 2);
      const tip = `<div class="tt-title">Section ${i + 1}</div>${ttRow('RA RMS', arcsec(gs.rms_ra), 'var(--ra)')}${ttRow('DEC RMS', arcsec(gs.rms_dec), 'var(--dec)')}${ttRow('Total', arcsec(gs.rms_tot))}${ttRow('Duration', fmtDur(sec.duration_s))}`;
      const grp = el('g', { class: 'clickable', 'data-tip': tip });
      if (ps.section === i) grp.append(el('rect', { x: x0 - 2, y: c.pad.t, width: w + 4, height: c.ph, style: 'fill:var(--accent);opacity:.12' }));
      if (gs.rms_ra != null) grp.append(el('rect', { class: 'bar', x: x0, y: c.sy(gs.rms_ra), width: half, height: c.sy(0) - c.sy(gs.rms_ra), style: 'fill:var(--ra)' }));
      if (gs.rms_dec != null) grp.append(el('rect', { class: 'bar', x: x0 + half + 2, y: c.sy(gs.rms_dec), width: half, height: c.sy(0) - c.sy(gs.rms_dec), style: 'fill:var(--dec)' }));
      grp.addEventListener('click', () => selectSection(s, i));
      c.g.append(grp);
    });
  }
  function selectSection(s, i) {
    perSession(s.id).section = i;
    const main = document.getElementById('main'); const st = main.scrollTop;
    document.getElementById('sec-detail').innerHTML = sectionDetail(s, i);
    document.querySelectorAll('#sec-table tr[data-sec]').forEach(tr => tr.classList.toggle('on', +tr.dataset.sec === i));
    sectionBars(document.getElementById('sec-bars'), s);
    runPost(); bindMain(); main.scrollTop = st;
  }
  function sectionDetail(s, i) {
    const sec = s.guiding.sections[i], st = sec.stats, gs = st.guided || {}, ga = st.all || {};
    const cols = sec.frame_cols; const C = {}; cols.forEach((k, j) => { C[k] = j; });
    const corr = st.corrections || {};
    const raPct = corr.ra_e_ms + corr.ra_w_ms ? Math.round(100 * corr.ra_e_ms / (corr.ra_e_ms + corr.ra_w_ms)) : null;
    const decPct = corr.dec_n_ms + corr.dec_s_ms ? Math.round(100 * corr.dec_n_ms / (corr.dec_n_ms + corr.dec_s_ms)) : null;
    const set = sec.settings;
    const lights = FRAME(s).filter(f => f.type === 'light' && f.guide && f.guide.sections.includes(i));
    ['err', 'corr', 'snr', 'scatter', 'hist'].forEach(k => defer(() => sectionCharts(s, i, k)));
    return `<div class="card fade-in"><h3>Section ${i + 1} · ${fmtTime(new Date(sec.start))} → ${fmtTime(new Date(sec.end))} <span class="sub">${fmtDur(sec.duration_s)} · ${st.mount_frames} frames · ${esc(secTarget(s, sec) || '')}</span><span class="spacer"></span>
        <span class="chip mono">RA ${arcsec(gs.rms_ra)}</span><span class="chip mono">DEC ${arcsec(gs.rms_dec)}</span><span class="chip mono accent">Total ${arcsec(gs.rms_tot)}</span></h3>
      <div class="note">Excluding settling: RA ${arcsec(gs.rms_ra)} · DEC ${arcsec(gs.rms_dec)} · total ${arcsec(gs.rms_tot)} (${gs.n} frames). Including settling: total ${arcsec(ga.rms_tot)}. Peak RA ${arcsec(gs.peak_ra)}, DEC ${arcsec(gs.peak_dec)}.
        ${st.runaway_frames ? `<span class="chip warn">${st.runaway_frames} frames more than ${st.runaway_arcsec}″ from the lock position excluded</span>` : ''}
        ${st.dropped ? ` · ${st.dropped} dropped frames (${Object.entries(st.drop_reasons || {}).map(([k, v]) => `${esc(k)} ×${v}`).join(', ')})` : ''}
        ${raPct != null ? ` · RA pulses ${raPct}% East / ${100 - raPct}% West` : ''}${decPct != null ? ` · DEC pulses ${decPct}% North / ${100 - decPct}% South` : ''}
        ${lights.length ? ` · covers light frames ${lights.map(f => '#' + f.image).join(', ')}` : ''}</div>
      ${chartBox(`sec-err`, 230)}
      <div class="legend"><span><i class="line" style="--c:var(--ra)"></i>RA error</span><span><i class="line" style="--c:var(--dec)"></i>DEC error</span><span><i class="hatch" style="--c:var(--muted)"></i>Settling</span><span><i style="--c:var(--muted)"></i>Dither</span><span><i style="--c:var(--serious)"></i>Star lost</span></div>
      <div class="grid-2" style="margin-top:12px"><div><h3 class="small muted" style="letter-spacing:.12em;text-transform:uppercase;font-size:11px">Guide pulses (ms) · RA East+/West− · DEC North+/South−</h3>${chartBox('sec-corr', 150)}</div><div><h3 class="small muted" style="letter-spacing:.12em;text-transform:uppercase;font-size:11px">Star SNR &amp; mass</h3>${chartBox('sec-snr', 150)}</div></div>
      <div class="grid-2" style="margin-top:12px"><div><h3 class="small muted" style="letter-spacing:.12em;text-transform:uppercase;font-size:11px">RA vs DEC scatter · circle = total RMS</h3>${chartBox('sec-scatter', 240)}</div><div><h3 class="small muted" style="letter-spacing:.12em;text-transform:uppercase;font-size:11px">Error distribution</h3>${chartBox('sec-hist', 240)}<div class="legend"><span><i style="--c:var(--ra)"></i>RA</span><span><i style="--c:var(--dec)"></i>DEC</span></div></div></div>
      <details class="sec-settings"><summary>Guiding settings for this section</summary><dl class="kv">${settingsRows(set)}</dl></details></div>`;
  }
  function sectionCharts(s, i, which) {
    const sec = s.guiding.sections[i];
    const container = document.getElementById(`sec-${which}`); if (!container) return;
    const C = {}; sec.frame_cols.forEach((k, j) => { C[k] = j; });
    const base = T(sec.start), scale = sec.stats.pixel_scale || 1;
    const F = sec.frames;
    const t = f => base + f[C.t] * 1000;
    const isGood = f => !f[C.drop] && !f[C.runaway];
    const gs = sec.stats.guided || {};
    const rmsTot = gs.rms_tot || 1;
    const x = [base, base + Math.max(1, sec.duration_s) * 1000];
    if (which === 'err') {
      const ra = F.map(f => [t(f), isGood(f) ? f[C.ra_raw] * scale : null]);
      const dec = F.map(f => [t(f), isGood(f) ? f[C.dec_raw] * scale : null]);
      const maxAbs = Math.max(...F.filter(isGood).map(f => Math.max(Math.abs(f[C.ra_raw]), Math.abs(f[C.dec_raw]))).concat([0.5])) * scale;
      const lim = Math.min(maxAbs * 1.05, Math.max(1, 4 * rmsTot));
      const yl = niceDomain([-lim, lim], 4);
      const bands = []; let open = null;
      sec.events.forEach(e => { if (e.type === 'settle_start') open = e.t; else if ((e.type === 'settle_done' || e.type === 'settle_failed') && open != null) { bands.push({ x0: base + open * 1000, x1: base + e.t * 1000, color: e.type === 'settle_failed' ? 'var(--crit)' : null }); open = null; } });
      if (open != null) bands.push({ x0: base + open * 1000, x1: x[1] });
      const vlines = sec.events.filter(e => e.type === 'dither').map(e => ({ x: base + e.t * 1000, color: 'var(--muted)', tip: `<b>Dither</b> ${fmtTime(new Date(base + e.t * 1000))}<br>${fmtNum(e.data.dx, 2)}, ${fmtNum(e.data.dy, 2)} px` }));
      F.forEach((f, j) => { if (f[C.drop] && (j === 0 || !F[j - 1][C.drop])) vlines.push({ x: t(f), color: 'var(--serious)', width: 2, tip: `<b>Star lost</b> ${fmtTime(new Date(t(f)))}<br>${esc(f[C.err_text] || '')}` }); });
      lineChart(container, { x, y: yl, xTime: true, height: 230, yLabel: 'error (″)', bands, vlines,
        series: [{ name: 'RA', color: 'var(--ra)', pts: ra, unit: '″', thin: true }, { name: 'DEC', color: 'var(--dec)', pts: dec, unit: '″', thin: true }],
        hover: { extra: ax => { const j = nearestIdx(ra, ax); const f = F[j]; if (!f) return ''; return `${ttRow('SNR', fmtNum(f[C.snr], 1))}${ttRow('Star mass', f[C.mass] != null ? Math.round(f[C.mass]) : '—')}${f[C.ra_dur] ? ttRow('RA pulse', `${f[C.ra_dur]} ms ${f[C.ra_dir]}`) : ''}${f[C.dec_dur] ? ttRow('DEC pulse', `${f[C.dec_dur]} ms ${f[C.dec_dir]}`) : ''}${f[C.drop] ? `<div class="muted">dropped: ${esc(f[C.err_text] || '')}</div>` : ''}${f[C.settling] ? '<div class="muted">settling</div>' : ''}${f[C.runaway] ? '<div class="muted">far from lock position (excluded)</div>' : ''}`; } } });
    } else if (which === 'corr') {
      // Normal corrections are bounded by the max-pulse setting; dither moves can be 10x larger, so clamp to keep the scale useful.
      const maxDur = Math.max(100, (sec.settings.max_ra_ms || 500), (sec.settings.max_dec_ms || 500)) * 1.3;
      const c = baseChart(container, { x, y: [-maxDur, maxDur], xTime: true, height: 150, yLabel: 'ms (clipped at ' + Math.round(maxDur) + ')', pad: { l: 52 } });
      const cl = v => Math.min(v, maxDur);
      const nb = Math.max(50, Math.floor(c.pw / 2));
      const bins = Array.from({ length: nb }, () => ({ raP: 0, raN: 0, decP: 0, decN: 0 }));
      F.forEach(f => { if (!f[C.ra_dur] && !f[C.dec_dur]) return; const b = bins[Math.min(nb - 1, Math.floor(((t(f) - x[0]) / (x[1] - x[0])) * nb))]; if (f[C.ra_dur]) { if (f[C.ra_dir] === 'E') b.raP = Math.max(b.raP, f[C.ra_dur]); else b.raN = Math.max(b.raN, f[C.ra_dur]); } if (f[C.dec_dur]) { if (f[C.dec_dir] === 'N') b.decP = Math.max(b.decP, f[C.dec_dur]); else b.decN = Math.max(b.decN, f[C.dec_dur]); } });
      const bw = c.pw / nb;
      bins.forEach((b, k) => {
        const x0 = c.pad.l + k * bw;
        if (b.raP) c.g.append(el('rect', { x: x0, y: c.sy(cl(b.raP)), width: Math.max(1, bw / 2 - 0.5), height: c.sy(0) - c.sy(cl(b.raP)), style: 'fill:var(--ra)' }));
        if (b.raN) c.g.append(el('rect', { x: x0, y: c.sy(0), width: Math.max(1, bw / 2 - 0.5), height: c.sy(0) - c.sy(cl(b.raN)), style: 'fill:var(--ra)' }));
        if (b.decP) c.g.append(el('rect', { x: x0 + bw / 2, y: c.sy(cl(b.decP)), width: Math.max(1, bw / 2 - 0.5), height: c.sy(0) - c.sy(cl(b.decP)), style: 'fill:var(--dec)' }));
        if (b.decN) c.g.append(el('rect', { x: x0 + bw / 2, y: c.sy(0), width: Math.max(1, bw / 2 - 0.5), height: c.sy(0) - c.sy(cl(b.decN)), style: 'fill:var(--dec)' }));
      });
      addCrosshair(c, [{ name: 'RA pulse', color: 'var(--ra)', pts: F.map(f => [t(f), f[C.ra_dur] ? (f[C.ra_dir] === 'E' ? 1 : -1) * f[C.ra_dur] : 0]), unit: ' ms', fmt: v => String(Math.round(v)) }, { name: 'DEC pulse', color: 'var(--dec)', pts: F.map(f => [t(f), f[C.dec_dur] ? (f[C.dec_dir] === 'N' ? 1 : -1) * f[C.dec_dur] : 0]), unit: ' ms', fmt: v => String(Math.round(v)) }]);
    } else if (which === 'snr') {
      const snr = F.map(f => [t(f), f[C.snr] || null]);
      const mass = F.map(f => [t(f), f[C.mass] || null]);
      container.innerHTML = '<div id="sec-snr-a"></div><div id="sec-snr-b" style="margin-top:2px"></div>';
      lineChart(container.querySelector('#sec-snr-a'), { x, y: niceDomain([0, Math.max(1, ...snr.map(p => p[1] || 0)) * 1.1], 3), xTime: true, height: 78, yLabel: 'SNR', series: [{ name: 'SNR', color: 'var(--snr)', pts: snr, thin: true, fmt: v => fmtNum(v, 1) }], pad: { b: 18 }, xTicks: [] });
      lineChart(container.querySelector('#sec-snr-b'), { x, y: niceDomain([0, Math.max(1, ...mass.map(p => p[1] || 0)) * 1.1], 3), xTime: true, height: 92, yLabel: 'star mass', series: [{ name: 'Star mass', color: 'var(--mass)', pts: mass, thin: true, fmt: v => String(Math.round(v)) }] });
    } else if (which === 'scatter') {
      const good = F.filter(f => isGood(f) && !f[C.settling]);
      const lim = Math.max(0.5, Math.min(Math.max(...good.map(f => Math.max(Math.abs(f[C.ra_raw]), Math.abs(f[C.dec_raw]))).concat([0.1])) * scale * 1.05, Math.max(1.5, 4 * rmsTot)));
      const w = Math.max(280, container.clientWidth || 400), h = 240;
      const ar = (w - 68) / (h - 44);
      const c = baseChart(container, { x: [-lim * ar, lim * ar], y: [-lim, lim], height: h, pad: { l: 52, r: 16, t: 14, b: 30 }, xLabel: 'RA (″)', yLabel: 'DEC (″)' });
      c.g.append(el('line', { class: 'zero', x1: c.sx(0), x2: c.sx(0), y1: c.pad.t, y2: c.h - c.pad.b }));
      const step = Math.max(1, Math.ceil(good.length / 3000));
      for (let j = 0; j < good.length; j += step) { const f = good[j]; c.g.append(el('circle', { cx: c.sx(clamp(f[C.ra_raw] * scale, c.x)), cy: c.sy(clamp(f[C.dec_raw] * scale, c.y)), r: 2.2, style: 'fill:var(--ink-2);opacity:.45' })); }
      if (gs.rms_tot) { const r = c.sy(0) - c.sy(gs.rms_tot); c.over.append(el('circle', { cx: c.sx(0), cy: c.sy(0), r, style: 'fill:none;stroke:var(--accent);stroke-width:1.5', 'data-tip': `<b>Total RMS</b> ${arcsec(gs.rms_tot)}` })); }
      [1, 2].forEach(v => { if (v < lim) c.over.append(el('circle', { cx: c.sx(0), cy: c.sy(0), r: c.sy(0) - c.sy(v), style: 'fill:none;stroke:var(--axis);stroke-width:1;stroke-dasharray:2 3', 'data-tip': `${v}″ reference` })); });
    } else if (which === 'hist') {
      const good = F.filter(f => isGood(f) && !f[C.settling]);
      if (!good.length) { container.innerHTML = emptyBox('No guided frames.'); return; }
      const lim = Math.max(0.5, Math.max(1.5, 4 * rmsTot));
      const nb = 30, bw = (2 * lim) / nb;
      const hr = new Array(nb).fill(0), hd = new Array(nb).fill(0);
      good.forEach(f => { const r = f[C.ra_raw] * scale, d = f[C.dec_raw] * scale; const ir = Math.floor((r + lim) / bw), id = Math.floor((d + lim) / bw); if (ir >= 0 && ir < nb) hr[ir]++; if (id >= 0 && id < nb) hd[id]++; });
      const ymax = Math.max(1, ...hr, ...hd);
      const c = baseChart(container, { x: [-lim, lim], y: [0, niceDomain([0, ymax * 1.1], 3)[1]], height: 240, xLabel: 'error (″)', yLabel: 'frames', pad: { l: 52 } });
      const pw = c.pw / nb;
      for (let k = 0; k < nb; k++) {
        const x0 = c.pad.l + k * pw; const lo = -lim + k * bw;
        const tip = `<b>${fmtNum(lo, 2)} to ${fmtNum(lo + bw, 2)}″</b><br>RA ${hr[k]} · DEC ${hd[k]} frames`;
        c.g.append(el('rect', { class: 'bar', x: x0 + 1, y: c.sy(hr[k]), width: Math.max(1, pw / 2 - 1.5), height: c.sy(0) - c.sy(hr[k]), style: 'fill:var(--ra)', 'data-tip': tip }));
        c.g.append(el('rect', { class: 'bar', x: x0 + pw / 2 + 0.5, y: c.sy(hd[k]), width: Math.max(1, pw / 2 - 1.5), height: c.sy(0) - c.sy(hd[k]), style: 'fill:var(--dec)', 'data-tip': tip }));
      }
    }
  }
  const SETTING_LABELS = { camera: 'Camera', gain: 'Gain', sensor_w: 'Sensor width', sensor_h: 'Sensor height', pixel_size_um: 'Pixel size (µm)', pixel_scale: 'Pixel scale (″/px)', binning: 'Binning', focal_length_mm: 'Focal length (mm)', exposure_ms: 'Exposure (ms)', mount: 'Mount', x_angle: 'RA angle (°)', x_rate: 'RA rate (px/s)', y_angle: 'DEC angle (°)', y_rate: 'DEC rate (px/s)', parity: 'Parity', ra_algo: 'RA algorithm', ra_algo_params: 'RA parameters', dec_algo: 'DEC algorithm', dec_algo_params: 'DEC parameters', ra_min_move: 'RA min move (px)', dec_min_move: 'DEC min move (px)', ra_aggression: 'RA aggression', dec_aggression: 'DEC aggression', ra_hysteresis: 'RA hysteresis', backlash_comp: 'Backlash compensation', backlash_pulse_ms: 'Backlash pulse (ms)', max_ra_ms: 'Max RA pulse (ms)', max_dec_ms: 'Max DEC pulse (ms)', dec_guide_mode: 'DEC guide mode', dither_axes: 'Dither', dither_scale: 'Dither scale', noise_reduction: 'Noise reduction', time_lapse: 'Time lapse', search_region_px: 'Search region (px)', mass_tolerance_pct: 'Star mass tolerance (%)', cal_dec: 'Calibration DEC', last_cal_issue: 'Last calibration issue', dec: 'DEC (°)', hour_angle: 'Hour angle (h)', pier_side: 'Pier side', lock_x: 'Lock X', lock_y: 'Lock Y', star_x: 'Star X', star_y: 'Star Y', hfd: 'Star HFD (px)', profile: 'Profile', cal_step_ms: 'Calibration step (ms)', assume_orthogonal: 'Assume orthogonal axes' };
  function settingsRows(set, keys) {
    return (keys || Object.keys(set)).filter(k => set[k] != null && set[k] !== '').map(k => `<dt>${esc(SETTING_LABELS[k] || k)}</dt><dd>${esc(set[k])}</dd>`).join('');
  }

  // ===================================================================================
  // Frames tab
  // ===================================================================================
  function framesTab(s) {
    const frames = FRAME(s);
    if (!frames.length) return `<div class="card"><div class="chart-empty">No exposures were logged in this session.</div></div>`;
    const ps = perSession(s.id).frames;
    const types = [...new Set(frames.map(f => f.type))];
    if (ps.type && !types.includes(ps.type)) ps.type = '';
    const filters = [...new Set(frames.map(f => f.filter || '?'))];
    const targets = [...new Set(frames.map(f => f.target || '?'))];
    const rows = frames.filter(f => (!ps.type || f.type === ps.type) && (!ps.filter || (f.filter || '?') === ps.filter) && (!ps.target || (f.target || '?') === ps.target));
    const key = ps.sort, dir = ps.dir;
    const val = f => ({ t: T(f.t), image: f.image, target: f.target || '', type: f.type, filter: f.filter || '', exposure: f.exposure_s, settle: f.settle_s ?? -1, rms: f.guide ? f.guide.rms_tot ?? -1 : -1, ra: f.guide ? f.guide.rms_ra ?? -1 : -1, dec: f.guide ? f.guide.rms_dec ?? -1 : -1, peak: f.guide ? Math.max(f.guide.peak_ra || 0, f.guide.peak_dec || 0) : -1, lost: (f.guide ? f.guide.star_lost_events : 0) + f.star_lost, drop: f.guide ? f.guide.dropped : -1 }[key]);
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const rmsVals = rows.map(f => f.guide && f.guide.rms_tot).filter(v => v != null);
    const med = median(rmsVals);
    const bad = v => med != null && v != null && v > Math.max(1.5 * med, med + 0.3);
    const th = (k, label, num) => `<th class="sortable ${num ? 'num' : ''} ${key === k ? 'sorted' : ''}" data-sort="${k}">${label}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const sel = (id, label, opts, cur) => `<select id="${id}"><option value="">${label}: all</option>${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o === '?' ? 'unknown' : o)}</option>`).join('')}</select>`;
    defer(() => framesChart(document.getElementById('frames-chart'), s, rows.slice().sort((a, b) => T(a.t) - T(b.t)), med));
    const tiles = [
      tile('Frames shown', rows.length, `${plural(sum(rows.map(f => f.exposure_s)) / 3600 < 1 ? Math.round(sum(rows.map(f => f.exposure_s)) / 60) : +(sum(rows.map(f => f.exposure_s)) / 3600).toFixed(2), sum(rows.map(f => f.exposure_s)) / 3600 < 1 ? 'minute' : 'hour')} total exposure`),
      tile('Median guide RMS', med != null ? fmtNum(med) : '—', rmsVals.length ? `best ${arcsec(Math.min(...rmsVals))} · worst ${arcsec(Math.max(...rmsVals))}` : 'no guiding data', '', med != null ? '″' : ''),
      tile('Flagged frames', rows.filter(f => f.guide && bad(f.guide.rms_tot)).length, 'RMS well above the session median', rows.some(f => f.guide && bad(f.guide.rms_tot)) ? 'warn' : 'good'),
      tile('Star lost during', rows.filter(f => (f.guide && f.guide.star_lost_events) || f.star_lost).length, 'frames with a lost guide star', rows.some(f => (f.guide && f.guide.star_lost_events) || f.star_lost) ? 'warn' : 'good'),
      tile('Settle timeouts', rows.filter(f => f.settle_result && f.settle_result !== 'done').length, 'frames started after a settle timeout/failure', rows.some(f => f.settle_result && f.settle_result !== 'done') ? 'warn' : 'good'),
    ].join('');
    return `<div class="tiles">${tiles}</div>
      <div class="card"><h3>Guiding RMS per frame <span class="sub">bar = exposure span · dashed line = median · marker = star lost</span></h3>${chartBox('frames-chart', 190)}${filterLegend(filters)}</div>
      <div class="card"><div class="toolbar">${sel('fr-type', 'Type', types, ps.type)}${sel('fr-filter', 'Filter', filters, ps.filter)}${sel('fr-target', 'Target', targets, ps.target)}<button class="btn small" id="fr-csv">Export CSV</button><span class="count">${rows.length} of ${frames.length} frames</span></div>
      <div class="tbl-wrap"><table class="tbl" id="frames-table"><thead><tr>${th('image', '#', true)}${th('t', 'Start')}${th('target', 'Target')}${th('type', 'Type')}${th('filter', 'Filter')}${th('exposure', 'Exp', true)}<th class="num">Bin</th>${th('settle', 'Settle', true)}${th('ra', 'RA RMS', true)}${th('dec', 'DEC RMS', true)}${th('rms', 'Total', true)}${th('peak', 'Peak', true)}${th('lost', 'Lost', true)}${th('drop', 'Dropped', true)}<th class="num">Cover</th></tr></thead><tbody>${rows.map(f => {
        const g = f.guide; const isBad = g && bad(g.rms_tot);
        const lost = (g ? g.star_lost_events : 0) + f.star_lost;
        return `<tr class="${isBad ? 'bad' : ''}"><td class="num">${f.image}</td><td class="mono">${fmtTime(new Date(f.t))}</td><td>${esc(f.target || '—')}</td><td>${esc(f.type)}</td><td>${filterChip(f.filter)}</td><td class="num">${fmtExp(f.exposure_s)}</td><td class="num">${f.bin}</td><td class="num">${f.settle_s != null ? `${fmtNum(f.settle_s, 0)}s ${f.settle_result !== 'done' ? `<span class="chip warn">${esc(f.settle_result)}</span>` : ''}` : '—'}</td><td class="num">${g ? arcsec(g.rms_ra) : '—'}</td><td class="num">${g ? arcsec(g.rms_dec) : '—'}</td><td class="num"><b>${g ? arcsec(g.rms_tot) : '—'}</b></td><td class="num">${g ? arcsec(Math.max(g.peak_ra || 0, g.peak_dec || 0)) : '—'}</td><td class="num">${lost ? `<span class="chip warn">${lost}</span>` : '0'}</td><td class="num">${g ? g.dropped + (g.runaway ? ` <span class="chip warn" data-tip="${g.runaway} guide frames far from the lock position (excluded from RMS)">+${g.runaway}</span>` : '') : '—'}</td><td class="num">${g && g.coverage != null ? Math.round(g.coverage * 100) + '%' : '—'}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  }
  function framesChart(container, s, rows, med) {
    if (!container) return;
    const lights = rows.filter(f => f.guide && f.guide.rms_tot != null);
    if (!lights.length) { container.innerHTML = emptyBox('No frames with guiding data in the current selection.'); return; }
    const x = [T(rows[0].t), Math.max(...rows.map(f => T(f.end)))];
    const ymax = Math.max(0.5, ...lights.map(f => f.guide.rms_tot));
    const c = baseChart(container, { x, y: [0, niceDomain([0, Math.min(ymax, Math.max(med * 4, 1.5)) * 1.1], 3)[1]], xTime: true, height: 190, yLabel: 'total RMS (″)' });
    if (med != null) c.g.append(el('line', { class: 'threshold', x1: c.pad.l, x2: c.w - c.pad.r, y1: c.sy(med), y2: c.sy(med), style: 'stroke:var(--muted)' }));
    lights.forEach(f => {
      const g = f.guide; const x0 = c.sx(T(f.t)), w = Math.max(2, c.sx(T(f.end)) - x0 - 1);
      const v = clamp(g.rms_tot, c.y);
      const tip = `<div class="tt-title">${esc(f.type)} #${f.image} · ${esc(f.target || '')}</div>${ttRow('Start', fmtTime(new Date(f.t)))}${ttRow('Filter', esc(f.filter || '—'))}${ttRow('RMS', `RA ${arcsec(g.rms_ra)} · DEC ${arcsec(g.rms_dec)} · ${arcsec(g.rms_tot)}`)}${ttRow('Peak', `${arcsec(g.peak_ra)} / ${arcsec(g.peak_dec)}`)}${g.star_lost_events || f.star_lost ? ttRow('Star lost', g.star_lost_events + f.star_lost) : ''}${f.settle_s != null ? ttRow('Settle before', `${fmtNum(f.settle_s, 0)}s ${f.settle_result}`) : ''}`;
      c.g.append(el('rect', { class: 'bar', x: x0, y: c.sy(v), width: w, height: c.sy(0) - c.sy(v), style: `fill:${filterColor(f.filter)}`, 'data-tip': tip }));
      if (g.star_lost_events || f.star_lost) c.over.append(el('circle', { cx: x0 + w / 2, cy: c.sy(v) - 6, r: 3, style: 'fill:var(--serious)', 'data-tip': tip }));
    });
  }
  function exportFramesCsv(s) {
    const ps = perSession(s.id).frames;
    const rows = FRAME(s).filter(f => (!ps.type || f.type === ps.type) && (!ps.filter || (f.filter || '?') === ps.filter) && (!ps.target || (f.target || '?') === ps.target));
    const head = ['image', 'start', 'end', 'target', 'type', 'filter', 'exposure_s', 'bin', 'settle_s', 'settle_result', 'rms_ra_arcsec', 'rms_dec_arcsec', 'rms_total_arcsec', 'peak_ra_arcsec', 'peak_dec_arcsec', 'star_lost', 'dropped_guide_frames', 'guide_coverage'];
    const lines = [head.join(',')].concat(rows.map(f => { const g = f.guide || {}; return [f.image, f.t, f.end, f.target, f.type, f.filter, f.exposure_s, f.bin, f.settle_s ?? '', f.settle_result ?? '', g.rms_ra ?? '', g.rms_dec ?? '', g.rms_tot ?? '', g.peak_ra ?? '', g.peak_dec ?? '', (g.star_lost_events || 0) + f.star_lost, g.dropped ?? '', g.coverage ?? ''].map(v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(','); }));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `asiair-frames-${s.id}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ===================================================================================
  // Log tab
  // ===================================================================================
  const CAT_LABELS = { plan: 'Plan', autorun: 'Autorun', sequence: 'Sequence', exposure: 'Exposure', filter: 'Filter', guide: 'Guide', autofocus: 'Autofocus', autocenter: 'Auto-center', flip: 'Meridian flip', mount: 'Mount', camera: 'Camera', log: 'Log', calibration: 'Calibration', phd2: 'PHD2', other: 'Other' };
  function logTab(s) {
    const ps = perSession(s.id).log;
    const cats = [...new Set(s.events.map(e => e.cat))];
    const q = ps.q.trim().toLowerCase();
    const rows = s.events.filter(e => ps.src.has(e.src) && (!ps.cats.size || ps.cats.has(e.cat)) && (!ps.levels.size || ps.levels.has(e.level)) && (!q || e.text.toLowerCase().includes(q)));
    const shown = rows.slice(0, ps.limit);
    let lastDay = '';
    const html = shown.map(e => {
      const d = new Date(e.t); const day = d.toDateString();
      const sep = day !== lastDay ? `<div class="log-row" style="background:var(--surface-2)"><span class="t"></span><span class="src"></span><span class="cat"></span><span class="x muted">— ${DAYS[d.getDay()]} ${fmtDate(d)} —</span></div>` : '';
      lastDay = day;
      return `${sep}<div class="log-row lvl-${e.level} src-${e.src}"><span class="t">${fmtTime(d)}</span><span class="src">${e.src}</span><span class="cat">${esc(CAT_LABELS[e.cat] || e.cat)}</span><span class="x">${esc(e.text)}</span></div>`;
    }).join('');
    const chip = (group, key, label, on) => `<span class="chip btn ${on ? 'on' : ''}" data-log="${group}" data-key="${key}">${esc(label)}</span>`;
    return `<div class="card"><div class="toolbar"><input type="search" id="log-q" placeholder="Search log text…" value="${esc(ps.q)}">
        ${chip('src', 'autorun', 'Autorun', ps.src.has('autorun'))}${chip('src', 'phd2', 'PHD2', ps.src.has('phd2'))}
        <span class="muted">|</span>${['success', 'warn', 'error'].map(l => chip('level', l, l === 'warn' ? 'warnings' : l === 'error' ? 'errors' : 'success', ps.levels.has(l))).join('')}
        <span class="muted">|</span>${cats.map(c => chip('cat', c, CAT_LABELS[c] || c, ps.cats.has(c))).join('')}
        <span class="count">${rows.length} of ${s.events.length} lines</span></div>
      <div class="log">${html || '<div class="empty">No log lines match.</div>'}${rows.length > shown.length ? `<div class="log-more"><button class="btn small" id="log-more">Show ${Math.min(1000, rows.length - shown.length)} more</button></div>` : ''}</div></div>`;
  }

  // ===================================================================================
  // Equipment tab
  // ===================================================================================
  function equipmentTab(s) {
    const secs = s.guiding.sections, cals = s.guiding.calibrations;
    const last = secs.length ? secs[secs.length - 1].settings : null;
    const guiderKeys = ['camera', 'gain', 'sensor_w', 'sensor_h', 'pixel_size_um', 'pixel_scale', 'focal_length_mm', 'binning', 'exposure_ms', 'search_region_px', 'mass_tolerance_pct', 'noise_reduction'];
    const algoKeys = ['ra_algo', 'ra_algo_params', 'dec_algo', 'dec_algo_params', 'ra_min_move', 'dec_min_move', 'ra_aggression', 'dec_aggression', 'max_ra_ms', 'max_dec_ms', 'dec_guide_mode', 'backlash_comp', 'backlash_pulse_ms', 'dither_axes', 'dither_scale'];
    const mountKeys = ['mount', 'x_angle', 'x_rate', 'y_angle', 'y_rate', 'parity', 'cal_dec', 'last_cal_issue', 'pier_side'];
    // settings that changed between sections
    const varying = [];
    if (secs.length > 1) {
      const keys = new Set(secs.flatMap(x => Object.keys(x.settings)));
      const skip = new Set(['lock_x', 'lock_y', 'star_x', 'star_y', 'hfd', 'dec', 'hour_angle', 'pier_side', 'profile']);
      keys.forEach(k => { if (skip.has(k)) return; const vals = [...new Set(secs.map(x => String(x.settings[k])))]; if (vals.length > 1) varying.push([k, secs.map((x, i) => ({ i, v: x.settings[k] }))]); });
    }
    const afs = s.autorun.autofocus;
    const imgKv = [
      ['Filters used', (s.summary.filters || []).length ? s.summary.filters.map(filterChip).join(' ') : '—'],
      ['Exposures used', [...new Set(FRAME(s).filter(f => f.type === 'light').map(f => fmtExp(f.exposure_s)))].join(', ') || '—'],
      ['Binning', [...new Set(FRAME(s).map(f => f.bin))].join(', ') || '—'],
      ['Autofocus exposure', afs.length ? `${fmtExp(afs[0].exposure_s)} bin${afs[0].bin}` : '—'],
      ['EAF positions', s.summary.autofocus.positions.length ? `${Math.min(...s.summary.autofocus.positions)} – ${Math.max(...s.summary.autofocus.positions)}` : '—'],
      ['Temperature (EAF)', s.summary.autofocus.temp_min != null ? `${s.summary.autofocus.temp_min} – ${s.summary.autofocus.temp_max} °C` : '—'],
      ['Plate solve', s.autorun.autocenter.length ? `${s.autorun.autocenter.length} solves · ${[...new Set(s.autorun.autocenter.map(a => fmtExp(a.exposure_s)))].join('/')} exposure` : '—'],
    ];
    return `<div class="grid-2">
      <div class="card"><h3>Guide camera &amp; optics <span class="sub">${last ? 'from the last guiding section' : 'no PHD2 data'}</span></h3>${last ? `<dl class="kv">${settingsRows(last, guiderKeys)}</dl>` : emptyBox('No PHD2 guide log in this session.')}</div>
      <div class="card"><h3>Guiding algorithms</h3>${last ? `<dl class="kv">${settingsRows(last, algoKeys)}</dl>` : emptyBox('—')}</div>
      <div class="card"><h3>Mount &amp; calibration</h3>${last ? `<dl class="kv">${settingsRows(last, mountKeys)}</dl>` : emptyBox('—')}${cals.length ? `<div class="note">${cals.length} calibration${cals.length > 1 ? 's' : ''} in this session (see Guiding tab).</div>` : ''}</div>
      <div class="card"><h3>Imaging setup <span class="sub">derived from the Autorun log</span></h3><dl class="kv">${imgKv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
      <div class="card"><h3>Settings that changed between guiding sections</h3>${varying.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Setting</th><th>Values by section</th></tr></thead><tbody>${varying.map(([k, vals]) => `<tr><td>${esc(SETTING_LABELS[k] || k)}</td><td class="mono small">${vals.map(x => `<span class="chip mono" data-tip="section ${x.i + 1}">${x.i + 1}: ${esc(x.v)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="note">${secs.length > 1 ? 'All guiding settings stayed the same during the session.' : 'Only one guiding section.'}</div>`}</div>
      <div class="card"><h3>Source files</h3><dl class="kv"><dt>Autorun</dt><dd>${s.files.autorun.map(esc).join('<br>') || '—'}</dd><dt>PHD2</dt><dd>${s.files.phd2.map(esc).join('<br>') || '—'}</dd><dt>PHD2 version</dt><dd>${esc(s.meta.phd2_version || '—')}</dd></dl></div>
    </div>`;
  }

  // ===================================================================================
  // All-sessions view
  // ===================================================================================
  function allView() {
    const ss = DATA.sessions.slice().sort((a, b) => (a.start < b.start ? -1 : 1));
    const lights = sum(ss.map(s => s.summary.light_frames));
    const integ = sum(ss.map(s => s.summary.light_integration_s));
    const targets = [...new Set(ss.flatMap(s => s.summary.targets))];
    const afAll = ss.flatMap(s => s.autorun.autofocus.filter(a => a.result === 'success' && a.final_pos != null).map(a => Object.assign({ session: s }, a)));
    const first = ss[0] ? new Date(ss[0].start) : null, lastD = ss.length ? new Date(ss[ss.length - 1].start) : null;
    const byTarget = {};
    ss.forEach(s => (s.summary.integration || []).forEach(i => { const t = byTarget[i.target] = byTarget[i.target] || {}; t[i.filter] = (t[i.filter] || 0) + i.seconds; }));
    const targetRows = Object.entries(byTarget).map(([t, f]) => ({ target: t, filters: f, total: sum(Object.values(f)) })).sort((a, b) => b.total - a.total);
    const maxT = Math.max(1, ...targetRows.map(r => r.total));
    const allFilters = [...new Set(targetRows.flatMap(r => Object.keys(r.filters)))];
    defer(() => rmsBySession(document.getElementById('all-rms'), ss));
    defer(() => focusTempChart(document.getElementById('all-focus-temp'), afAll));
    defer(() => focusHistory(document.getElementById('all-focus-time'), afAll));
    const imaging = ss.filter(s => s.summary.light_frames > 0);
    return `<div class="hero fade-in"><div><span class="lab">Sessions</span><div class="big">${ss.length}</div></div><div><span class="lab">Light frames</span><div class="big">${lights}</div></div><div><span class="lab">Integration</span><div class="big">${(integ / 3600).toFixed(1)}<small>h</small></div></div><div><span class="lab">Targets</span><div class="big">${targets.length}</div></div><div><span class="lab">Period</span><div class="big" style="font-size:28px">${first ? fmtDateShort(first) : '—'} – ${lastD ? fmtDate(lastD) : ''}</div></div></div>
      <div class="stagger">
      <div class="grid-2"><div class="card"><h3>Integration by target</h3>${targetRows.length ? `<div class="hbars">${targetRows.map(r => `<div class="lab">${esc(r.target)}</div><div class="bar-row">${Object.entries(r.filters).map(([f, sec]) => `<i style="width:${(100 * sec / maxT).toFixed(1)}%;--c:${filterColor(f)}" data-tip="<b>${esc(r.target)}</b> · ${esc(f)}<br>${fmtDur(sec)}"></i>`).join('')}</div><div class="val">${fmtDur(r.total)}</div>`).join('')}</div>${filterLegend(allFilters)}` : emptyBox('No light frames yet.')}</div>
        <div class="card"><h3>Guiding RMS per session <span class="sub">excluding settling · hover for detail</span></h3>${chartBox('all-rms', 220)}<div class="legend"><span><i style="--c:var(--ra)"></i>RA RMS</span><span><i style="--c:var(--dec)"></i>DEC RMS</span></div></div></div>
      <div class="grid-2"><div class="card"><h3>Focus position vs temperature <span class="sub">all successful autofocus runs</span></h3>${chartBox('all-focus-temp', 240)}<div id="all-focus-temp-legend"></div></div>
        <div class="card"><h3>Focus position history</h3>${chartBox('all-focus-time', 240)}${filterLegend([...new Set(afAll.map(a => a.filter || '?'))])}</div></div>
      <div class="card"><h3>Sessions</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Time</th><th>Targets</th><th>Plans</th><th class="num">Lights</th><th class="num">Integration</th><th class="num">RMS</th><th class="num">AF</th><th class="num">Dithers</th><th class="num">Lost</th><th class="num">Issues</th></tr></thead><tbody>${ss.slice().reverse().map(s => { const sm = s.summary; const d = new Date(s.start); return `<tr class="row-click" data-go="${sessHref(s.id, 'overview')}"><td class="mono nowrap">${fmtDate(d)}</td><td class="mono nowrap">${fmtHM(d)} – ${fmtHM(new Date(s.end))}</td><td>${esc(sm.targets.join(', ') || '—')}</td><td>${esc(sm.plans.join(', ') || '—')}</td><td class="num">${sm.light_frames}</td><td class="num">${fmtDur(sm.light_integration_s)}</td><td class="num">${sm.guiding.rms_tot != null ? arcsec(sm.guiding.rms_tot) : '—'}</td><td class="num">${sm.autofocus.runs}${sm.autofocus.failed ? ` <span class="chip err">${sm.autofocus.failed} failed</span>` : ''}</td><td class="num">${sm.dithers.n}</td><td class="num">${sm.guiding.star_lost_events + sm.star_lost_autorun}</td><td class="num">${s.issues.length ? `<span class="chip ${s.issues.some(i => i.level === 'error') ? 'err' : 'warn'}">${s.issues.length}</span>` : '<span class="chip good">0</span>'}</td></tr>`; }).join('')}</tbody></table></div></div>
      <div class="card"><h3>Imaging nights at a glance</h3>${imaging.length ? `<div class="hbars">${imaging.map(s => { const sm = s.summary; const tot = sm.light_integration_s || 1; const maxI = Math.max(...imaging.map(x => x.summary.light_integration_s || 0), 1); return `<div class="lab"><a href="${sessHref(s.id)}">${fmtDate(new Date(s.start))}</a></div><div class="bar-row">${(sm.integration || []).map(i => `<i style="width:${(100 * i.seconds / maxI).toFixed(1)}%;--c:${filterColor(i.filter)}" data-tip="<b>${esc(i.target)}</b> · ${esc(i.filter)}<br>${i.frames} frames · ${fmtDur(i.seconds)}"></i>`).join('')}</div><div class="val">${fmtDur(tot)} · ${esc(sm.targets.join(', '))}</div>`; }).join('')}</div>` : emptyBox('No imaging sessions yet.')}</div>
      </div>`;
  }
  function rmsBySession(container, ss) {
    if (!container) return;
    const rows = ss.filter(s => s.summary.guiding.rms_tot != null);
    if (!rows.length) { container.innerHTML = emptyBox('No guiding data.'); return; }
    const ymax = Math.max(0.5, ...rows.map(s => Math.max(s.summary.guiding.rms_ra, s.summary.guiding.rms_dec)));
    const c = baseChart(container, { x: [-0.5, rows.length - 0.5], y: [0, niceDomain([0, Math.min(ymax, 3) * 1.15], 3)[1]], height: 220, yLabel: 'RMS (″)', xTicks: rows.map((_, i) => i), xFmt: i => (rows[i] ? fmtDateShort(new Date(rows[i].start)) : ''), noXGrid: true });
    const bw = c.pw / rows.length, half = Math.max(2, (bw - 6) / 2 - 1);
    rows.forEach((s, i) => {
      const g = s.summary.guiding; const x0 = c.sx(i) - half - 1;
      const tip = `<div class="tt-title">${fmtDate(new Date(s.start))} · ${esc(s.summary.targets.join(', '))}</div>${ttRow('RA RMS', arcsec(g.rms_ra), 'var(--ra)')}${ttRow('DEC RMS', arcsec(g.rms_dec), 'var(--dec)')}${ttRow('Total', arcsec(g.rms_tot))}${ttRow('Guided', fmtDur(g.guided_s))}`;
      const grp = el('g', { class: 'clickable', 'data-tip': tip });
      grp.append(el('rect', { class: 'bar', x: x0, y: c.sy(clamp(g.rms_ra, c.y)), width: half, height: c.sy(0) - c.sy(clamp(g.rms_ra, c.y)), style: 'fill:var(--ra)' }));
      grp.append(el('rect', { class: 'bar', x: x0 + half + 2, y: c.sy(clamp(g.rms_dec, c.y)), width: half, height: c.sy(0) - c.sy(clamp(g.rms_dec, c.y)), style: 'fill:var(--dec)' }));
      grp.addEventListener('click', () => nav(sessHref(s.id, 'guiding')));
      c.g.append(grp);
    });
  }
  function focusTempChart(container, afs) {
    if (!container) return;
    const pts = afs.filter(a => a.temperature != null);
    if (pts.length < 2) { container.innerHTML = emptyBox('Not enough autofocus runs with a temperature reading.'); return; }
    const x = niceDomain(padDomain(extent(pts.map(a => a.temperature)), 0.15), 5);
    const y = niceDomain(padDomain(extent(pts.map(a => a.final_pos)), 0.15), 4);
    const c = baseChart(container, { x, y, height: 240, xLabel: 'EAF temperature (°C)', yLabel: 'EAF position', xFmt: v => fmtNum(v, 1), yFmt: v => String(Math.round(v)) });
    const fit = linfit(pts.map(a => [a.temperature, a.final_pos]));
    if (fit && pts.length >= 3) {
      c.g.append(el('line', { class: 'fitln', x1: c.sx(x[0]), y1: c.sy(fit.slope * x[0] + fit.intercept), x2: c.sx(x[1]), y2: c.sy(fit.slope * x[1] + fit.intercept), style: 'stroke:var(--muted)' }));
      c.over.append(el('text', { class: 'lab', x: c.w - c.pad.r - 4, y: c.pad.t + 12, 'text-anchor': 'end' }, `fit ≈ ${fmtNum(fit.slope, 1)} steps/°C · R² ${fmtNum(fit.r2, 2)} · n=${pts.length}`));
    }
    pts.forEach(a => c.over.append(el('circle', { class: 'pt', cx: c.sx(a.temperature), cy: c.sy(a.final_pos), r: 5, style: `fill:${filterColor(a.filter)}`, 'data-tip': `<b>${fmtDate(new Date(a.start))} ${fmtTime(new Date(a.start))}</b><br>EAF ${a.final_pos} @ ${a.temperature} °C · ${esc(a.filter || '')}<br><span class="muted">${esc(TRIG[a.trigger] || a.trigger)} · ${esc(a.target || '')}</span>` })));
    const leg = document.getElementById('all-focus-temp-legend'); if (leg) leg.innerHTML = filterLegend([...new Set(pts.map(a => a.filter || '?'))]);
  }
  function focusHistory(container, afs) {
    if (!container) return;
    if (!afs.length) { container.innerHTML = emptyBox('No successful autofocus runs.'); return; }
    const pts = afs.slice().sort((a, b) => T(a.start) - T(b.start)).map(a => [T(a.start), a.final_pos, filterColor(a.filter), `<b>${fmtDate(new Date(a.start))} ${fmtTime(new Date(a.start))}</b><br>EAF ${a.final_pos}${a.temperature != null ? ` @ ${a.temperature} °C` : ''} · ${esc(a.filter || '')}<br><span class="muted">${esc(a.target || '')}</span>`]);
    lineChart(container, { xTime: true, height: 240, yLabel: 'EAF position', x: padDomain(extent(pts.map(p => p[0])), 0.03), y: niceDomain(padDomain(extent(pts.map(p => p[1])), 0.2), 4), xFmt: v => fmtDateShort(new Date(v)), series: [{ name: 'Focus position', color: 'var(--af)', pts, dots: 4.5, thin: true, fmt: v => String(Math.round(v)) }], hover: { xFmt: v => `${fmtDate(new Date(v))} ${fmtTime(new Date(v))}` } });
  }

  // ===================================================================================
  // Event binding for the main area
  // ===================================================================================
  function bindMain() {
    const main = document.getElementById('main'); if (!main) return;
    const s = ui.view === 'session' ? S_BY_ID[ui.id] : null;
    main.querySelectorAll('[data-go]').forEach(e => e.addEventListener('click', ev => { if (ev.target.closest('a')) return; nav(e.dataset.go); }));
    main.querySelectorAll('#sec-table tr[data-sec]').forEach(tr => tr.addEventListener('click', () => selectSection(s, +tr.dataset.sec)));
    if (!s) return;
    const qp = new URLSearchParams(location.hash.split('?')[1] || '');
    if (ui.tab === 'autofocus' && qp.has('af')) { const card = document.getElementById(`af-card-${qp.get('af')}`); if (card) { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); card.style.outline = '2px solid var(--accent)'; setTimeout(() => { card.style.outline = ''; }, 2500); } }
    if (ui.tab === 'guiding' && qp.has('sec')) { const d = document.getElementById('sec-detail'); if (d) setTimeout(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50); }
    // frames
    const ps = perSession(s.id);
    ['type', 'filter', 'target'].forEach(k => { const e = document.getElementById(`fr-${k}`); if (e) e.addEventListener('change', () => { ps.frames[k] = e.value; renderMain(true); }); });
    main.querySelectorAll('#frames-table th[data-sort]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.sort; if (ps.frames.sort === k) ps.frames.dir *= -1; else { ps.frames.sort = k; ps.frames.dir = ['t', 'image', 'target', 'type', 'filter'].includes(k) ? 1 : -1; } renderMain(true); }));
    const csv = document.getElementById('fr-csv'); if (csv) csv.addEventListener('click', () => exportFramesCsv(s));
    // log
    const lq = document.getElementById('log-q');
    if (lq) lq.addEventListener('input', debounce(() => { ps.log.q = lq.value; ps.log.limit = 400; renderMain(true); const n = document.getElementById('log-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 200));
    main.querySelectorAll('[data-log]').forEach(ch => ch.addEventListener('click', () => { const set = ps.log[{ src: 'src', level: 'levels', cat: 'cats' }[ch.dataset.log]]; const k = ch.dataset.key; if (set.has(k)) { if (ch.dataset.log === 'src' && set.size === 1) return; set.delete(k); } else set.add(k); ps.log.limit = 400; renderMain(true); }));
    const more = document.getElementById('log-more'); if (more) more.addEventListener('click', () => { ps.log.limit += 1000; renderMain(true); });
  }

  // ===================================================================================
  // Boot
  // ===================================================================================
  Object.assign(ui, parseHash());
  if (!location.hash && ui.view === 'session') history.replaceState(null, '', sessHref(ui.id, ui.tab));
  render();
})();
