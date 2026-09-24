/* Productivity Timer — Pomodoro, countdown, stopwatch, tasks & time tracking.
   All data lives in localStorage. No server, no database. */
(() => {
'use strict';

/* ================= Helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEY = 'productivity-timer.v1';
const MIN = 60e3;
const pad = n => String(n).padStart(2, '0');
const now = () => Date.now();
const uid = () => Math.random().toString(36).slice(2, 9) + now().toString(36).slice(-4);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dayKey = (t = now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function fmtClock(ms, countUp = false) {
  const total = Math.max(0, countUp ? Math.floor(ms / 1000) : Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function fmtDur(ms) {
  if (!ms || ms < 1000) return '0m';
  if (ms < MIN) return Math.floor(ms / 1000) + 's';
  const m = Math.floor(ms / MIN);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + pad(m % 60) + 'm';
}
function fmtPreset(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return sec ? `${m}m ${sec}s` : `${m} min`;
  return `${sec}s`;
}

/* ================= State ================= */
const DEFAULTS = () => ({
  v: 1,
  settings: {
    focus: 25, short: 5, long: 15, longEvery: 4,
    autoBreak: false, autoFocus: false,
    sound: true, volume: 0.7, vibrate: true, wake: true,
    goal: 8, trackTimer: true, wakeFs: true,
    theme: 'auto', palette: 'mono', custom: null
  },
  view: 'pomo',
  pomo: { mode: 'focus', running: false, endTs: 0, remaining: 25 * MIN, cycle: 0 },
  timerMode: 'cd',
  cd: { duration: 5 * MIN, remaining: 5 * MIN, running: false, endTs: 0 },
  sw: { running: false, startTs: 0, acc: 0, laps: [] },
  presets: [1, 3, 5, 10, 15, 20, 30, 45, 60].map(m => m * MIN),
  tasks: [],
  activeTask: null,
  direct: false,
  lastAccrue: 0,
  log: {},
  taskFilter: 'todo',
  statsRange: 'today',
  hintShown: false
});

function load() {
  const d = DEFAULTS();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    return {
      ...d, ...s,
      settings: { ...d.settings, ...(s.settings || {}) },
      pomo: { ...d.pomo, ...(s.pomo || {}) },
      cd: { ...d.cd, ...(s.cd || {}) },
      sw: { ...d.sw, ...(s.sw || {}) },
      tasks: Array.isArray(s.tasks) ? s.tasks : [],
      log: s.log && typeof s.log === 'object' ? s.log : {}
    };
  } catch (e) { return d; }
}
let S = load();
let saveTimer = 0;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = 0;
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Storage full — export & clear old data'); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }

const task = id => S.tasks.find(t => t.id === id);
function logDay(k = dayKey()) {
  return S.log[k] || (S.log[k] = { focus: 0, prod: 0, tracked: 0, pomos: 0, tasks: {} });
}

/* ================= Time accrual (task tracking + stats) =================
   Called before any state change and on every tick. Adds the wall time since the
   last call to whichever things were "on" during that interval. */
function sources() {
  const p = S.pomo;
  const focusEnd = p.running && p.mode === 'focus' ? p.endTs : 0;
  let taskEnd = 0;
  const t = task(S.activeTask);
  if (t && !t.done) {
    const ends = [];
    if (focusEnd) ends.push(focusEnd);
    if (S.direct) ends.push(Infinity);
    if (S.settings.trackTimer) {
      if (S.cd.running) ends.push(S.cd.endTs);
      if (S.sw.running) ends.push(Infinity);
    }
    if (ends.length) taskEnd = Math.max(...ends);
  }
  return { focusEnd, taskEnd, prodEnd: Math.max(focusEnd, taskEnd) };
}
function isTracking() { return sources().taskEnd > now(); }

function accrue() {
  const t = now();
  const last = S.lastAccrue || t;
  if (t > last) {
    const { focusEnd, taskEnd, prodEnd } = sources();
    const day = logDay(dayKey(t));
    const part = end => Math.max(0, Math.min(t, end) - last);
    if (focusEnd) day.focus += part(focusEnd);
    if (prodEnd) day.prod += part(prodEnd);
    if (taskEnd) {
      const d = part(taskEnd), tk = task(S.activeTask);
      if (d && tk) { tk.ms = (tk.ms || 0) + d; day.tracked += d; day.tasks[tk.id] = (day.tasks[tk.id] || 0) + d; }
    }
  }
  S.lastAccrue = t;
}

/* ================= 7-segment clock ================= */
const SEG = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' };
function Clock(el, stage) {
  const c = { el, stage, str: null, shape: null, digits: [], w: 0, h: 0 };
  // ResizeObserver hands us the size after layout, so reading it never forces a reflow.
  new ResizeObserver(es => { const r = es[es.length - 1].contentRect; c.w = r.width; c.h = r.height; fitClock(c); }).observe(stage);
  return c;
}
function setClock(c, str) {
  if (c.str === str) return;
  const shape = str.replace(/[0-9 -]/g, '0');
  if (shape !== c.shape) {
    c.el.innerHTML = [...str].map(ch => ch === ':'
      ? '<span class="colon"><i></i><i></i></span>'
      : '<span class="digit">' + 'abcdefg'.split('').map(s => `<i class="${s}"></i>`).join('') + '</span>').join('');
    c.digits = $$('.digit', c.el).map(d => [...d.children]);
    c.shape = shape; c.str = null;
    fitClock(c);
  }
  let di = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === ':') continue;
    if (!c.str || c.str[i] !== ch) {
      const on = SEG[ch] || '';
      c.digits[di].forEach(seg => seg.classList.toggle('on', on.includes(seg.className[0])));
    }
    di++;
  }
  c.str = str;
}
function fitClock(c) {
  if (!c.shape) return;
  const n = (c.shape.match(/0/g) || []).length, k = c.shape.length - n;
  const widthEm = n * 0.56 + k * 0.12 + (n + k - 1) * 0.075 + 0.12;
  const w = c.w, h = c.h;
  if (!w || !h) return;
  const zen = app.classList.contains('zen');
  // In focus mode only the LED bar sits under the digits, so let the clock fill the screen.
  const reserve = zen ? 30 + h * 0.06 : (c.stage.children.length > 3 ? 100 : 70);
  const size = zen
    ? Math.max(40, Math.min(w * 0.93 / widthEm, (h - reserve) * 0.96))
    : Math.max(40, Math.min(w * 0.86 / widthEm, (h - reserve) * 0.9, 380));
  c.el.style.fontSize = size.toFixed(1) + 'px';
}

/* LED bar */
const LEDS = 32;
function makeBar(el) { el.innerHTML = '<i></i>'.repeat(LEDS); return { el, leds: [...el.children], lit: -1 }; }
function setBar(b, frac) {
  const lit = Math.round(clamp(frac, 0, 1) * LEDS);
  if (lit === b.lit) return;
  b.leds.forEach((l, i) => l.classList.toggle('on', i < lit));
  b.lit = lit;
}

/* ================= Elements ================= */
const app = $('#app');
const pomoClock = Clock($('#pomoClock'), $('#pomoStage'));
const timerClock = Clock($('#timerClock'), $('#timerStage'));
const pomoBar = makeBar($('#pomoBar'));
const timerBar = makeBar($('#timerBar'));
const VIEWS = ['pomo', 'timer', 'tasks', 'stats'];

