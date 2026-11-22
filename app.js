'use strict';
/* Expenses — offline expense tracker (Phase 1)
   All data stays in this phone's browser storage (IndexedDB). Nothing is uploaded.
   Export creates a ZIP for the laptop Sync helper. */

const APP_VERSION = '1.1.0';
const SCHEMA = 1;

/* ---------- Your setup (edit here if wallets or categories change) ---------- */
const CFG = {
  defaultWallet: 'TNG',
  wallets: [
    { id: 'TNG', kind: 'spend' }, { id: 'Wise', kind: 'spend' }, { id: 'TNG Card', kind: 'spend' },
    { id: 'Cash', kind: 'spend' }, { id: 'Unifi', kind: 'spend' }, { id: 'Maybank', kind: 'spend' },
    { id: 'Ambank', kind: 'spend' }, { id: 'FD', kind: 'savings' }
  ],
  expenseCats: ['Food', 'Groceries', 'Transportation', 'Utilities & Bills', 'Personal Care',
    'Clothing & Accessories', 'Entertainment & Leisure', 'Gifts & Donations', 'Online Shopping',
    'Etc.', 'Miscellaneous'],
  incomeCats: ['Income', 'TNG Reward', 'Interest', 'Refund', 'Other Income'],
  quickCats: 6,            // category chips shown before "More"
  fillAfter: 2,            // auto-fill once the same choice was made this many times in a row
  remindDays: 7,           // remind to export after this many days
  photoDays: 30            // every export re-sends photos from this many recent days (plus any never sent)
};
const SPEND_WALLETS = CFG.wallets.filter(w => w.kind === 'spend').map(w => w.id);
const ALL_WALLETS = CFG.wallets.map(w => w.id);

/* ---------- Small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const fmt = n => r2(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => localDate(new Date());
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return localDate(d); };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = s => { const d = parseDate(s); return `${DOW[d.getDay()].slice(0, 3)} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeName = s => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Receipt';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
// Pop-up with Cancel (left) and an action (right). Resolves true only if the action is tapped.
// armMs keeps the action disabled briefly, so a fast double tap can't go through two pop-ups at once.
function ask({ title, lines = [], ok = 'OK', danger = false, armMs = 0 }) {
  return new Promise(res => {
    let yes = false;
    const okBtn = h('button', { class: 'btn grow ' + (danger ? 'danger solid' : 'primary'), type: 'button', disabled: armMs > 0, onclick: () => { yes = true; dlg.close(); } }, ok);
    const dlg = h('dialog', { class: 'ask' }, h('b', {}, title),
      lines.filter(Boolean).map(t => h('p', { class: 'small' + (t.startsWith('·') ? ' muted' : '') }, t.replace(/^·\s*/, ''))),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn grow', type: 'button', onclick: () => dlg.close() }, 'Cancel'), okBtn));
    dlg.addEventListener('close', () => { dlg.remove(); res(yes); });
    document.body.append(dlg); dlg.showModal();
    if (armMs > 0) setTimeout(() => { okBtn.disabled = false; }, armMs);
  });
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- Storage (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('expenses-app', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('entries', { keyPath: 'id' });
        d.createObjectStore('receipts', { keyPath: 'name' });
        d.createObjectStore('meta');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode); const s = t.objectStore(store);
      let out; const r = fn(s); if (r) r.onsuccess = () => (out = r.result);
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all: s => DB.tx(s, 'readonly', st => st.getAll()),
  get: (s, k) => DB.tx(s, 'readonly', st => st.get(k)),
  put: (s, v, k) => DB.tx(s, 'readwrite', st => (k === undefined ? st.put(v) : st.put(v, k))),
  del: (s, k) => DB.tx(s, 'readwrite', st => st.delete(k)),
  clear: s => DB.tx(s, 'readwrite', st => st.clear())
};

/* ---------- App state ---------- */
const S = {
  entries: [],            // all entries
  receipts: new Map(),    // name -> {name, entryId, exported, added}
  settings: null,
  tab: 'add'
};
const DEFAULT_SETTINGS = () => ({
  opening: Object.fromEntries(ALL_WALLETS.map(w => [w, 0])),
  openingSet: false, lastExportAt: null, lastFullBackupAt: null, changedSinceExport: false
});
async function saveSettings() { await DB.put('meta', S.settings, 'settings'); }
async function markChanged() { S.settings.changedSinceExport = true; await saveSettings(); }

async function load() {
  await DB.open();
  S.settings = Object.assign(DEFAULT_SETTINGS(), (await DB.get('meta', 'settings')) || {});
  for (const w of ALL_WALLETS) if (!(w in S.settings.opening)) S.settings.opening[w] = 0;
  S.entries = await DB.all('entries');
  const recs = await DB.all('receipts');
  S.receipts = new Map(recs.map(r => [r.name, { name: r.name, entryId: r.entryId, exported: !!r.exported, added: r.added || '' }]));
}

/* ---------- Money logic ---------- */
function effects(e) {
  const a = num(e.amount);
  switch (e.type) {
    case 'expense': return { [e.wallet]: -a };
    case 'income': return { [e.wallet]: a };
    case 'transfer': return { [e.from]: -a, [e.to]: a };
    case 'adjust': return { [e.wallet]: a };
  }
  return {};
}
function balances() {
  const b = Object.assign({}, S.settings.opening);
  for (const e of S.entries) for (const [w, d] of Object.entries(effects(e))) b[w] = r2((b[w] || 0) + d);
  return b;
}
const itemTotal = it => r2(num(it.qty || 1) * num(it.unit));
// expense lines as [{category, amount, saved}] (items, or the whole entry)
function expenseLines(e) {
  if (e.type !== 'expense') return [];
  if (e.items && e.items.length) return e.items.map(it => ({
    category: it.category || e.category, amount: itemTotal(it),
    saved: it.orig != null && num(it.orig) > num(it.unit) ? r2((num(it.orig) - num(it.unit)) * num(it.qty || 1)) : 0
  }));
  return [{ category: e.category, amount: num(e.amount), saved: 0 }];
}
function sortEntries(list) {
  return list.slice().sort((a, b) => (b.date + (b.time || '99:99') + b.created).localeCompare(a.date + (a.time || '99:99') + a.created));
}

/* ---------- Suggestions (learned from your history) ---------- */
function storeIndex() {
  const idx = new Map();
  const chron = S.entries.filter(e => e.type === 'expense' && e.store)
    .sort((a, b) => (a.date + (a.time || '') + a.created).localeCompare(b.date + (b.time || '') + b.created));
  for (const e of chron) {
    const k = norm(e.store);
    if (!idx.has(k)) idx.set(k, { name: e.store, count: 0, spent: 0, wallets: [], cats: [], items: new Map(), last: '' });
    const s = idx.get(k);
    s.name = e.store; s.count++; s.spent += num(e.amount); s.last = e.date;
    s.wallets.push(e.wallet);
    s.cats.push(e.items && e.items.length ? e.items[0].category : e.category);
    for (const it of e.items || []) {
      const ik = norm(it.name);
      if (!s.items.has(ik)) s.items.set(ik, { name: it.name, hist: [] });
      const r = s.items.get(ik); r.name = it.name;
      r.hist.push({ unit: num(it.unit), orig: it.orig, category: it.category, date: e.date, store: e.store });
    }
  }
  return idx;
}
// value repeated in the last N picks -> fill it in
function repeated(arr, n = CFG.fillAfter) {
  if (arr.length < n) return null;
  const tail = arr.slice(-n);
  return tail.every(v => v === tail[0]) ? tail[0] : null;
}
function globalItems() {
  const m = new Map();
  for (const s of storeIndex().values()) for (const [k, it] of s.items) {
    if (!m.has(k)) m.set(k, { name: it.name, hist: [] });
    m.get(k).hist.push(...it.hist);
  }
  for (const it of m.values()) it.hist.sort((a, b) => a.date.localeCompare(b.date));
  return m;
}
function quickShortcuts() {
  // combos used 2+ times around this time of day (±90 min)
  const now = new Date(); const mins = now.getHours() * 60 + now.getMinutes();
  const combos = new Map();
  for (const e of S.entries) {
    if (e.type !== 'expense' || (e.items && e.items.length) || !e.time || !e.store) continue;
    const [hh, mm] = e.time.split(':').map(Number);
    if (Math.abs(hh * 60 + mm - mins) > 90) continue;
    const k = [norm(e.store), e.wallet, e.category, r2(e.amount)].join('|');
    if (!combos.has(k)) combos.set(k, { store: e.store, wallet: e.wallet, category: e.category, amount: r2(e.amount), n: 0 });
    combos.get(k).n++;
  }
  return [...combos.values()].filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
}
function transferPairs() {
  const m = new Map();
  for (const e of S.entries) if (e.type === 'transfer') {
    const k = e.from + '→' + e.to;
    if (!m.has(k)) m.set(k, { from: e.from, to: e.to, n: 0, amounts: new Map() });
    const p = m.get(k); p.n++; p.amounts.set(r2(e.amount), (p.amounts.get(r2(e.amount)) || 0) + 1);
  }
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 4);
}