/* ================= Segmented controls ================= */
function segSelect(seg, attr, value) {
  let on = null;
  $$('button', seg).forEach(b => { const m = b.dataset[attr] === value; b.classList.toggle('on', m); if (m) on = b; });
  placeInd(seg, on);
}
// Button positions are measured only inside a ResizeObserver callback (layout is already
// clean there), then cached, so switching tabs/modes never forces a synchronous reflow.
const segGeo = new WeakMap();
const segRO = new ResizeObserver(entries => {
  const segs = new Set(entries.map(e => e.target.closest('.seg')));
  segs.forEach(seg => {
    $$('button', seg).forEach(b => segGeo.set(b, { l: b.offsetLeft, w: b.offsetWidth }));
    placeInd(seg, $('button.on', seg));
  });
});
$$('.seg button').forEach(b => segRO.observe(b));
function placeInd(seg, btn) {
  const ind = $('.seg-ind', seg), g = btn && segGeo.get(btn);
  if (!g || !ind) return;
  ind.style.width = g.w + 'px';
  ind.style.transform = `translateX(${g.l}px)`;
}
function refreshSegs() { $$('.seg').forEach(s => placeInd(s, $('button.on', s))); }

/* ================= Navigation ================= */
function go(view) {
  if (!VIEWS.includes(view)) return;
  S.view = view;
  const idx = VIEWS.indexOf(view);
  $$('.view').forEach(v => {
    const i = VIEWS.indexOf(v.dataset.view);
    v.classList.toggle('active', i === idx);
    v.classList.toggle('before', i < idx);
  });
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === view));
  app.dataset.view = view;
  exitZen();
  if (view === 'tasks') renderTasks();
  if (view === 'stats') renderStats();
  requestAnimationFrame(refreshSegs);
  render();
  save();
}

/* ================= Pomodoro ================= */
const MODE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };
const pomoDur = m => S.settings[m] * MIN;
const pomoLeft = () => S.pomo.running ? Math.max(0, S.pomo.endTs - now()) : S.pomo.remaining;

function pomoToggle() {
  accrue();
  const p = S.pomo;
  if (p.running) { p.remaining = Math.max(0, p.endTs - now()); p.running = false; }
  else {
    if (p.remaining <= 0) p.remaining = pomoDur(p.mode);
    p.endTs = now() + p.remaining; p.running = true; unlockAudio(); askNotifyOnce();
  }
  changed();
}
function pomoReset() { accrue(); const p = S.pomo; p.running = false; p.remaining = pomoDur(p.mode); pop(pomoClock); changed(); }
function pomoSetMode(mode, start = false) {
  accrue();
  const p = S.pomo;
  p.mode = mode; p.remaining = pomoDur(mode); p.running = false;
  if (start) { p.endTs = now() + p.remaining; p.running = true; }
  pop(pomoClock); changed();
}
function pomoNext(counted) {
  const p = S.pomo;
  if (p.mode !== 'focus') return 'focus';
  return counted && p.cycle % S.settings.longEvery === 0 ? 'long' : 'short';
}
function pomoSkip() { accrue(); pomoSetMode(pomoNext(false)); }
function pomoComplete() {
  accrue();
  const p = S.pomo, was = p.mode;
  if (was === 'focus') {
    p.cycle++;
    logDay().pomos++;
    const t = task(S.activeTask);
    if (t) t.pomos = (t.pomos || 0) + 1;
  }
  const next = pomoNext(was === 'focus');
  if (next === 'focus' && was === 'long') p.cycle = 0;
  const auto = next === 'focus' ? S.settings.autoFocus : S.settings.autoBreak;
  p.mode = next; p.remaining = pomoDur(next); p.running = false;
  if (auto) { p.endTs = now() + p.remaining; p.running = true; }
  changed();
  const t = task(S.activeTask);
  alarm({
    kicker: was === 'focus' ? 'Focus complete' : 'Break over',
    title: was === 'focus' ? (next === 'long' ? 'Take a long break' : 'Take a short break') : 'Back to focus',
    sub: was === 'focus'
      ? `${logDay().pomos} pomodoro${logDay().pomos === 1 ? '' : 's'} today${t ? ' · ' + t.title : ''}`
      : (t ? 'Next up: ' + t.title : `${MODE_LABEL.focus} · ${S.settings.focus} min`),
    go: auto ? null : { label: next === 'focus' ? 'Start focus' : 'Start break', fn: () => pomoToggle() },
    accent: `var(--c-${was})`, on: `var(--on-${was})`
  });
}

/* ================= Countdown ================= */
const cdLeft = () => S.cd.running ? Math.max(0, S.cd.endTs - now()) : S.cd.remaining;
function cdToggle() {
  accrue();
  const c = S.cd;
  if (c.running) { c.remaining = Math.max(0, c.endTs - now()); c.running = false; }
  else {
    if (c.remaining <= 0) c.remaining = c.duration;
    if (c.remaining <= 0) { openTimeEditor(); return; }
    c.endTs = now() + c.remaining; c.running = true; unlockAudio(); askNotifyOnce();
  }
  changed();
}
function cdReset() { accrue(); S.cd.running = false; S.cd.remaining = S.cd.duration; pop(timerClock); changed(); }
function cdSet(ms, start = false) {
  accrue();
  const c = S.cd;
  c.duration = ms; c.remaining = ms; c.running = false;
  if (start) { c.endTs = now() + ms; c.running = true; unlockAudio(); }
  pop(timerClock); changed();
}
function cdComplete() {
  accrue();
  const c = S.cd;
  c.running = false; c.remaining = 0;
  changed();
  alarm({
    kicker: "Time's up", title: fmtPreset(c.duration) + ' done',
    sub: task(S.activeTask) && S.settings.trackTimer ? 'Tracked on ' + task(S.activeTask).title : '',
    go: { label: 'Restart', fn: () => cdSet(c.duration, true) },
    accent: 'var(--c-cd)', on: 'var(--on-cd)'
  });
}

/* ================= Stopwatch ================= */
const swElapsed = () => S.sw.acc + (S.sw.running ? now() - S.sw.startTs : 0);
function swToggle() {
  accrue();
  const w = S.sw;
  if (w.running) { w.acc += now() - w.startTs; w.running = false; }
  else { w.startTs = now(); w.running = true; }
  changed();
}
function swReset() { accrue(); Object.assign(S.sw, { running: false, acc: 0, startTs: 0, laps: [] }); pop(timerClock); changed(); renderLaps(); }
function swLap() {
  if (!S.sw.running) return;
  const e = swElapsed();
  S.sw.laps.push(e);
  renderLaps(); save(); render();
  if (navigator.vibrate && S.settings.vibrate) navigator.vibrate(15);
}
function renderLaps() {
  const laps = S.sw.laps;
  const splits = laps.map((t, i) => t - (i ? laps[i - 1] : 0));
  const best = splits.length > 2 ? Math.min(...splits) : -1, worst = splits.length > 2 ? Math.max(...splits) : -1;
  $('#laps').innerHTML = splits.map((s, i) => ({ s, i })).reverse().map(({ s, i }) =>
    `<li class="${s === best ? 'best' : s === worst ? 'worst' : ''}"><span>Lap ${i + 1}</span><span>+${fmtClock(s, true)}</span><span>${fmtClock(laps[i], true)}</span></li>`).join('');
}

/* ================= Tasks ================= */
function addTask(title) {
  title = title.trim();
  if (!title) return;
  S.tasks.unshift({ id: uid(), title, est: 0, pomos: 0, ms: 0, done: false, created: now() });
  if (!S.activeTask) S.activeTask = S.tasks[0].id;
  S.taskFilter = 'todo';
  changed(); renderTasks();
}
function setActive(id) {
  accrue();
  if (S.activeTask === id) { S.activeTask = null; S.direct = false; }
  else S.activeTask = id;
  changed(); renderTasks();
}
function taskPlay(id) {
  accrue();
  if (S.activeTask === id && S.direct) S.direct = false;
  else { S.activeTask = id; S.direct = true; unlockAudio(); }
  changed(); renderTasks();
}
function toggleDone(id, li) {
  accrue();
  const t = task(id); if (!t) return;
  t.done = !t.done; t.doneAt = t.done ? now() : 0;
  if (t.done && S.activeTask === id) { S.activeTask = null; S.direct = false; }
  if (t.done && navigator.vibrate && S.settings.vibrate) navigator.vibrate(20);
  changed();
  if (li) { li.classList.toggle('done', t.done); setTimeout(() => { li.classList.add('leaving'); setTimeout(renderTasks, 280); }, 450); }
  else renderTasks();
}
function deleteTask(id) {
  accrue();
  S.tasks = S.tasks.filter(t => t.id !== id);
  if (S.activeTask === id) { S.activeTask = null; S.direct = false; }
  changed(); renderTasks();
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" class="i-play"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="i-pause"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>',
  tomato: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 5V3M9 5.5l3 1.5 3-1.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
};

function renderTasks() {
  const todo = S.tasks.filter(t => !t.done), done = S.tasks.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  $('#cntTodo').textContent = todo.length;
  $('#cntDone').textContent = done.length;
  segSelect($('#taskFilter'), 'f', S.taskFilter);
  const list = S.taskFilter === 'done' ? done : todo;
  const tracking = isTracking();
  $('#taskList').innerHTML = list.map((t, i) => {
    const active = t.id === S.activeTask;
    const est = t.est ? `${t.pomos || 0}/${t.est}` : `${t.pomos || 0}`;
    return `<li class="task${t.done ? ' done' : ''}${active ? ' active' : ''}${active && tracking ? ' tracking' : ''}" data-id="${t.id}" style="animation-delay:${Math.min(i, 10) * 30}ms">
      <button class="check" data-act="done" aria-label="Complete">${ICON.check}</button>
      <div class="task-main" data-act="select">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta"><span>${ICON.tomato}${est}</span><span class="t-time" data-live="${t.id}">${ICON.clock}${fmtDur(t.ms)}</span></div>
      </div>
      <button class="task-play" data-act="play" aria-label="Track time">${ICON.play}${ICON.pause}</button>
      <button class="task-more" data-act="more" aria-label="More">${ICON.more}</button>
    </li>`;
  }).join('');
  const empty = !list.length;
  $('#taskEmpty').classList.toggle('show', empty);
  $('#taskEmptyText').textContent = S.taskFilter === 'done' ? 'Nothing completed yet.' : (S.tasks.length ? 'All done — nice work.' : 'No tasks yet. Add one above, then tap ▶ to track time on it.');
  $('#clearDone').classList.toggle('show', S.taskFilter === 'done' && done.length > 0);
}
function updateLiveTask() {
  if (S.view !== 'tasks' || !S.activeTask) return;
  const el = $(`[data-live="${S.activeTask}"]`);
  const t = task(S.activeTask);
  if (el && t) {
    const txt = fmtDur(t.ms);
    if (el.dataset.txt !== txt) { el.innerHTML = ICON.clock + txt; el.dataset.txt = txt; }
    const li = el.closest('.task');
    const tr = isTracking();
    if (li.classList.contains('tracking') !== tr) li.classList.toggle('tracking', tr);
  }
}

function openTaskEditor(id) {
  const t = task(id); if (!t) return;
  let est = t.est || 0;
  openSheet('Edit task', `
    <input class="field" id="edTitle" value="${esc(t.title)}" maxlength="120">
    <div class="group">
      <div class="row"><div><span class="lbl">Estimated pomodoros</span><span class="hint">${t.pomos || 0} completed · ${fmtDur(t.ms)} tracked</span></div>
        <div class="stepper"><button type="button" data-d="-1">−</button><output id="edEst">${est || '—'}</output><button type="button" data-d="1">+</button></div></div>
    </div>
    <div class="btn-row"><button class="btn ghost" id="edReset" type="button">Reset time</button><button class="btn danger" id="edDel" type="button">Delete</button></div>
    <button class="btn primary" id="edSave" type="button">Save</button>`, body => {
    $$('.stepper button', body).forEach(b => b.onclick = () => { est = clamp(est + +b.dataset.d, 0, 20); $('#edEst').textContent = est || '—'; });
    $('#edSave').onclick = () => { const v = $('#edTitle').value.trim(); if (v) t.title = v; t.est = est; changed(); renderTasks(); closeSheet(); };
    confirmBtn($('#edDel'), 'Tap to confirm', () => { deleteTask(id); closeSheet(); toast('Task deleted'); });
    confirmBtn($('#edReset'), 'Tap to confirm', () => { accrue(); t.ms = 0; t.pomos = 0; changed(); renderTasks(); closeSheet(); toast('Time reset'); });
  });
}
function taskMeta(t) {
  const p = t.pomos || 0;
  const pom = t.est ? ` · ${p}/${t.est} pomodoros` : (p ? ` · ${p} pomodoro${p > 1 ? 's' : ''}` : '');
  return `${t.ms ? fmtDur(t.ms) + ' tracked' : 'Not started'}${pom}`;
}
function openTaskPicker() {
  openSheet('What are you working on?', `
    <label class="picker-search">${ICON.search}<input id="pickQ" type="text" placeholder="Search or add a task…" maxlength="120" enterkeyhint="done" autocomplete="off"></label>
    <ul class="pick-list" id="pickList"></ul>`, body => {
    const q = $('#pickQ'), list = $('#pickList');
    const draw = () => {
      const term = q.value.trim(), lc = term.toLowerCase();
      const todo = S.tasks.filter(t => !t.done && (!lc || t.title.toLowerCase().includes(lc)))
        .sort((a, b) => (b.id === S.activeTask) - (a.id === S.activeTask));
      let html = '';
      if (term && !S.tasks.some(t => !t.done && t.title.toLowerCase() === lc))
        html += `<li><button type="button" class="pick-new" data-new><span class="radio">${ICON.plus}</span><span class="pbody"><span class="pt">Add “${esc(term)}”</span><span class="pm">New task · make it the current one</span></span></button></li>`;
      html += todo.map(t => `<li><button type="button" data-id="${t.id}" class="${t.id === S.activeTask ? 'on' : ''}"><span class="radio"></span><span class="pbody"><span class="pt">${esc(t.title)}</span><span class="pm">${taskMeta(t)}</span></span></button></li>`).join('');
      if (!todo.length && !term) html += '<li class="pick-empty">No tasks yet. Type above to add your first one.</li>';
      if (S.activeTask && !term) html += `<li><button type="button" data-id="" class="pick-none"><span class="radio"></span><span class="pbody"><span class="pt">No task</span><span class="pm">Run the timer without tracking a task</span></span></button></li>`;
      list.innerHTML = html;
    };
    const addNew = () => {
      const v = q.value.trim(); if (!v) return;
      accrue(); addTask(v); S.activeTask = S.tasks[0].id; changed(); renderTasks(); closeSheet(); toast('Task added and selected');
    };
    draw();
    q.oninput = draw;
    q.onkeydown = e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = list.querySelector('button');
      if (first && q.value.trim()) first.click(); else addNew();
    };
    list.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if ('new' in b.dataset) return addNew();
      accrue(); S.activeTask = b.dataset.id || null; if (!S.activeTask) S.direct = false;
      changed(); renderTasks(); closeSheet();
    };
    if (!S.tasks.some(t => !t.done)) setTimeout(() => q.focus(), 350);
  });
}