/* ---------- Receipts ---------- */
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const max = 1600, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', 0.72));
}
function receiptName(date, store, entryId) {
  const base = `${date.replace(/-/g, '')} (${safeName(store)})`;
  let n = 1, name = base + '.jpg';
  while (S.receipts.has(name) && S.receipts.get(name).entryId !== entryId) { n++; name = `${base} ${n}.jpg`; }
  return name;
}
const receiptPath = name => `receipts/${name.slice(0, 4)}/${name}`;

/* ---------- Receipt photo viewer: pinch to zoom, drag, double-tap, rotate (view only) ---------- */
let VIEWER = null;
async function openViewer(name, blob, label) {
  closeViewer();
  if (!blob && name) { const r = await DB.get('receipts', name); blob = r && r.blob; }
  if (!blob) { toast('That photo is not on this phone'); return; }
  const url = URL.createObjectURL(blob);
  const img = h('img', { alt: 'Receipt photo', draggable: 'false' });
  const hint = h('div', { class: 'vhint' }, 'Pinch to zoom · drag to move · double-tap');
  const stage = h('div', { class: 'vstage' }, img, hint);
  let s = 1, x = 0, y = 0, rot = 0, g = null, lastTap = 0, lastXY = null;
  const pts = new Map();
  const el = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Receipt photo' },
    h('div', { class: 'vbar' },
      h('button', { type: 'button', 'aria-label': 'Back', onclick: () => handleBack() }, '‹'),
      h('span', {}, label || name || 'Receipt photo'),
      h('button', { type: 'button', 'aria-label': 'Rotate', onclick: () => { rot = (rot + 90) % 360; fit(); } }, '⟳')),
    stage);
  const apply = () => { img.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px) rotate(${rot}deg) scale(${s})`; };
  function fit() {   // whole photo fits the screen at scale 1
    const W = stage.clientWidth, H = stage.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh || !W || !H) return;
    const base = rot % 180 ? Math.min(W / nh, H / nw) : Math.min(W / nw, H / nh);
    img.style.width = nw * base + 'px'; img.style.height = nh * base + 'px';
    s = 1; x = 0; y = 0; apply();
  }
  function zoomAt(mx, my, ns, from) {   // zoom so the photo point under (mx, my) stays under it
    const r = stage.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    ns = Math.min(5, Math.max(1, ns));
    const px = (mx - cx - from.x) / from.s, py = (my - cy - from.y) / from.s;
    x = mx - cx - px * ns; y = my - cy - py * ns; s = ns;
    if (s === 1) { x = 0; y = 0; }
  }
  function begin() {
    const p = [...pts.values()];
    if (p.length >= 2) g = { type: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2, s, x, y };
    else if (p.length === 1) g = { type: 'pan', sx: p[0].x, sy: p[0].y, x, y, moved: !!(g && g.type === 'pinch') };
    else g = null;
  }
  stage.addEventListener('pointerdown', ev => {
    stage.setPointerCapture(ev.pointerId); hint.hidden = true;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); begin();
  });
  stage.addEventListener('pointermove', ev => {
    if (!pts.has(ev.pointerId) || !g) return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const p = [...pts.values()];
    if (g.type === 'pinch' && p.length >= 2) {
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
      zoomAt(g.mx, g.my, g.s * d / g.d, g);
      if (s > 1) { x += mx - g.mx; y += my - g.my; }
      apply();
    } else if (g.type === 'pan') {
      const dx = ev.clientX - g.sx, dy = ev.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
      if (s > 1) { x = g.x + dx; y = g.y + dy; apply(); }
    }
  });
  const end = ev => {
    const was = g;
    pts.delete(ev.pointerId);
    if (ev.type === 'pointerup' && was && was.type === 'pan' && !was.moved && !pts.size) {
      const now = Date.now();
      if (now - lastTap < 300 && lastXY && Math.hypot(ev.clientX - lastXY.x, ev.clientY - lastXY.y) < 30) {
        if (s > 1.01) { s = 1; x = 0; y = 0; } else zoomAt(ev.clientX, ev.clientY, 2.5, { s, x, y });
        apply(); lastTap = 0;
      } else { lastTap = now; lastXY = { x: ev.clientX, y: ev.clientY }; }
    }
    begin();
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  img.onload = fit; img.src = url;
  addEventListener('resize', fit);
  document.body.append(el); document.body.classList.add('viewing');
  VIEWER = { close() { removeEventListener('resize', fit); URL.revokeObjectURL(url); el.remove(); document.body.classList.remove('viewing'); } };
}
function closeViewer() { if (VIEWER) { VIEWER.close(); VIEWER = null; } }

/* ---------- Navigation ---------- */
let REPAINT = [];   // light refreshers for chip groups (avoid full re-render while typing)
const TITLES = { add: 'Add', history: 'History', summary: 'Summary', wallets: 'Wallets' };
// keep = redraw the same screen without jumping back to the top (adding an item, picking a photo, ...)
function go(tab, keep = false) {
  const y = window.scrollY, same = tab === S.tab;
  S.tab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const editing = tab === 'add' && F && F.id;
  $('#title').textContent = editing ? 'Edit entry' : TITLES[tab];
  $('#back').hidden = !editing;
  REPAINT = [];
  const m = $('#main'); m.innerHTML = '';
  ({ add: renderAdd, history: renderHistory, summary: renderSummary, wallets: renderWallets })[tab](m);
  window.scrollTo(0, keep && same ? y : 0);
}

/* ---------- Add / Edit ---------- */
let F = null;   // form state
function blankForm(type = 'expense') {
  return {
    id: null, type, date: todayStr(), time: nowTime(), store: '', wallet: CFG.defaultWallet,
    from: 'Maybank', to: 'TNG', amount: '', category: '', items: [], note: '',
    receiptBlob: null, receiptName: null, removeReceipt: false,
    guessed: new Set(), touched: new Set(), created: null
  };
}
function formFromEntry(e) {
  const f = blankForm(e.type === 'adjust' ? 'income' : e.type);
  Object.assign(f, {
    id: e.id, type: e.type, date: e.date, time: e.time || '', store: e.store || '', wallet: e.wallet || CFG.defaultWallet,
    from: e.from || 'Maybank', to: e.to || 'TNG', amount: String(e.amount ?? ''), category: e.category || '',
    items: (e.items || []).map(it => ({ ...it, qty: String(it.qty ?? 1), unit: String(it.unit ?? ''), orig: it.orig == null ? '' : String(it.orig), key: uid() })),
    note: e.note || '', receiptName: e.receipt || null, created: e.created
  });
  f.touched = new Set(['wallet', 'category', 'store', 'amount']);
  f.snap = formSnap(f);
  return f;
}
const formSnap = f => JSON.stringify([f.type, f.date, f.time, f.store, f.wallet, f.from, f.to, f.amount, f.category, f.note,
  f.items.map(i => [i.name, i.qty, i.unit, i.orig, i.category]), !!f.receiptBlob, !!f.removeReceipt]);
// Has the user typed something that Back would throw away?
function formDirty() {
  if (!F) return false;
  if (F.id) return formSnap(F) !== F.snap;
  return !!(F.store.trim() || num(F.amount) || F.items.length || F.note.trim() || F.receiptBlob);
}
function computedTotal() { return r2(F.items.reduce((s, it) => s + itemTotal(it), 0)); }

function renderAdd(m) {
  if (!F) F = blankForm();
  const isEdit = !!F.id;
  // banners
  if (!S.settings.openingSet && !isEdit)
    m.append(h('div', { class: 'banner info' }, 'Start by entering your opening wallet balances. ',
      h('button', { class: 'btn link', onclick: () => go('wallets') }, 'Go to Wallets')));
  if (needsExportReminder() && !isEdit)
    m.append(h('div', { class: 'banner' }, 'You have entries that are not exported yet. ',
      h('button', { class: 'btn link', onclick: () => go('wallets') }, 'Export now')));

  const card = h('div', { class: 'card' });
  m.append(card);

  if (F.type === 'adjust') {
    card.append(h('p', {}, h('b', {}, 'Balance adjustment'), ` for ${F.wallet}: RM ${fmt(num(F.amount))}`),
      h('p', { class: 'muted small' }, 'Created by Reconcile. You can change the date or note, or delete it.'));
  } else {
    // type switch
    const seg = h('div', { class: 'seg', role: 'tablist' },
      ['expense', 'income', 'transfer'].map(t => h('button', {
        class: F.type === t ? 'on' : '', type: 'button',
        onclick: () => { if (F.type !== t) { F.type = t; F.guessed.clear(); go('add', true); } }
      }, t[0].toUpperCase() + t.slice(1))));
    card.append(seg);
  }

  // shortcuts
  if (!isEdit && F.type === 'expense' && !F.store && !F.amount && !F.items.length) {
    const sc = quickShortcuts();
    if (sc.length) card.append(h('span', { class: 'lbl' }, 'Usual at this time'),
      h('div', { class: 'chips' }, sc.map(c => h('button', {
        class: 'chip small', type: 'button', onclick: () => {
          Object.assign(F, { store: c.store, wallet: c.wallet, category: c.category, amount: String(c.amount) });
          F.guessed = new Set(['store', 'wallet', 'category', 'amount']); go('add', true);
        }
      }, `${c.store} ${fmt(c.amount)} · ${c.wallet}`))));
  }

  // date
  card.append(h('span', { class: 'lbl' }, 'Date'));
  const t = todayStr(), y = addDays(t, -1);
  const dateInput = h('input', { type: 'date', value: F.date, max: t, onchange: ev => { F.date = ev.target.value || t; go('add', true); } });
  card.append(h('div', { class: 'chips' },
    h('button', { type: 'button', class: 'chip' + (F.date === t ? ' on' : ''), onclick: () => { F.date = t; if (!F.time) F.time = nowTime(); go('add', true); } }, 'Today'),
    h('button', { type: 'button', class: 'chip' + (F.date === y ? ' on' : ''), onclick: () => { F.date = y; F.time = ''; go('add', true); } }, 'Yesterday'),
    h('button', { type: 'button', class: 'chip' + (F.date !== t && F.date !== y ? ' on' : ''), onclick: () => dateInput.showPicker ? dateInput.showPicker() : dateInput.focus() }, 'Pick date')
  ));
  card.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('div', { class: 'grow' }, dateInput),
    h('div', { style: 'width:136px' }, h('input', { type: 'time', value: F.time, 'aria-label': 'Time (optional)', oninput: ev => (F.time = ev.target.value) }))));
  card.append(h('div', { class: 'small faint', style: 'margin-top:3px' }, niceDate(F.date) + (F.time ? '' : ' · time optional')));

  if (F.type === 'expense') renderExpenseFields(card);
  else if (F.type === 'income') renderIncomeFields(card);
  else if (F.type === 'transfer') renderTransferFields(card);

  // note
  card.append(h('span', { class: 'lbl' }, 'Note (optional)'),
    h('input', { type: 'text', value: F.note, placeholder: F.type === 'transfer' ? 'Auto-reload' : 'Anything to remember', oninput: ev => (F.note = ev.target.value) }));

  // receipt
  if (F.type === 'expense' || F.type === 'income') card.append(receiptBlock());

  const err = h('div', { class: 'err', id: 'formErr', role: 'alert' });
  card.append(err);
  const actions = h('div', { class: 'row', style: 'margin-top:12px' });
  if (isEdit) actions.append(h('button', { class: 'btn danger', type: 'button', onclick: deleteEntry }, 'Delete'),
    h('button', { class: 'btn', type: 'button', onclick: () => { F = null; go('history'); } }, 'Cancel'));
  actions.append(h('button', { class: 'btn primary grow', type: 'button', onclick: saveEntry }, isEdit ? 'Save changes' : 'Save'));
  card.append(actions);
}

function walletChips(key, list, label) {
  const wrap = h('div', { class: 'chips' });
  const paint = () => wrap.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === F[key]);
    b.classList.toggle('guess', b.dataset.v === F[key] && F.guessed.has(key));
  });
  for (const w of list) wrap.append(h('button', {
    type: 'button', class: 'chip', 'data-v': w,
    onclick: () => { F[key] = w; F.touched.add(key); F.guessed.delete(key); paint(); }
  }, w));
  paint(); REPAINT.push(paint);
  return [h('span', { class: 'lbl' }, label), wrap];
}

function categoryChips(cats, current, onPick, guessed) {
  const wrap = h('div', { class: 'chips' });
  let expanded = false;
  const draw = () => {
    wrap.innerHTML = '';
    const show = expanded ? cats : cats.slice(0, CFG.quickCats);
    for (const c of show) wrap.append(h('button', {
      type: 'button', class: 'chip' + (c === current() ? ' on' : '') + (c === current() && guessed() ? ' guess' : ''),
      onclick: () => { onPick(c); draw(); }
    }, c));
    if (!expanded && cats.length > CFG.quickCats) wrap.append(h('button', { type: 'button', class: 'chip', onclick: () => { expanded = true; draw(); } }, 'More…'));
  };
  expanded = cats.indexOf(current()) >= CFG.quickCats;
  draw(); REPAINT.push(draw);
  return wrap;
}

function storeInput(onPicked) {
  const idx = storeIndex();
  const box = h('div', { class: 'sugg', hidden: true });
  const inp = h('input', {
    type: 'text', value: F.store, placeholder: 'McD, Lotus\'s Kepong, Lazada…', autocomplete: 'off',
    class: F.guessed.has('store') ? 'guess' : '',
    oninput: ev => { F.store = ev.target.value; F.guessed.delete('store'); inp.classList.remove('guess'); show(); },
    onfocus: () => show(), onblur: () => setTimeout(() => { box.hidden = true; onPicked(false); }, 180)
  });
  function show() {
    const q = norm(F.store);
    const list = [...idx.values()].filter(s => !q || norm(s.name).includes(q))
      .sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || b.count - a.count).slice(0, 6);
    box.innerHTML = '';
    if (!list.length || (list.length === 1 && norm(list[0].name) === q)) { box.hidden = true; return; }
    for (const s of list) box.append(h('button', {
      type: 'button', onmousedown: ev => ev.preventDefault(),
      onclick: () => { F.store = s.name; inp.value = s.name; box.hidden = true; onPicked(true); }
    }, h('span', {}, s.name), h('span', { class: 'faint small' }, `${s.count}×`)));
    box.hidden = false;
  }
  return h('div', { class: 'wrap' }, inp, box);
}

function applyStoreGuesses() {
  const s = storeIndex().get(norm(F.store));
  if (!s) return false;
  let changed = false;
  const w = repeated(s.wallets);
  if (w && !F.touched.has('wallet')) { F.wallet = w; F.guessed.add('wallet'); changed = true; }
  const c = repeated(s.cats);
  if (c && !F.touched.has('category') && !F.category) { F.category = c; F.guessed.add('category'); changed = true; }
  return changed;
}

function renderExpenseFields(card) {
  card.append(h('span', { class: 'lbl' }, 'Store'),
    storeInput(() => { if (applyStoreGuesses()) REPAINT.forEach(f => f()); }));
  card.append(...walletChips('wallet', SPEND_WALLETS, 'Paid with'));

  const hasItems = F.items.length > 0;
  card.append(h('span', { class: 'lbl' }, hasItems ? 'Category (default for new items)' : 'Category'));
  card.append(categoryChips(CFG.expenseCats, () => F.category,
    c => { F.category = c; F.touched.add('category'); F.guessed.delete('category'); }, () => F.guessed.has('category')));

  // amount or items
  if (!hasItems) {
    card.append(h('span', { class: 'lbl' }, 'Amount (RM)'),
      h('input', {
        type: 'text', inputmode: 'decimal', class: 'big' + (F.guessed.has('amount') ? ' guess' : ''), value: F.amount, placeholder: '0.00',
        oninput: ev => { F.amount = ev.target.value; F.guessed.delete('amount'); ev.target.classList.remove('guess'); }
      }));
  }
  card.append(h('span', { class: 'lbl' }, hasItems ? 'Items' : 'Items (optional)'));
  const itemsBox = h('div', {});
  card.append(itemsBox);
  const totalLine = h('div', { class: 'totalline' });
  const drawTotal = () => {
    if (!F.items.length) { totalLine.innerHTML = ''; return; }
    const saved = F.items.reduce((s, it) => s + (num(it.orig) > num(it.unit) ? (num(it.orig) - num(it.unit)) * num(it.qty || 1) : 0), 0);
    totalLine.innerHTML = `<span>Total paid</span><b>RM ${fmt(computedTotal())}</b>`;
    if (saved > 0.004) totalLine.append(h('div', { class: 'small muted', style: 'width:100%;text-align:right' }, `Saved RM ${fmt(saved)}`));
    totalLine.style.flexWrap = 'wrap';
  };
  F.items.forEach((it, i) => itemsBox.append(itemRow(it, i, drawTotal)));
  card.append(h('button', {
    type: 'button', class: 'btn link', onclick: () => {
      if (!F.items.length && num(F.amount) > 0) {
        F.items.push({ key: uid(), name: '', qty: '1', unit: String(F.amount), orig: '', category: F.category || '' });
      } else F.items.push({ key: uid(), name: '', qty: '1', unit: '', orig: '', category: F.category || '' });
      go('add', true);
      // focus the new item's name without a jump, then glide it to the top so it stays above the keyboard
      const all = document.querySelectorAll('.item'), last = all[all.length - 1];
      if (last) {
        last.querySelector('textarea[name=iname]').focus({ preventScroll: true });
        requestAnimationFrame(() => last.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      }
    }
  }, '+ Add item'));
  card.append(totalLine); drawTotal();
}

function itemRow(it, i, drawTotal) {
  const sI = () => storeIndex().get(norm(F.store));
  const gItems = globalItems();
  const box = h('div', { class: 'sugg', hidden: true });
  const hintEl = h('div', {});
  const unitInp = h('input', {
    type: 'text', inputmode: 'decimal', placeholder: 'Unit price', value: it.unit, 'aria-label': 'Unit price',
    class: it.guessUnit ? 'guess' : '', enterkeyhint: 'next', 'data-nav': '',
    oninput: ev => { it.unit = ev.target.value; it.guessUnit = false; unitInp.classList.remove('guess'); drawTotal(); }
  });
  const catSel = h('select', { 'aria-label': 'Item category', onchange: ev => (it.category = ev.target.value), class: it.guessCat ? 'guess' : '' },
    h('option', { value: '' }, 'Category…'),
    CFG.expenseCats.map(c => h('option', { value: c, selected: c === it.category }, c)));
  const origWrap = h('div', { class: 'row', hidden: !(it.orig !== '' && it.orig != null) && !it.showOrig },
    h('span', { class: 'small muted', style: 'white-space:nowrap' }, 'Was RM'),
    h('input', { type: 'text', inputmode: 'decimal', placeholder: 'original price per unit', value: it.orig ?? '', enterkeyhint: 'next', 'data-nav': '', oninput: ev => { it.orig = ev.target.value; drawTotal(); } }));

  function pickItem(name) {
    it.name = name; nameInp.value = name; box.hidden = true;
    const sIdx = sI(); const here = sIdx && sIdx.items.get(norm(name));
    if (here) {
      const units = here.hist.map(x => x.unit), cats = here.hist.map(x => x.category);
      const ru = repeated(units); const rc = repeated(cats) || here.hist[here.hist.length - 1].category;
      if (ru != null && !num(it.unit)) { it.unit = String(ru); unitInp.value = it.unit; it.guessUnit = true; unitInp.classList.add('guess'); }
      if (rc && !it.category) { it.category = rc; catSel.value = rc; it.guessCat = true; catSel.classList.add('guess'); }
      const lastO = here.hist[here.hist.length - 1].orig;
      if (lastO != null && lastO !== '' && (it.orig === '' || it.orig == null)) { it.orig = String(lastO); origWrap.hidden = false; origWrap.querySelector('input').value = it.orig; }
    }
    showHint(); drawTotal();
  }
  function showHint() {
    hintEl.innerHTML = '';
    const k = norm(it.name); if (!k) return;
    const sIdx = sI(); const here = sIdx && sIdx.items.get(k);
    const any = gItems.get(k);
    const last = here ? here.hist[here.hist.length - 1] : any ? any.hist[any.hist.length - 1] : null;
    if (!last) return;
    const where = here ? '' : ` at ${last.store}`;
    hintEl.append(h('button', {
      type: 'button', class: 'hint', onclick: () => { it.unit = String(last.unit); unitInp.value = it.unit; it.guessUnit = false; unitInp.classList.remove('guess'); drawTotal(); }
    }, `Last: RM ${fmt(last.unit)}${where} · ${niceDate(last.date).slice(4)} — use`));
  }
  const grow = () => { nameInp.style.height = 'auto'; nameInp.style.height = nameInp.scrollHeight + 2 + 'px'; };
  const nameInp = h('textarea', {
    name: 'iname', rows: 1, class: 'auto', placeholder: 'Item (as long as you need)', autocomplete: 'off', enterkeyhint: 'next', 'data-nav': '',
    oninput: ev => { it.name = ev.target.value; grow(); showList(); },
    onfocus: () => showList(), onblur: () => setTimeout(() => { box.hidden = true; showHint(); }, 180)
  });
  nameInp.value = it.name;
  function showList() {
    const q = norm(it.name); const sIdx = sI();
    const here = sIdx ? [...sIdx.items.values()].map(x => ({ name: x.name, tag: 'here', last: x.hist[x.hist.length - 1] })) : [];
    const hereKeys = new Set(here.map(x => norm(x.name)));
    const others = q.length >= 2 ? [...gItems.values()].filter(x => !hereKeys.has(norm(x.name))).map(x => ({ name: x.name, tag: 'other', last: x.hist[x.hist.length - 1] })) : [];
    const list = [...here, ...others].filter(x => !q || norm(x.name).includes(q)).slice(0, 6);
    box.innerHTML = '';
    if (!list.length || (list.length === 1 && norm(list[0].name) === q)) { box.hidden = true; return; }
    for (const x of list) box.append(h('button', { type: 'button', onmousedown: ev => ev.preventDefault(), onclick: () => pickItem(x.name) },
      h('span', {}, x.name), h('span', { class: 'faint small' }, x.tag === 'here' ? `RM ${fmt(x.last.unit)}` : x.last.store)));
    box.hidden = false;
  }
  setTimeout(() => { showHint(); grow(); }, 0);
  return h('div', { class: 'item' },
    h('div', { class: 'row' }, h('div', { class: 'wrap grow' }, nameInp, box),
      h('button', { type: 'button', class: 'x', 'aria-label': 'Remove item', onclick: () => { F.items.splice(i, 1); go('add', true); } }, '×')),
    hintEl,
    h('div', { class: 'row' },
      h('span', { class: 'small muted' }, 'Qty'),
      h('input', { type: 'text', inputmode: 'decimal', value: it.qty, style: 'width:64px', 'aria-label': 'Quantity', enterkeyhint: 'next', 'data-nav': '', oninput: ev => { it.qty = ev.target.value; drawTotal(); } }),
      h('div', { class: 'grow' }, unitInp)),
    origWrap,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, catSel),
      origWrap.hidden ? h('button', { type: 'button', class: 'btn link small', onclick: ev => { it.showOrig = true; origWrap.hidden = false; ev.target.remove(); } }, '+ Original price') : null)
  );
}

function renderIncomeFields(card) {
  card.append(h('span', { class: 'lbl' }, 'From / description'),
    h('input', { type: 'text', value: F.store, placeholder: 'Allowance, part-time pay, TNG GO+…', oninput: ev => (F.store = ev.target.value) }));
  card.append(h('span', { class: 'lbl' }, 'Category'));
  card.append(categoryChips(CFG.incomeCats, () => F.category, c => { F.category = c; F.touched.add('category'); }, () => false));
  card.append(...walletChips('wallet', SPEND_WALLETS.concat(['FD']), 'Received into'));
  card.append(h('span', { class: 'lbl' }, 'Amount (RM)'),
    h('input', { type: 'text', inputmode: 'decimal', class: 'big', value: F.amount, placeholder: '0.00', oninput: ev => (F.amount = ev.target.value) }));
}

function renderTransferFields(card) {
  const pairs = transferPairs();
  if (pairs.length && !F.id) card.append(h('span', { class: 'lbl' }, 'Usual transfers'),
    h('div', { class: 'chips' }, pairs.map(p => h('button', {
      type: 'button', class: 'chip small', onclick: () => {
        F.from = p.from; F.to = p.to;
        const top = [...p.amounts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= CFG.fillAfter && !F.amount) F.amount = String(top[0]);
        go('add', true);
      }
    }, `${p.from} → ${p.to}`))));
  card.append(...walletChips('from', ALL_WALLETS, 'From'));
  card.append(...walletChips('to', ALL_WALLETS, 'To'));
  card.append(h('span', { class: 'lbl' }, 'Amount (RM)'),
    h('input', { type: 'text', inputmode: 'decimal', class: 'big', value: F.amount, placeholder: '0.00', oninput: ev => (F.amount = ev.target.value) }));
  const p = pairs.find(x => x.from === F.from && x.to === F.to);
  if (p) {
    const common = [...p.amounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(a => a[0]);
    card.append(h('div', { class: 'chips', style: 'margin-top:6px' }, common.map(a =>
      h('button', { type: 'button', class: 'chip small', onclick: () => { F.amount = String(a); go('add', true); } }, fmt(a)))));
  }
}

function receiptBlock() {
  const wrap = h('div', {});
  wrap.append(h('span', { class: 'lbl' }, 'Receipt'));
  const cam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: ev => pick(ev) });
  const gal = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: ev => pick(ev) });
  async function pick(ev) {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    try { F.receiptBlob = await compressImage(f); F.removeReceipt = false; go('add', true); }
    catch (e) { toast('Could not read that photo'); }
  }
  const has = F.receiptBlob || (F.receiptName && !F.removeReceipt);
  wrap.append(cam, gal, h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn grow', onclick: () => cam.click() }, has ? 'Retake photo' : 'Take photo'),
    h('button', { type: 'button', class: 'btn grow', onclick: () => gal.click() }, 'From gallery')));
  if (has) {
    const nm = F.type === 'expense' || F.type === 'income' ? receiptName(F.date, F.store || F.category, F.id) : '';
    const img = h('img', { class: 'thumb', alt: 'Receipt photo (tap to enlarge)', onclick: () => openViewer(F.receiptBlob ? null : F.receiptName, F.receiptBlob, nm) });
    if (F.receiptBlob) img.src = URL.createObjectURL(F.receiptBlob);
    else DB.get('receipts', F.receiptName).then(r => { if (r && r.blob) img.src = URL.createObjectURL(r.blob); });
    wrap.append(img, h('div', { class: 'row small muted', style: 'justify-content:space-between' },
      h('span', {}, 'Saved as ' + nm + ' · tap photo to enlarge'),
      h('button', { type: 'button', class: 'btn link small', onclick: () => { F.receiptBlob = null; F.removeReceipt = true; go('add', true); } }, 'Remove')));
  }
  return wrap;
}

function validate() {
  const a = F.type === 'expense' && F.items.length ? computedTotal() : num(F.amount);
  if (!F.date) return 'Pick a date.';
  if (F.date > todayStr()) return 'The date can\'t be in the future.';
  if (F.type === 'adjust') return null;
  if (!(a > 0)) return 'Enter an amount above 0.';
  if (F.type === 'expense') {
    if (!F.store.trim()) return 'Enter the store.';
    if (F.items.length) {
      for (const it of F.items) {
        if (!it.name.trim()) return 'Every item needs a name (or remove the empty one).';
        if (!(num(it.qty) > 0)) return `Quantity for “${it.name}” must be above 0.`;
        if (!it.category && !F.category) return `Pick a category for “${it.name}”.`;
      }
    } else if (!F.category) return 'Pick a category.';
  }
  if (F.type === 'income' && !F.category) return 'Pick an income category.';
  if (F.type === 'transfer' && F.from === F.to) return 'From and To must be different wallets.';
  return null;
}

async function saveEntry() {
  const msg = validate();
  if (msg) { $('#formErr').textContent = msg; return; }
  const now = new Date().toISOString();
  const old = F.id ? S.entries.find(e => e.id === F.id) : null;
  const e = {
    id: F.id || uid(), type: F.type, date: F.date, time: F.time || '',
    note: F.note.trim(), created: F.created || now, updated: now, receipt: null
  };
  if (F.type === 'expense') {
    Object.assign(e, { store: F.store.trim(), wallet: F.wallet, category: F.category || '' });
    if (F.items.length) {
      e.items = F.items.map(it => ({
        name: it.name.trim(), qty: num(it.qty), unit: r2(num(it.unit)),
        orig: it.orig === '' || it.orig == null ? null : r2(num(it.orig)), category: it.category || F.category
      }));
      e.amount = computedTotal();
      if (!e.category) e.category = e.items[0].category;
    } else { e.items = []; e.amount = r2(num(F.amount)); }
  } else if (F.type === 'income') {
    Object.assign(e, { store: F.store.trim(), wallet: F.wallet, category: F.category, amount: r2(num(F.amount)), items: [] });
  } else if (F.type === 'transfer') {
    Object.assign(e, { from: F.from, to: F.to, amount: r2(num(F.amount)), items: [] });
  } else if (F.type === 'adjust') {
    Object.assign(e, { wallet: old.wallet, amount: old.amount, store: old.store || 'Reconcile', category: 'Balance Adjustment', items: [] });
  }

  // receipts
  const oldName = old && old.receipt;
  if (F.type === 'expense' || F.type === 'income') {
    if (F.receiptBlob) {
      if (oldName) { await DB.del('receipts', oldName); S.receipts.delete(oldName); }
      const name = receiptName(e.date, e.store || e.category, e.id);
      await DB.put('receipts', { name, entryId: e.id, blob: F.receiptBlob, exported: false, added: now });
      S.receipts.set(name, { name, entryId: e.id, exported: false, added: now }); e.receipt = name;
    } else if (oldName && !F.removeReceipt) {
      const name = receiptName(e.date, e.store || e.category, e.id);
      if (name !== oldName) {
        const r = await DB.get('receipts', oldName);
        await DB.del('receipts', oldName); S.receipts.delete(oldName);
        await DB.put('receipts', { name, entryId: e.id, blob: r.blob, exported: false, added: r.added || now });
        S.receipts.set(name, { name, entryId: e.id, exported: false, added: r.added || now });
      }
      e.receipt = name;
    } else if (oldName && F.removeReceipt) { await DB.del('receipts', oldName); S.receipts.delete(oldName); }
  }

  await DB.put('entries', e);
  S.entries = S.entries.filter(x => x.id !== e.id).concat(e);
  await markChanged();
  requestPersist();
  const wasEdit = !!F.id;
  F = blankForm(wasEdit ? 'expense' : e.type === 'adjust' ? 'expense' : e.type);
  toast(wasEdit ? 'Changes saved' : 'Saved');
  go(wasEdit ? 'history' : 'add');
}

async function deleteEntry() {
  const e = S.entries.find(x => x.id === F.id);
  if (!e) return;
  const what = e.type === 'transfer' ? `${e.from} → ${e.to}` : e.type === 'adjust' ? `Adjustment · ${e.wallet}` : (e.store || e.category);
  const n = (e.items || []).length;
  const extra = [n ? `${n} item${n > 1 ? 's' : ''}` : '', e.receipt ? `receipt photo ${e.receipt}` : ''].filter(Boolean).join(' · ');
  if (!(await ask({ title: 'Delete this entry?', lines: [`${what} · RM ${fmt(Math.abs(num(e.amount)))} · ${niceDate(e.date)}`, extra ? '· ' + extra : ''], ok: 'Delete' }))) return;
  if (!(await ask({
    title: 'Are you sure?', lines: [e.receipt ? 'The entry and its receipt photo will be removed from this phone.' : 'The entry will be removed from this phone.'],
    ok: 'Yes, delete', danger: true, armMs: 600
  }))) return;
  if (e && e.receipt) { await DB.del('receipts', e.receipt); S.receipts.delete(e.receipt); }
  await DB.del('entries', F.id);
  S.entries = S.entries.filter(x => x.id !== F.id);
  await markChanged();
  F = null; toast('Deleted'); go('history');
}

/* ---------- History ---------- */
let H = { q: '', limitDays: 45 };
function entryLine(e) {
  let title, sub, amt, cls = '';
  if (e.type === 'expense') {
    title = e.store; amt = '−' + fmt(e.amount);
    sub = [e.items && e.items.length ? `${e.items.length} item${e.items.length > 1 ? 's' : ''}` : e.category, e.wallet].join(' · ');
  } else if (e.type === 'income') { title = e.store || e.category; sub = `${e.category} · into ${e.wallet}`; amt = '+' + fmt(e.amount); cls = 'in'; }
  else if (e.type === 'transfer') { title = `${e.from} → ${e.to}`; sub = 'Transfer'; amt = fmt(e.amount); cls = 'tr'; }
  else { title = `Adjustment · ${e.wallet}`; sub = 'Reconcile'; amt = (e.amount >= 0 ? '+' : '−') + fmt(Math.abs(e.amount)); cls = 'tr'; }
  if (e.note) sub += ' · ' + e.note;
  const row = h('button', { class: 'ent', type: 'button', onclick: () => { F = formFromEntry(e); go('add'); } },
    h('div', {}, h('div', {}, title), h('div', { class: 'sub' }, sub)), h('div', { class: 'amt ' + cls }, amt));
  if (!e.receipt) return row;
  return h('div', { class: 'entrow' }, row,
    h('button', { class: 'rcpt', type: 'button', 'aria-label': 'View receipt photo', onclick: () => openViewer(e.receipt) }, '🧾'));
}
function matches(e, q) {
  if (!q) return true;
  const hay = [e.store, e.category, e.wallet, e.from, e.to, e.note, ...(e.items || []).map(i => i.name + ' ' + i.category)].map(norm).join(' ');
  return q.split(' ').every(w => hay.includes(w));
}
function renderHistory(m) {
  const search = h('input', { type: 'search', placeholder: 'Search store, item, category, wallet', value: H.q, oninput: ev => { H.q = ev.target.value; draw(); } });
  const list = h('div', { class: 'list' });
  m.append(search, list);
  function draw() {
    list.innerHTML = '';
    const q = norm(H.q);
    const cutoff = addDays(todayStr(), -H.limitDays);
    const items = sortEntries(S.entries).filter(e => matches(e, q) && (q || e.date >= cutoff));
    if (!S.entries.length) { list.append(h('p', { class: 'muted' }, 'No entries yet. Your saved expenses, income and transfers show up here.')); return; }
    if (!items.length) { list.append(h('p', { class: 'muted' }, 'Nothing matches that search.')); }
    let day = null;
    for (const e of items) {
      if (e.date !== day) {
        day = e.date;
        const spent = S.entries.filter(x => x.date === day && x.type === 'expense').reduce((s, x) => s + num(x.amount), 0);
        list.append(h('div', { class: 'day' }, h('span', {}, niceDate(day)), h('span', {}, spent ? `RM ${fmt(spent)} spent` : '')));
      }
      list.append(entryLine(e));
    }
    if (!q && S.entries.some(e => e.date < cutoff))
      list.append(h('button', { class: 'btn full', type: 'button', onclick: () => { H.limitDays += 60; draw(); } }, 'Show older'));
  }
  draw();
}

/* ---------- Summary ---------- */
let SUM = { mode: 'month', offset: 0 };
function periodRange(mode, offset) {
  const t = parseDate(todayStr());
  if (mode === 'week') {
    const dow = (t.getDay() + 6) % 7; const start = new Date(t); start.setDate(t.getDate() - dow + offset * 7);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return { start: localDate(start), end: localDate(end), label: `${start.getDate()} ${MON[start.getMonth()]} – ${end.getDate()} ${MON[end.getMonth()]} ${end.getFullYear()}` };
  }
  if (mode === 'month') {
    const s = new Date(t.getFullYear(), t.getMonth() + offset, 1), e = new Date(s.getFullYear(), s.getMonth() + 1, 0);
    return { start: localDate(s), end: localDate(e), label: `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][s.getMonth()]} ${s.getFullYear()}` };
  }
  const y = t.getFullYear() + offset;
  return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
}
function periodStats(r) {
  const es = S.entries.filter(e => e.date >= r.start && e.date <= r.end);
  const cats = new Map(); const stores = new Map(); let spent = 0, income = 0, saved = 0;
  for (const e of es) {
    if (e.type === 'income') income += num(e.amount);
    if (e.type !== 'expense') continue;
    spent += num(e.amount);
    const s = stores.get(e.store) || { n: 0, v: 0 }; s.n++; s.v += num(e.amount); stores.set(e.store, s);
    for (const l of expenseLines(e)) { cats.set(l.category, (cats.get(l.category) || 0) + l.amount); saved += l.saved; }
  }
  return { spent: r2(spent), income: r2(income), saved: r2(saved), cats, stores, count: es.length };
}
function renderSummary(m) {
  const r = periodRange(SUM.mode, SUM.offset), p = periodRange(SUM.mode, SUM.offset - 1);
  const st = periodStats(r), prev = periodStats(p);
  m.append(h('div', { class: 'seg' }, ['week', 'month', 'year'].map(md =>
    h('button', { type: 'button', class: SUM.mode === md ? 'on' : '', onclick: () => { SUM = { mode: md, offset: 0 }; go('summary'); } }, md[0].toUpperCase() + md.slice(1)))));
  m.append(h('div', { class: 'navrow' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous', onclick: () => { SUM.offset--; go('summary'); } }, '‹'),
    h('b', {}, r.label),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Next', disabled: SUM.offset >= 0, onclick: () => { SUM.offset++; go('summary'); } }, '›')));
  m.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'small muted' }, 'Spent'), h('div', { class: 'v' }, fmt(st.spent))),
    h('div', { class: 'stat' }, h('div', { class: 'small muted' }, 'Income'), h('div', { class: 'v' }, fmt(st.income)))));
  const parts = [];
  if (prev.spent > 0) { const pc = Math.round((st.spent - prev.spent) / prev.spent * 100); parts.push(`Spent ${pc >= 0 ? '+' : ''}${pc}% vs previous ${SUM.mode}`); }
  if (st.saved > 0) parts.push(`Saved from offers: RM ${fmt(st.saved)}`);
  if (parts.length) m.append(h('p', { class: 'small muted' }, parts.join(' · ')));

  const card = h('div', { class: 'card' }, h('b', {}, 'By category'));
  const cats = [...st.cats.entries()].sort((a, b) => b[1] - a[1]);
  if (!cats.length) card.append(h('p', { class: 'muted small' }, 'No spending in this period.'));
  const top = cats.length ? cats[0][1] : 1;
  for (const [c, v] of cats) card.append(h('div', { class: 'barrow' },
    h('div', { class: 'row' }, h('span', {}, c), h('span', { class: 'muted' }, `${fmt(v)} · ${Math.round(v / st.spent * 100)}%`)),
    h('div', { class: 'bar', style: `width:${Math.max(2, v / top * 100)}%` })));
  m.append(card);

  const sc = h('div', { class: 'card' }, h('b', {}, 'Top stores'));
  const stores = [...st.stores.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 6);
  if (!stores.length) sc.append(h('p', { class: 'muted small' }, 'No stores yet.'));
  for (const [name, s] of stores) sc.append(h('div', { class: 'wl' }, h('span', {}, name), h('span', { class: 'muted' }, `${s.n}× · ${fmt(s.v)}`)));
  m.append(sc);
}

/* ---------- Wallets, reconcile, export ---------- */
function needsExportReminder() {
  if (!S.settings.changedSinceExport || !S.entries.length) return false;
  if (!S.settings.lastExportAt) {
    const first = S.entries.map(e => e.created).sort()[0];
    return Date.now() - new Date(first).getTime() > CFG.remindDays * 864e5;
  }
  return Date.now() - new Date(S.settings.lastExportAt).getTime() > CFG.remindDays * 864e5;
}
function renderWallets(m) {
  const b = balances();
  const spend = h('div', { class: 'card' }, h('b', {}, 'Spending wallets'));
  let total = 0;
  for (const w of SPEND_WALLETS) {
    total += b[w] || 0;
    spend.append(walletRow(w, b[w] || 0));
  }
  spend.append(h('div', { class: 'wl' }, h('b', {}, 'Total'), h('span', { class: 'v' }, fmt(total))));
  m.append(spend);
  const sav = h('div', { class: 'card' }, h('b', {}, 'Savings (kept separate)'), walletRow('FD', b.FD || 0));
  m.append(sav);

  // opening balances
  const ob = h('details', { class: 'card', open: !S.settings.openingSet },
    h('summary', {}, h('b', {}, 'Opening balances')),
    h('p', { class: 'small muted' }, 'What each wallet held just before your first entry (e.g. on 1 Dec 2026). Change these only if your starting figures were wrong; use Reconcile for day-to-day differences.'));
  const inputs = {};
  for (const w of ALL_WALLETS) {
    inputs[w] = h('input', { type: 'text', inputmode: 'decimal', value: S.settings.opening[w] ? String(S.settings.opening[w]) : '', placeholder: '0.00' });
    ob.append(h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { style: 'width:90px' }, w), h('div', { class: 'grow' }, inputs[w])));
  }
  ob.append(h('button', {
    class: 'btn primary full', style: 'margin-top:10px', type: 'button', onclick: async () => {
      for (const w of ALL_WALLETS) S.settings.opening[w] = r2(num(inputs[w].value));
      S.settings.openingSet = true; S.settings.changedSinceExport = true; await saveSettings(); requestPersist();
      toast('Opening balances saved'); go('wallets');
    }
  }, 'Save opening balances'));
  m.append(ob);

  // export
  const nPhotos = photosForExport(false).length;
  const ex = h('div', { class: 'card' }, h('b', {}, 'Export for laptop'),
    h('p', { class: 'small muted' }, S.settings.lastExportAt ? `Last export: ${new Date(S.settings.lastExportAt).toLocaleString('en-MY')}` : 'Not exported yet.'),
    h('p', { class: 'small' }, `${S.entries.length} entr${S.entries.length === 1 ? 'y' : 'ies'} · ${nPhotos} photo${nPhotos === 1 ? '' : 's'} from the last ${CFG.photoDays} days`),
    h('button', { class: 'btn primary full', type: 'button', onclick: () => doExport(false) }, 'Export for laptop'),
    h('p', { class: 'small muted' }, `Saved to Downloads. It has every entry, plus photos from the last ${CFG.photoDays} days, so a missed export never loses a photo.`),
    h('p', { class: 'small muted' }, 'To send by Telegram: in Telegram tap 📎 → File, open Downloads and pick the ZIP. Or copy it by USB to ExpenseSync\\Inbox.'));
  m.append(ex);

  // restore + storage
  const fileIn = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: ev => { const f = ev.target.files[0]; ev.target.value = ''; restore(f); } });
  const persistTxt = h('span', { class: 'small muted' }, 'Checking storage…');
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { persistTxt.textContent = p ? 'Storage: protected from automatic clearing.' : 'Storage: not yet protected. It becomes protected after you install the app and save entries.'; });
  else persistTxt.textContent = '';
  // space used by this app on the phone (entries + photos + offline copy); hidden if Chrome can't report it
  const spaceTxt = h('p', { class: 'small muted', hidden: true });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(({ usage }) => {
    if (usage == null) return;
    const size = usage < 1048576 ? `${Math.max(1, Math.round(usage / 1024))} KB` : `${(usage / 1048576).toFixed(1)} MB`;
    const np = S.receipts.size, ne = S.entries.length;
    spaceTxt.textContent = `Space used: ${size} · ${np.toLocaleString('en-MY')} receipt photo${np === 1 ? '' : 's'} · ${ne.toLocaleString('en-MY')} entr${ne === 1 ? 'y' : 'ies'}`;
    spaceTxt.hidden = false;
  }).catch(() => { });
  m.append(h('div', { class: 'card' }, h('b', {}, 'Backup and restore'),
    h('button', { class: 'btn full', type: 'button', onclick: () => doExport(true) }, 'Full backup (every photo)'),
    h('p', { class: 'small muted' }, 'Every entry and every photo, for moving to a new phone. Saved to Downloads.' +
      (S.settings.lastFullBackupAt ? ` Last full backup: ${new Date(S.settings.lastFullBackupAt).toLocaleDateString('en-MY')}.` : '')),
    h('p', { class: 'small muted' }, 'Restoring replaces everything on this phone with the contents of an export or full backup ZIP.'),
    fileIn, h('button', { class: 'btn full', type: 'button', onclick: () => fileIn.click() }, 'Restore from ZIP…'),
    h('p', {}, persistTxt), spaceTxt, h('p', { class: 'small faint' }, `App version ${APP_VERSION}`)));
}
function walletRow(w, v) {
  return h('div', { class: 'wl' },
    h('span', {}, w),
    h('span', { class: 'row' }, h('span', { class: 'v' + (v < 0 ? ' neg' : '') }, fmt(v)),
      h('button', { class: 'btn link small', type: 'button', onclick: () => reconcile(w, v) }, 'Reconcile')));
}
function reconcile(w, current) {
  const inp = h('input', { type: 'text', inputmode: 'decimal', placeholder: fmt(current) });
  const err = h('div', { class: 'err' });
  const dlg = h('dialog', {},
    h('b', {}, `Reconcile ${w}`),
    h('p', { class: 'small muted' }, `App balance: RM ${fmt(current)}. Enter what ${w} actually shows now. The difference is recorded as an adjustment dated today.`),
    inp, err,
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn grow', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', {
        class: 'btn primary grow', type: 'button', onclick: async () => {
          if (inp.value.trim() === '') { err.textContent = 'Enter the actual balance.'; return; }
          const actual = r2(num(inp.value)), delta = r2(actual - current);
          if (Math.abs(delta) < 0.005) { dlg.close(); toast(`${w} already matches`); return; }
          const now = new Date().toISOString();
          const e = { id: uid(), type: 'adjust', date: todayStr(), time: nowTime(), wallet: w, amount: delta, store: 'Reconcile', category: 'Balance Adjustment', items: [], note: `Actual RM ${fmt(actual)}`, created: now, updated: now, receipt: null };
          await DB.put('entries', e); S.entries.push(e); await markChanged();
          dlg.close(); toast(`${w} adjusted by ${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}`); go('wallets');
        }
      }, 'Save')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); inp.focus();
}

function toCSV(rows) {
  return rows.map(r => r.map(v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
}
function flatRows() {
  const rows = [['entry_id', 'date', 'time', 'type', 'store', 'wallet', 'from', 'to', 'category', 'item_no', 'item', 'qty', 'unit_price', 'original_price', 'line_amount', 'entry_amount', 'note', 'receipt']];
  for (const e of sortEntries(S.entries).reverse()) {
    const base = [e.id, e.date, e.time, e.type, e.store || '', e.wallet || '', e.from || '', e.to || ''];
    if (e.items && e.items.length) e.items.forEach((it, i) => rows.push([...base, it.category, i + 1, it.name, it.qty, it.unit, it.orig ?? '', itemTotal(it), e.amount, e.note, e.receipt || '']));
    else rows.push([...base, e.category || '', '', '', '', '', '', e.amount, e.amount, e.note, e.receipt || '']);
  }
  return rows;
}
async function buildZip(full) {
  const zip = new JSZip();
  const data = {
    app: 'expenses-offline', schema: SCHEMA, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), full,
    wallets: CFG.wallets, expenseCats: CFG.expenseCats, incomeCats: CFG.incomeCats,
    opening: S.settings.opening, entries: sortEntries(S.entries).reverse(),
    receipts: [...S.receipts.values()].map(r => ({ name: r.name, entryId: r.entryId, path: receiptPath(r.name) }))
  };
  zip.file('data.json', JSON.stringify(data, null, 1));
  zip.file('entries.csv', '﻿' + toCSV(flatRows()));
  const sent = [];
  for (const r of photosForExport(full)) {
    const rec = await DB.get('receipts', r.name);
    if (rec && rec.blob) { zip.file(receiptPath(r.name), rec.blob); sent.push(r.name); }
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, sent };
}
// A normal export re-sends every photo from the last CFG.photoDays days, plus any never sent, so one ZIP that
// never reached the laptop can't lose a photo. (Sync skips photos it already has.) A full backup has every photo.
function photosForExport(full) {
  const cutoff = addDays(todayStr(), -CFG.photoDays);
  return [...S.receipts.values()].filter(r => {
    if (full || !r.exported) return true;
    const named = /^\d{8}/.test(r.name) ? `${r.name.slice(0, 4)}-${r.name.slice(4, 6)}-${r.name.slice(6, 8)}` : '';
    const added = r.added ? localDate(new Date(r.added)) : '';
    return (added > named ? added : named) >= cutoff;
  });
}
async function doExport(full) {
  try {
    toast('Preparing export…');
    const { blob, sent } = await buildZip(full);
    const d = new Date();
    const name = `expenses-${full ? 'full-' : ''}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    for (const n of sent) {
      const rec = await DB.get('receipts', n);
      if (rec) { rec.exported = true; await DB.put('receipts', rec); S.receipts.get(n).exported = true; }
    }
    S.settings.lastExportAt = d.toISOString(); S.settings.changedSinceExport = false;
    if (full) S.settings.lastFullBackupAt = d.toISOString();
    await saveSettings();
    toast(`Saved ${name} to Downloads`); go('wallets', true);
  } catch (e) {
    console.error(e); toast('Export failed: ' + (e && e.message || e));
  }
}
async function restore(file) {
  if (!file) return;
  try {
    const zip = await JSZip.loadAsync(file);
    const jf = zip.file('data.json'); if (!jf) throw new Error('This ZIP has no data.json');
    const data = JSON.parse(await jf.async('string'));
    if (data.app !== 'expenses-offline') throw new Error('This is not an Expenses export');
    const nNow = S.entries.length, nNew = data.entries.length, nPh = (data.receipts || []).filter(r => zip.file(r.path)).length;
    if (!(await ask({
      title: 'Restore from this file?',
      lines: [`${file.name}: ${nNew} entr${nNew === 1 ? 'y' : 'ies'} and ${nPh} photo${nPh === 1 ? '' : 's'}.`, `· This replaces everything on this phone (${nNow} entr${nNow === 1 ? 'y' : 'ies'} now).`],
      ok: 'Restore'
    }))) return;
    if (!(await ask({
      title: 'Are you sure?', lines: [`The ${nNow} entr${nNow === 1 ? 'y' : 'ies'} and photos on this phone will be replaced by the ones in this file.`],
      ok: 'Yes, replace', danger: true, armMs: 600
    }))) return;
    await DB.clear('entries'); await DB.clear('receipts');
    for (const e of data.entries) await DB.put('entries', e);
    let missing = 0;
    for (const r of data.receipts || []) {
      const f = zip.file(r.path);
      if (f) await DB.put('receipts', { name: r.name, entryId: r.entryId, blob: await f.async('blob'), exported: true });
      else missing++;
    }
    S.settings.opening = Object.assign(DEFAULT_SETTINGS().opening, data.opening || {});
    S.settings.openingSet = true; S.settings.changedSinceExport = false;
    await saveSettings(); await load();
    toast(`Restored ${data.entries.length} entries` + (missing ? ` (${missing} photos not in this file)` : ''));
    go('history');
  } catch (e) { alert('Restore failed: ' + e.message); }
}
async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (_) { }
}