/* ---------- "Now working on" card (Pomodoro + Timer tabs) ---------- */
let nowKey = '';
function nowCardHTML() {
  const t = task(S.activeTask);
  if (!t) return `<button class="now-empty" type="button" data-now="pick"><span class="plus">${ICON.plus}</span><span><b>What are you working on?</b><small>Pick or add a task to track your time on it</small></span></button>`;
  const tr = isTracking();
  const pips = t.est ? `<span class="now-pips" aria-label="${t.pomos || 0} of ${t.est} pomodoros">${Array.from({ length: Math.min(t.est, 10) }, (_, i) => `<i class="${i < (t.pomos || 0) ? 'on' : ''}"></i>`).join('')}</span>`
    : (t.pomos ? `<span class="sep">·</span><span>${t.pomos} pomo${t.pomos > 1 ? 's' : ''}</span>` : '');
  return `<div class="now-card${tr ? ' tracking' : ''}">
    <button class="now-check" type="button" data-now="done" aria-label="Mark “${esc(t.title)}” as done">${ICON.check}</button>
    <button class="now-main" type="button" data-now="pick" aria-label="Change task">
      <span class="now-kicker"><i class="live"></i><span>${tr ? 'Tracking' : 'Working on'}</span><span class="sep">·</span><span>${fmtDur(t.ms)}</span>${pips}</span>
      <span class="now-title">${esc(t.title)}</span>
    </button>
    <button class="now-swap" type="button" data-now="pick" aria-label="Switch task">${ICON.swap}</button>
  </div>`;
}
function renderNow(force) {
  const t = task(S.activeTask);
  const key = t ? [t.id, t.title, t.pomos, t.est, fmtDur(t.ms), isTracking()].join('|') : 'none';
  const showTimer = S.settings.trackTimer;
  const k2 = key + showTimer;
  if (!force && k2 === nowKey) return;
  nowKey = k2;
  const html = nowCardHTML();
  $$('[data-now-slot]').forEach(slot => {
    const inTimer = !!slot.closest('[data-view="timer"]');
    slot.innerHTML = inTimer && !showTimer ? '' : html;
  });
}
function completeActive(btn) {
  const t = task(S.activeTask); if (!t) return;
  const card = btn && btn.closest('.now-card');
  if (card) card.classList.add('completing');
  if (navigator.vibrate && S.settings.vibrate) navigator.vibrate([15, 40, 25]);
  setTimeout(() => {
    accrue();
    const wasDirect = S.direct;
    t.done = true; t.doneAt = now();
    S.activeTask = null; S.direct = false;
    changed(); renderTasks();
    const name = t.title.length > 28 ? t.title.slice(0, 27) + '…' : t.title;
    toast(`Done: ${name}`, {
      action: 'Undo', fn: () => {
        accrue(); t.done = false; t.doneAt = 0; S.activeTask = t.id; S.direct = wasDirect; changed(); renderTasks();
      }
    });
  }, 420);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-now]'); if (!b) return;
  if (b.dataset.now === 'done') completeActive(b); else openTaskPicker();
});

/* ================= Theme & colours ================= */
const MODES = ['focus', 'short', 'long', 'cd', 'sw'];
const MODE_NAMES = { focus: 'Focus', short: 'Short', long: 'Long', cd: 'Timer', sw: 'Stopwatch' };
const pal5 = a => Object.fromEntries(MODES.map((m, i) => [m, a[i]]));
const PALETTES = {
  mono:   { name: 'Mono',    dark: pal5(['#ffffff', '#d9d9d9', '#b3b3b3', '#ececec', '#c7c7c7']), light: pal5(['#0a0a0a', '#333333', '#555555', '#1a1a1a', '#444444']) },
  classic:{ name: 'Classic', dark: pal5(['#ff5a4e', '#34d399', '#60a5fa', '#fbbf24', '#22d3ee']), light: pal5(['#dc2f25', '#0c8f63', '#2563eb', '#b97d00', '#0e7f9c']) },
  ocean:  { name: 'Ocean',   dark: pal5(['#38bdf8', '#2dd4bf', '#818cf8', '#7dd3fc', '#5eead4']), light: pal5(['#0369a1', '#0f766e', '#4f46e5', '#075985', '#115e59']) },
  sunset: { name: 'Sunset',  dark: pal5(['#fb7185', '#fdba74', '#f472b6', '#fcd34d', '#fb923c']), light: pal5(['#e11d48', '#c2410c', '#db2777', '#a16207', '#ea580c']) },
  forest: { name: 'Forest',  dark: pal5(['#4ade80', '#a3e635', '#86efac', '#bef264', '#34d399']), light: pal5(['#15803d', '#4d7c0f', '#166534', '#3f6212', '#047857']) },
  neon:   { name: 'Neon',    dark: pal5(['#f0abfc', '#67e8f9', '#a78bfa', '#fde047', '#f472b6']), light: pal5(['#a21caf', '#0e7490', '#6d28d9', '#854d0e', '#be185d']) }
};
const mqDark = matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () => { const t = S.settings.theme || 'auto'; return t === 'auto' ? (mqDark.matches ? 'dark' : 'light') : t; };
function hexLum(hex) {
  const h = hex.replace('#', ''); const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
}
// Pick black or white text, whichever reads better on the colour.
const onColor = hex => { const L = hexLum(hex); return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000000' : '#ffffff'; };
function paletteFor(theme) {
  const st = S.settings;
  if (st.palette === 'custom' && st.custom) return st.custom;
  return (PALETTES[st.palette] || PALETTES.mono)[theme];
}
function varsFor(theme) {
  const pal = paletteFor(theme), v = {};
  MODES.forEach(m => { v['--c-' + m] = pal[m]; v['--on-' + m] = onColor(pal[m]); });
  return v;
}
function applyTheme(animate) {
  const th = resolvedTheme(), root = document.documentElement;
  if (animate) { root.classList.add('theme-anim'); clearTimeout(applyTheme.t); applyTheme.t = setTimeout(() => root.classList.remove('theme-anim'), 450); }
  root.dataset.theme = th;
  const custom = S.settings.palette !== 'mono';
  MODES.forEach(m => { root.style.removeProperty('--c-' + m); root.style.removeProperty('--on-' + m); });
  if (custom) Object.entries(varsFor(th)).forEach(([k, v]) => root.style.setProperty(k, v));
  const meta = $('meta[name=theme-color]'); if (meta) meta.content = th === 'light' ? '#ffffff' : '#000000';
  $('#btnTheme').setAttribute('aria-label', th === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  // Remembered separately so the <head> script can paint the right theme before the app loads.
  try { localStorage.setItem('pt-theme', JSON.stringify({ pref: S.settings.theme || 'auto', vars: custom ? { dark: varsFor('dark'), light: varsFor('light') } : null })); } catch (e) { }
}
mqDark.addEventListener('change', () => { if ((S.settings.theme || 'auto') === 'auto') applyTheme(true); });
$('#btnTheme').onclick = () => {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  // If the choice matches the device, go back to following the device automatically.
  S.settings.theme = next === (mqDark.matches ? 'dark' : 'light') ? 'auto' : next;
  applyTheme(true); save();
  toast(`${next === 'dark' ? 'Dark' : 'Light'} mode${S.settings.theme === 'auto' ? ' · following your device' : ''}`);
};

/* ================= Stats ================= */
function renderStats() {
  const today = logDay();
  const goal = S.settings.goal || 8;
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const d = S.log[dayKey(now() - i * 864e5)];
    const active = d && (d.pomos > 0 || d.prod >= MIN);
    if (active) streak++;
    else if (i > 0) break;
  }
  $('#tiles').innerHTML = `
    <div class="tile"><div class="k">Focus today</div><div class="v">${fmtDur(today.focus)}</div></div>
    <div class="tile"><div class="k">Pomodoros</div><div class="v">${today.pomos}<small>/ ${goal}</small></div><div class="meter"><i style="width:${Math.min(100, today.pomos / goal * 100)}%"></i></div></div>
    <div class="tile"><div class="k">Task time</div><div class="v">${fmtDur(today.tracked)}</div></div>
    <div class="tile"><div class="k">Streak</div><div class="v">${streak}<small>day${streak === 1 ? '' : 's'}</small></div></div>`;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = now() - i * 864e5, k = dayKey(t), d = S.log[k];
    days.push({ k, t, v: d ? d.prod : 0, today: i === 0 });
  }
  const max = Math.max(MIN * 30, ...days.map(d => d.v));
  const total = days.reduce((a, d) => a + d.v, 0);
  $('#weekTotal').textContent = fmtDur(total) + ' productive';
  $('#weekBars').innerHTML = days.map((d, i) => `
    <div class="bar${d.today ? ' today' : ''}" title="${d.k}">
      <span class="val">${d.v >= MIN ? fmtDur(d.v) : ''}</span>
      <div class="col" style="height:${Math.max(2, d.v / max * 100)}%;animation-delay:${i * 50}ms"></div>
      <span class="lbl">${d.today ? 'Today' : new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' })}</span>
    </div>`).join('');

  segSelect($('#statsRange'), 'r', S.statsRange);
  const agg = {};
  if (S.statsRange === 'all') S.tasks.forEach(t => { if (t.ms) agg[t.id] = t.ms; });
  else {
    const n = S.statsRange === 'today' ? 1 : 7;
    for (let i = 0; i < n; i++) {
      const d = S.log[dayKey(now() - i * 864e5)];
      if (d) for (const [id, ms] of Object.entries(d.tasks || {})) agg[id] = (agg[id] || 0) + ms;
    }
  }
  const rows = Object.entries(agg).filter(([, ms]) => ms >= 1000).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const top = rows.length ? rows[0][1] : 1;
  $('#breakdown').innerHTML = rows.length ? rows.map(([id, ms], i) => {
    const t = task(id);
    return `<li style="animation-delay:${i * 40}ms"><span class="name">${t ? esc(t.title) : '<i class="muted">Deleted task</i>'}</span><span class="amt">${fmtDur(ms)}</span>
      <span class="track"><i style="width:${ms / top * 100}%;animation-delay:${i * 40}ms"></i></span></li>`;
  }).join('') : '<li class="none">No task time recorded for this period. Pick a task, then run a pomodoro or tap ▶ on it.</li>';
}