/* ---------- Start ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.tab === 'add' && S.tab === 'add' && F && F.id) return;
  if (b.dataset.tab !== 'add' && F && F.id) F = null;   // leaving an edit discards it
  go(b.dataset.tab);
}));
$('#back').addEventListener('click', () => handleBack());

/* ---------- Phone Back button ----------
   One extra history entry (the "guard") catches Android's Back, so the app steps back instead of closing. */
let backArmed = false;
function armBack() { if (!backArmed) { history.pushState({ app: 'guard' }, ''); backArmed = true; } }
function atHome() { return !VIEWER && !document.querySelector('dialog[open]') && S.tab === 'add' && !(F && F.id) && !formDirty(); }
async function handleBack() {
  if (VIEWER) { closeViewer(); return; }
  const dlg = document.querySelector('dialog[open]');
  if (dlg) { dlg.close(); return; }
  if (S.tab === 'add' && F && F.id) {
    if (formDirty() && !(await ask({ title: 'Discard changes?', lines: ['Your changes to this entry will be lost.'], ok: 'Discard' }))) return;
    F = null; go('history'); return;
  }
  if (S.tab !== 'add') { go('add'); return; }
  if (formDirty() && await ask({ title: 'Discard this entry?', lines: ['What you have typed will be cleared.'], ok: 'Discard' })) {
    F = blankForm(F.type); go('add');
  }
}
addEventListener('popstate', () => {
  backArmed = false;
  if (atHome()) {            // nothing to step back from: warn once, a second Back within 2 s closes the app
    toast('Press back again to exit');
    setTimeout(armBack, 2000);
    return;
  }
  armBack(); handleBack();
});
document.addEventListener('pointerdown', armBack, true);   // any tap = still using the app

/* ---------- While typing: hide the bottom tab bar; keyboard "Next" moves through an item's fields ---------- */
function updTyping() {
  const a = document.activeElement;
  const field = !!a && !!a.matches && a.matches('input:not([type=date]):not([type=time]):not([type=file]), textarea, select') && !a.closest('dialog');
  const vv = window.visualViewport;
  const keyboard = !vv || window.innerHeight - vv.height > 120;
  document.body.classList.toggle('typing', field && keyboard);
}
document.addEventListener('focusin', updTyping);
document.addEventListener('focusout', () => setTimeout(updTyping, 0));
if (window.visualViewport) visualViewport.addEventListener('resize', updTyping);
function navNext(el) {
  const all = [...document.querySelectorAll('#main [data-nav]')].filter(x => x.offsetParent !== null);
  const next = all[all.indexOf(el) + 1];
  if (next) next.focus(); else el.blur();
}
document.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-nav]')) { ev.preventDefault(); navNext(ev.target); }
});
document.addEventListener('beforeinput', ev => {   // some phone keyboards send Enter only as a line break
  if ((ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') && ev.target.matches && ev.target.matches('[data-nav]')) {
    ev.preventDefault(); navNext(ev.target);
  }
});

const net = () => { $('#offline').hidden = navigator.onLine; };
addEventListener('online', net); addEventListener('offline', net);
(async () => {
  try { await load(); } catch (e) { $('#main').textContent = 'Storage unavailable: ' + e.message; return; }
  net(); go('add');
  history.replaceState({ app: 'root' }, ''); armBack();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