/* ================= Sheet ================= */
const sheetWrap = $('#sheetWrap');
let sheetClose = null;
function openSheet(title, html, mount, onClose) {
  const cs = getComputedStyle(app);
  sheetWrap.style.setProperty('--accent', cs.getPropertyValue('--accent'));
  sheetWrap.style.setProperty('--on-accent', cs.getPropertyValue('--on-accent'));
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  body.innerHTML = html;
  sheetWrap.classList.add('open');
  sheetWrap.setAttribute('aria-hidden', 'false');
  sheetClose = onClose || null;
  if (mount) mount(body);
}
function closeSheet() {
  if (!sheetWrap.classList.contains('open')) return;
  sheetWrap.classList.remove('open');
  sheetWrap.setAttribute('aria-hidden', 'true');
  if (document.activeElement) document.activeElement.blur();
  if (sheetClose) { const f = sheetClose; sheetClose = null; f(); }
}
$$('[data-close]', sheetWrap).forEach(el => el.addEventListener('click', closeSheet));
function confirmBtn(btn, msg, fn) {
  let armed = false, t;
  const orig = btn.textContent;
  btn.onclick = () => {
    if (armed) { clearTimeout(t); fn(); return; }
    armed = true; btn.textContent = msg;
    t = setTimeout(() => { armed = false; btn.textContent = orig; }, 2500);
  };
}

/* Countdown time editor */
function openTimeEditor() {
  let ms = S.cd.duration || 5 * MIN;
  let h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / MIN), s = Math.floor(ms % MIN / 1000);
  const unit = (id, v, lbl) => `<div class="unit"><button type="button" data-u="${id}" data-d="1"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
    <div class="num" id="u-${id}">${pad(v)}</div><small>${lbl}</small>
    <button type="button" data-u="${id}" data-d="-1"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button></div>`;
  const presetList = () => S.presets.map((p, i) => `<button class="chip" type="button" data-i="${i}">${fmtPreset(p)}${ICON.x}</button>`).join('');
  openSheet('Set countdown', `
    <div class="hms">${unit('h', h, 'HRS')}<span class="sep">:</span>${unit('m', m, 'MIN')}<span class="sep">:</span>${unit('s', s, 'SEC')}</div>
    <div class="btn-row"><button class="btn ghost" id="teSave" type="button">Save as preset</button><button class="btn primary" id="teStart" type="button">Start</button></div>
    <div class="group-title">Presets — tap to remove</div>
    <div class="preset-edit" id="tePresets">${presetList()}</div>`, body => {
    const lim = { h: 23, m: 59, s: 59 }, val = { h, m, s };
    const bump = (u, d) => { val[u] = (val[u] + d + lim[u] + 1) % (lim[u] + 1); $('#u-' + u).textContent = pad(val[u]); };
    $$('.unit button', body).forEach(b => {
      let rep, del;
      const stop = () => { clearTimeout(del); clearInterval(rep); };
      b.addEventListener('pointerdown', e => {
        e.preventDefault(); bump(b.dataset.u, +b.dataset.d);
        del = setTimeout(() => rep = setInterval(() => bump(b.dataset.u, +b.dataset.d), 70), 380);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stop));
    });
    const total = () => (val.h * 3600 + val.m * 60 + val.s) * 1000;
    $('#teStart').onclick = () => { const t = total(); if (!t) return toast('Set a time first'); cdSet(t, true); closeSheet(); };
    $('#teSave').onclick = () => {
      const t = total(); if (!t) return toast('Set a time first');
      if (!S.presets.includes(t)) { S.presets.push(t); S.presets.sort((a, b) => a - b); S.presets = S.presets.slice(-16); }
      cdSet(t); renderPresets(); $('#tePresets').innerHTML = presetList(); toast('Preset saved');
    };
    $('#tePresets').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      S.presets.splice(+b.dataset.i, 1); save(); renderPresets(); $('#tePresets').innerHTML = presetList();
    };
  });
}
function renderPresets() {
  $('#presets').innerHTML = S.presets.map(p => `<button class="chip${p === S.cd.duration ? ' on' : ''}" type="button" data-ms="${p}">${fmtPreset(p)}</button>`).join('')
    + '<button class="chip add" type="button" data-custom>+ Custom</button>';
}

/* Settings */
function openSettings() {
  const st = S.settings;
  const step = (key, lbl, hint, min, max, unit = '') => `<div class="row"><div><span class="lbl">${lbl}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>
    <div class="stepper" data-key="${key}" data-min="${min}" data-max="${max}" data-unit="${unit}"><button type="button" data-d="-1">−</button><output>${st[key]}${unit}</output><button type="button" data-d="1">+</button></div></div>`;
  const sw = (key, lbl, hint) => `<div class="row"><div><span class="lbl">${lbl}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>
    <label class="switch"><input type="checkbox" data-key="${key}" ${st[key] ? 'checked' : ''}><span></span></label></div>`;
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const th = resolvedTheme();
  const palBtns = () => Object.entries(PALETTES).map(([id, p]) => `<button type="button" class="pal${st.palette === id ? ' on' : ''}" data-pal="${id}"><span class="sw">${MODES.map(m => `<i style="background:${p[th][m]}"></i>`).join('')}</span>${p.name}</button>`).join('')
    + (st.custom ? `<button type="button" class="pal${st.palette === 'custom' ? ' on' : ''}" data-pal="custom"><span class="sw">${MODES.map(m => `<i style="background:${st.custom[m]}"></i>`).join('')}</span>Custom</button>` : '');
  const cur = paletteFor(th);
  openSheet('Settings', `
    <div class="group-title">Appearance</div>
    <div class="group">
      <div class="row"><div><span class="lbl">Theme</span><span class="hint">Auto follows your device</span></div>
        <div class="choice" id="setTheme">${['auto', 'light', 'dark'].map(v => `<button type="button" data-v="${v}" class="${(st.theme || 'auto') === v ? 'on' : ''}">${{ auto: 'Auto', light: 'Light', dark: 'Dark' }[v]}</button>`).join('')}</div></div>
      <div class="row col"><span class="lbl">Colour palette</span><div class="palettes" id="setPal">${palBtns()}</div></div>
      <div class="row col"><div><span class="lbl">Your colours</span><span class="hint">Tap a swatch to set the colour of each mode</span></div>
        <div class="colors" id="setColors">${MODES.map(m => `<label><input type="color" data-m="${m}" value="${cur[m]}">${MODE_NAMES[m]}</label>`).join('')}</div>
        <button type="button" class="text-link" id="setColorsReset">Reset to default (Mono)</button></div>
    </div>
    <div class="group-title">Pomodoro</div>
    <div class="group">
      ${step('focus', 'Focus', '', 1, 180, 'm')}
      ${step('short', 'Short break', '', 1, 60, 'm')}
      ${step('long', 'Long break', '', 1, 90, 'm')}
      ${step('longEvery', 'Long break after', 'focus sessions', 2, 12)}
      ${step('goal', 'Daily goal', 'pomodoros', 1, 24)}
      ${sw('autoBreak', 'Auto-start breaks')}
      ${sw('autoFocus', 'Auto-start focus')}
    </div>
    <div class="group-title">Alerts</div>
    <div class="group">
      ${sw('sound', 'Alarm sound')}
      <div class="row"><span class="lbl">Volume</span><input type="range" min="0" max="1" step="0.05" value="${st.volume}" id="setVol"></div>
      ${sw('vibrate', 'Vibrate')}
      <div class="row"><div><span class="lbl">Notifications</span><span class="hint">${notif === 'granted' ? 'Enabled' : notif === 'denied' ? 'Blocked in browser settings' : notif === 'unsupported' ? 'Not supported here' : 'Alert when the app is in background'}</span></div>
        ${notif === 'default' ? '<button class="btn ghost" id="setNotif" type="button" style="height:38px">Enable</button>' : ''}</div>
    </div>
    <div class="group-title">Behaviour</div>
    <div class="group">
      ${sw('wake', 'Keep screen on', 'While a timer is running')}
      ${sw('wakeFs', 'Keep screen on in full screen', 'Full screen or installed app, even when idle')}
      ${sw('trackTimer', 'Track Timer tab to task', 'Countdown & stopwatch add time to the active task')}
    </div>
    <div class="group-title">Data (stored on this device)</div>
    <div class="btn-row"><button class="btn ghost" id="setExport" type="button">Export</button><button class="btn ghost" id="setImport" type="button">Import</button></div>
    <button class="btn danger" id="setWipe" type="button">Erase all data</button>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
    <p class="muted" style="text-align:center;padding:4px 0 8px">Space: start/pause · R: reset · 1–4: tabs · F: full screen</p>`, body => {
    const refreshColors = () => {
      $('#setPal').innerHTML = palBtns();
      const c = paletteFor(resolvedTheme());
      $$('#setColors input', body).forEach(i => { i.value = c[i.dataset.m]; });
    };
    $('#setTheme').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      st.theme = b.dataset.v; applyTheme(true); save();
      $$('#setTheme button').forEach(x => x.classList.toggle('on', x === b));
      refreshColors();
    };
    $('#setPal').onclick = e => {
      const b = e.target.closest('.pal'); if (!b) return;
      st.palette = b.dataset.pal; applyTheme(true); save(); refreshColors();
      sheetWrap.style.setProperty('--accent', getComputedStyle(app).getPropertyValue('--accent'));
    };
    $$('#setColors input', body).forEach(inp => {
      inp.oninput = () => {
        const base = { ...paletteFor(resolvedTheme()) };
        base[inp.dataset.m] = inp.value;
        st.custom = base; st.palette = 'custom';
        applyTheme(); save();
      };
      inp.onchange = refreshColors;
    });
    $('#setColorsReset').onclick = () => { st.palette = 'mono'; st.custom = null; applyTheme(true); save(); refreshColors(); toast('Colours reset'); };
    $$('.stepper', body).forEach(sp => {
      const k = sp.dataset.key, min = +sp.dataset.min, max = +sp.dataset.max, unit = sp.dataset.unit;
      $$('button', sp).forEach(b => b.onclick = () => {
        const old = st[k];
        st[k] = clamp(st[k] + +b.dataset.d, min, max);
        $('output', sp).textContent = st[k] + unit;
        const p = S.pomo;
        if (['focus', 'short', 'long'].includes(k) && p.mode === k && !p.running && p.remaining === old * MIN) p.remaining = st[k] * MIN;
        changed();
      });
    });
    $$('.switch input', body).forEach(i => i.onchange = () => { accrue(); st[i.dataset.key] = i.checked; changed(); renderNow(true); });
    $('#setVol').oninput = e => { st.volume = +e.target.value; save(); };
    $('#setVol').onchange = () => { unlockAudio(); beep(1); };
    const nb = $('#setNotif');
    if (nb) nb.onclick = async () => { await Notification.requestPermission(); openSettings(); };
    $('#setExport').onclick = exportData;
    $('#setImport').onclick = () => $('#importFile').click();
    $('#importFile').onchange = importData;
    confirmBtn($('#setWipe'), 'Tap again to erase everything', () => {
      localStorage.removeItem(KEY); S = DEFAULTS(); saveNow(); closeSheet(); boot(); toast('All data erased');
    });
  });
}
function exportData() {
  saveNow();
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `productivity-timer-${dayKey()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.tasks) || !d.settings) throw 0;
      localStorage.setItem(KEY, JSON.stringify(d));
      S = load(); closeSheet(); boot(); toast('Data imported');
    } catch (err) { toast('That file is not a valid backup'); }
  };
  r.readAsText(f);
}

/* ================= Alarm, sound, vibration, notifications ================= */
let actx = null, alarmRepeat = 0, alarmGo = null;
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { /* no audio */ }
}
function tone(t, dur, f, vol) {
  const o = actx.createOscillator(), g = actx.createGain(), lp = actx.createBiquadFilter();
  o.type = 'square'; o.frequency.value = f;
  lp.type = 'lowpass'; lp.frequency.value = 3500;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.005);
  g.gain.setValueAtTime(vol, t + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(lp).connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
function beep(n = 4) {
  if (!S.settings.sound || !actx) return;
  const vol = S.settings.volume * 0.22, t0 = actx.currentTime + 0.02;
  for (let i = 0; i < n; i++) tone(t0 + i * 0.13, 0.08, 2093, vol);
}
function alarm(o) {
  $('#alarmKicker').textContent = o.kicker;
  $('#alarmTitle').textContent = o.title;
  $('#alarmSub').textContent = o.sub || '';
  const el = $('#alarm');
  el.style.setProperty('--accent', o.accent || 'var(--accent)');
  el.style.setProperty('--on-accent', o.on || 'var(--on-accent)');
  alarmGo = o.go ? o.go.fn : null;
  $('#alarmGo').style.display = o.go ? '' : 'none';
  if (o.go) $('#alarmGo').textContent = o.go.label;
  el.classList.add('open'); el.setAttribute('aria-hidden', 'false');
  unlockAudio();
  let n = 0;
  clearInterval(alarmRepeat);
  beep();
  alarmRepeat = setInterval(() => { if (++n >= 8) clearInterval(alarmRepeat); else beep(); }, 1300);
  if (S.settings.vibrate && navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
  notify(o.title, o.sub || o.kicker);
}
function stopAlarm() {
  clearInterval(alarmRepeat);
  const el = $('#alarm');
  el.classList.remove('open'); el.setAttribute('aria-hidden', 'true');
  if (navigator.vibrate) navigator.vibrate(0);
}
$('#alarmDismiss').onclick = stopAlarm;
$('#alarmGo').onclick = () => { const f = alarmGo; stopAlarm(); if (f) f(); };

let notifyAsked = false;
function askNotifyOnce() {
  if (notifyAsked || !('Notification' in window) || Notification.permission !== 'default') return;
  notifyAsked = true;
  try { Notification.requestPermission(); } catch (e) { }
}
function notify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'ptimer', renotify: true, vibrate: [250, 120, 250] };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(() => { });
  else try { new Notification(title, opts); } catch (e) { }
}

/* Wake lock */
let wakeLock = null;
async function syncWake() {
  const want = !document.hidden && ((S.settings.wake && anyRunning()) || (S.settings.wakeFs && inFullscreen()));
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
const anyRunning = () => S.pomo.running || S.cd.running || S.sw.running || (S.direct && !!task(S.activeTask));

/* Toast */
let toastT = 0;
function toast(msg, opt) {
  const t = $('#toast');
  t.innerHTML = '';
  const m = document.createElement('span'); m.className = 'toast-msg'; m.textContent = msg; t.append(m);
  const act = opt && opt.action;
  if (act) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = act;
    b.onclick = () => { t.classList.remove('show'); opt.fn(); };
    t.append(b);
  }
  t.classList.toggle('has-act', !!act);
  t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), act ? 5000 : 2200);
}
function pop(c) { c.el.classList.remove('pop'); requestAnimationFrame(() => requestAnimationFrame(() => c.el.classList.add('pop'))); }

/* Zen */
let zenHinted = false;
function toggleZen() {
  const on = !app.classList.contains('zen');
  app.classList.toggle('zen', on);
  if (on) {
    // Entering focus mode also goes full screen (where the browser allows it).
    if (fsOK && !fsEl() && !standalone) { try { toggleFs(); } catch (e) { } }
    if (!zenHinted) { zenHinted = true; toast('Tap anywhere to show the controls'); }
  }
}
function exitZen() { app.classList.remove('zen'); }

/* ================= Render ================= */
function changed() { save(); render(); syncWake(); }

function render() {
  const p = S.pomo;
  app.dataset.mode = p.mode;
  app.dataset.tmode = S.timerMode;
  const at = task(S.activeTask);
  const tracking = isTracking();

  renderNow();

  // pomodoro
  const pl = pomoLeft();
  setClock(pomoClock, fmtClock(pl));
  pomoClock.el.classList.toggle('running', p.running);
  pomoClock.el.classList.toggle('paused', !p.running && pl < pomoDur(p.mode) && pl > 0);
  setBar(pomoBar, pl / pomoDur(p.mode));
  $('#pomoPlay').classList.toggle('running', p.running);
  $('#pomoPlay').setAttribute('aria-label', p.running ? 'Pause' : 'Start');
  segSelect($('#pomoModes'), 'mode', p.mode);
  const N = S.settings.longEvery, inSet = p.cycle % N, full = p.mode === 'long' && p.cycle > 0 && inSet === 0;
  const dots = $('#pomoDots');
  if (dots.children.length !== N) dots.innerHTML = '<i></i>'.repeat(N);
  [...dots.children].forEach((d, i) => {
    d.classList.toggle('done', full || i < inSet);
    d.classList.toggle('cur', !full && i === inSet && p.mode === 'focus' && p.running);
  });
  const status = p.mode === 'focus'
    ? (p.running ? 'Stay with it' : 'Ready to focus')
    : (p.mode === 'short' ? 'Stretch, breathe, hydrate' : 'Step away for a while');
  const ps = $('#pomoStatus');
  if (ps.dataset.h !== status) { ps.innerHTML = status; ps.dataset.h = status; }

  // timer view
  const isSw = S.timerMode === 'sw';
  $('.view[data-view="timer"]').classList.toggle('sw-mode', isSw);
  segSelect($('#timerModes'), 'mode', S.timerMode);
  if (isSw) {
    const e = swElapsed();
    setClock(timerClock, fmtClock(e, true));
    timerClock.el.classList.toggle('running', S.sw.running);
    timerClock.el.classList.toggle('paused', !S.sw.running && e > 0);
    setBar(timerBar, (e % MIN) / MIN);
    $('#timerPlay').classList.toggle('running', S.sw.running);
    $('#timerAux').disabled = !S.sw.running;
    $('#timerAux').setAttribute('aria-label', 'Lap');
    setStatus('#timerStatus', S.sw.laps.length ? `${S.sw.laps.length} lap${S.sw.laps.length > 1 ? 's' : ''}` : (S.sw.running ? 'Running' : (e ? 'Paused' : 'Tap play to start')));
  } else {
    const l = cdLeft(), c = S.cd;
    setClock(timerClock, fmtClock(l));
    timerClock.el.classList.toggle('running', c.running);
    timerClock.el.classList.toggle('paused', !c.running && l > 0 && l < c.duration);
    setBar(timerBar, c.duration ? l / c.duration : 0);
    $('#timerPlay').classList.toggle('running', c.running);
    $('#timerAux').disabled = false;
    $('#timerAux').setAttribute('aria-label', 'Set time');
    $$('#presets .chip[data-ms]').forEach(ch => ch.classList.toggle('on', +ch.dataset.ms === c.duration));
    setStatus('#timerStatus', c.running ? `Ends at ${new Date(c.endTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : (l < c.duration && l > 0 ? 'Paused' : fmtPreset(c.duration) + ' timer'));
  }
  $('#timerPlay').setAttribute('aria-label', $('#timerPlay').classList.contains('running') ? 'Pause' : 'Start');

  // title
  let title = 'Productivity Timer';
  if (p.running) title = `${fmtClock(pl)} · ${MODE_LABEL[p.mode]}`;
  else if (S.cd.running) title = `${fmtClock(cdLeft())} · Timer`;
  else if (S.sw.running) title = `${fmtClock(swElapsed(), true)} · Stopwatch`;
  if (document.title !== title) document.title = title;
}
function setStatus(sel, txt) { const el = $(sel); if (el.textContent !== txt) el.textContent = txt; }

/* ================= Tick ================= */
let lastStats = 0;
function tick() {
  const t = now();
  if (S.pomo.running && t >= S.pomo.endTs) pomoComplete();
  if (S.cd.running && t >= S.cd.endTs) cdComplete();
  accrue();
  render();
  updateLiveTask();
  if (S.view === 'stats' && t - lastStats > 10e3 && !document.hidden) { lastStats = t; renderStats(); }
  if (anyRunning()) save();
}

/* ================= Events ================= */
$('#nav').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.go); };
$('#pomoModes').onclick = e => { const b = e.target.closest('button'); if (b && b.dataset.mode !== S.pomo.mode) pomoSetMode(b.dataset.mode); };
$('#pomoPlay').onclick = pomoToggle;
$('#pomoReset').onclick = pomoReset;
$('#pomoSkip').onclick = pomoSkip;

$('#timerModes').onclick = e => {
  const b = e.target.closest('button'); if (!b || b.dataset.mode === S.timerMode) return;
  S.timerMode = b.dataset.mode; timerClock.shape = null; pop(timerClock); changed(); renderLaps();
};
$('#timerPlay').onclick = () => S.timerMode === 'sw' ? swToggle() : cdToggle();
$('#timerReset').onclick = () => S.timerMode === 'sw' ? swReset() : cdReset();
$('#timerAux').onclick = () => S.timerMode === 'sw' ? swLap() : openTimeEditor();
$('#presets').onclick = e => {
  const b = e.target.closest('.chip'); if (!b) return;
  if ('custom' in b.dataset) openTimeEditor(); else cdSet(+b.dataset.ms);
};

['#pomoStage', '#timerStage'].forEach(s => $(s).addEventListener('click', toggleZen));
document.addEventListener('click', e => {
  if (app.classList.contains('zen') && !e.target.closest('.stage')) exitZen();
}, true);

$('#addTask').onsubmit = e => { e.preventDefault(); const i = $('#newTask'); addTask(i.value); i.value = ''; };
$('#taskFilter').onclick = e => { const b = e.target.closest('button'); if (b) { S.taskFilter = b.dataset.f; save(); renderTasks(); } };
$('#taskList').onclick = e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const li = el.closest('.task'), id = li.dataset.id;
  ({ done: () => toggleDone(id, li), select: () => setActive(id), play: () => taskPlay(id), more: () => openTaskEditor(id) })[el.dataset.act]();
};
$('#clearDone').onclick = () => { S.tasks = S.tasks.filter(t => !t.done); changed(); renderTasks(); toast('Completed tasks cleared'); };
$('#statsRange').onclick = e => { const b = e.target.closest('button'); if (b) { S.statsRange = b.dataset.r; save(); renderStats(); } };
$('#btnSettings').onclick = openSettings;

/* Fullscreen */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsOK = document.fullscreenEnabled || document.webkitFullscreenEnabled;
const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
const inFullscreen = () => !!fsEl() || !!standalone;
if (!fsOK || standalone) $('#btnFullscreen').style.display = 'none';
function toggleFs() {
  if (!fsOK) return;
  if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
  }
}
$('#btnFullscreen').onclick = toggleFs;

/* Install button: Chrome only shows its own install banner occasionally, so offer one in the app. */
let installEvt = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const btnInstall = $('#btnInstall');
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e;
  btnInstall.hidden = false;
  if (!S.installHinted) { S.installHinted = true; save(); setTimeout(() => toast('Tap the download icon to install the app'), 2500); }
});
addEventListener('appinstalled', () => { installEvt = null; btnInstall.hidden = true; toast('Installed — open it from your home screen'); });
if (isIOS && !standalone) btnInstall.hidden = false;
btnInstall.onclick = async () => {
  if (installEvt) {
    installEvt.prompt();
    const r = await installEvt.userChoice.catch(() => ({}));
    installEvt = null;
    if (r.outcome === 'accepted') btnInstall.hidden = true;
  } else if (isIOS) {
    openSheet('Install on iPhone', `<ol class="steps">
      <li><span>Open this page in <b>Safari</b>.</span></li>
      <li><span>Tap the <b>Share</b> button <svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>.</span></li>
      <li><span>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</span></li>
      <li><span>Open <b>Focus</b> from your home screen. It runs full screen and works offline.</span></li>
    </ol>`);
  } else {
    toast('Use your browser menu → Install app');
  }
};
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, () => { app.classList.toggle('is-fs', !!fsEl()); syncWake(); }));

/* Keyboard */
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === 'Escape') { if ($('#alarm').classList.contains('open')) stopAlarm(); else if (sheetWrap.classList.contains('open')) closeSheet(); else exitZen(); return; }
  if (sheetWrap.classList.contains('open') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#alarm').classList.contains('open') && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); $('#alarmGo').style.display !== 'none' ? $('#alarmGo').click() : stopAlarm(); return; }
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); if (S.view === 'timer') $('#timerPlay').click(); else pomoToggle(); }
  else if (k === 'r') { if (S.view === 'timer') $('#timerReset').click(); else pomoReset(); }
  else if (k === 'l' && S.view === 'timer' && S.timerMode === 'sw') swLap();
  else if (k === 'f') toggleFs();
  else if (k === 'z') toggleZen();
  else if ('1234'.includes(k)) go(VIEWS[+k - 1]);
});

/* Resize / orientation */
// Sizes are tracked by ResizeObservers (clock stages + segmented buttons), which also cover rotation.

/* Lifecycle */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { accrue(); saveNow(); }
  else { tick(); if (S.view === 'stats') renderStats(); }
  syncWake();
});
addEventListener('pagehide', () => { accrue(); saveNow(); });
addEventListener('storage', e => { if (e.key === KEY && e.newValue) { S = load(); boot(); } });

/* ================= Boot ================= */
function boot() {
  applyTheme();
  nowKey = '';
  pomoClock.shape = timerClock.shape = null;
  pomoClock.str = timerClock.str = null;
  renderPresets();
  renderLaps();
  renderTasks();
  go(S.view || 'pomo');
  tick();
  syncWake();
}
boot();
setInterval(tick, 250);
if (!S.hintShown) setTimeout(() => { toast('Tip: tap the clock for distraction-free mode'); S.hintShown = true; save(); }, 1500);

/* Service worker (offline + installable) */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
}
})();
