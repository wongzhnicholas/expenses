'use strict';
/* Expenses — offline expense tracker (Phase 1)
   All data stays in this phone's browser storage (IndexedDB). Nothing is uploaded, except that
   "Find new place nearby" sends the rounded position to a map search when tapped.
   Export creates a ZIP for the laptop Sync helper. */

const APP_VERSION = '1.4.0';
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
  nearLimit: 0.8,          // budgets: "near" from this share of the limit
  photoDays: 30,           // every export re-sends photos from this many recent days (plus any never sent)
  geo: {                   // GPS store names (metres)
    near: 150, acc: 100,   // "nearby" distance; a position must be at least this accurate
    spots: 5, show: 3,     // branches kept per store; "Near you" suggestions
    list: 15,              // names in the online list
    url: 'https://photon.komoot.io/reverse', skip: ['atm', 'bench', 'toilets', 'parking', 'parking_space', 'bicycle_parking', 'motorcycle_parking', 'drinking_water', 'telephone', 'vending_machine', 'waste_basket', 'post_box', 'information']
  }
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

/* Cash-register money entry: type digits only, the last two are sen (1, 2, 3, 0 -> 12.30); backspace drops the last digit.
   Spread MONEY into an input's attributes and call cashify(ev) in its oninput; it returns the new value ('' when empty). */
const MONEY = {
  type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off',
  onfocus: ev => setTimeout(() => caretEnd(ev.target), 0), onclick: ev => caretEnd(ev.target)
};
function caretEnd(el) { try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) { } }
function cashify(ev) {
  const el = ev.target;
  const digits = el.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
  el.value = digits ? (parseInt(digits, 10) / 100).toFixed(2) : '';
  caretEnd(el);
  return el.value;
}

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
  budgets: [],            // [{from:'YYYY-MM', limits:{category: RM}}]: each record applies from its month until the next one
  noSpend: [],            // dates marked "nothing spent" in the Calendar
  places: [],             // [{name, spots: [{lat, lon, at}]}]: stores remembered by position (this phone + full backup only)
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
  S.places = cleanPlaces(await DB.get('meta', 'places'));
  S.noSpend = cleanDates(await DB.get('meta', 'noSpend'));
  S.budgets = cleanBudgets(await DB.get('meta', 'budgets'));
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
// skipId = leave out one entry (the one being edited)
function balances(skipId = null) {
  const b = Object.assign({}, S.settings.opening);
  for (const e of S.entries) if (e.id !== skipId) for (const [w, d] of Object.entries(effects(e))) b[w] = r2((b[w] || 0) + d);
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

/* ---------- GPS store names ----------
   Own places work offline. Only placeSearch() goes online, and only when "Find new place nearby" is tapped. */
let GEO_OK = false;       // location already allowed (so asking for it shows no pop-up)
let POS = null;           // last position {lat, lon, acc, at}
let LOCATING = null;      // the request under way
function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(q)));
}
async function geoInit() {
  try {
    const st = await navigator.permissions.query({ name: 'geolocation' });
    GEO_OK = st.state === 'granted'; st.onchange = () => { GEO_OK = st.state === 'granted'; };
  } catch (_) { GEO_OK = false; }
}
function getPos() {
  if (POS && Date.now() - POS.at < 60000) return Promise.resolve(POS);
  if (LOCATING) return LOCATING;
  LOCATING = new Promise((res, rej) => {
    if (!navigator.geolocation) { rej(new Error('This phone has no location service.')); return; }
    navigator.geolocation.getCurrentPosition(
      p => { GEO_OK = true; POS = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; res(POS); },
      e => rej(new Error(e.code === 1 ? 'Location is not allowed. Turn it on in Chrome\'s site settings for this app.'
        : e.code === 3 ? 'No position found in time. Try again near the door.' : 'Position not available. Is Location on?')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }).finally(() => { LOCATING = null; });
  return LOCATING;
}
const tooRough = p => p.acc > CFG.geo.acc ? `Position too rough (±${Math.round(p.acc)} m). Try near the door.` : '';
function cleanPlaces(list) {
  return (Array.isArray(list) ? list : []).map(p => ({
    name: String(p && p.name || '').trim(),
    spots: (Array.isArray(p && p.spots) ? p.spots : []).filter(q => q && isFinite(q.lat) && isFinite(q.lon)).slice(-CFG.geo.spots).map(q => ({ lat: +q.lat, lon: +q.lon, at: String(q.at || '') }))
  })).filter(p => p.name && p.spots.length);
}
function nearPlaces(pos) {
  return S.places.map(p => ({ name: p.name, d: Math.min(...p.spots.map(q => metres(pos, q))) }))
    .filter(x => x.d <= CFG.geo.near).sort((a, b) => a.d - b.d).slice(0, CFG.geo.show);
}
async function rememberPlace(name, pos) {
  const k = norm(name), spot = { lat: pos.lat, lon: pos.lon, at: new Date().toISOString() };
  let p = S.places.find(x => norm(x.name) === k);
  if (!p) S.places.push(p = { name, spots: [] });
  p.name = name;
  const i = p.spots.findIndex(q => metres(q, pos) <= CFG.geo.near);
  if (i >= 0) p.spots.splice(i, 1);          // same branch: newer reading replaces the old one
  p.spots.push(spot);
  while (p.spots.length > CFG.geo.spots) p.spots.shift();   // oldest reading first
  await DB.put('meta', S.places, 'places');
}
// Names of shops, eateries etc. near a position, from the free OpenStreetMap search "Photon". Sends the position only (about 11 m steps).
async function placeSearch(pos) {
  const u = `${CFG.geo.url}?lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}&radius=${CFG.geo.near / 1000}&limit=50` +
    ['shop', 'amenity', 'leisure', 'tourism', 'craft'].map(t => '&osm_tag=' + t).join('');
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(u, { signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!r.ok) throw new Error('busy');
    return placeList(pos, await r.json());
  } finally { clearTimeout(tm); }
}
function placeList(pos, json) {
  const seen = new Set();
  return (json && Array.isArray(json.features) ? json.features : []).map(f => {
    const c = f.geometry && f.geometry.coordinates || [], q = f.properties || {};
    return { name: String(q.name || '').replace(/\s+/g, ' ').trim().slice(0, 80), kind: q.osm_value, d: metres(pos, { lat: c[1], lon: c[0] }) };
  }).filter(x => x.name && x.d <= CFG.geo.near && !CFG.geo.skip.includes(x.kind)).sort((a, b) => a.d - b.d)
    .filter(x => !seen.has(norm(x.name)) && seen.add(norm(x.name))).slice(0, CFG.geo.list);
}
// Pop-up list; resolves the chosen name, or null
function pickPlace(list) {
  return new Promise(res => {
    let out = null;
    const dlg = h('dialog', { class: 'ask' }, h('b', {}, 'Which store are you in?'),
      h('div', { style: 'max-height:50vh;overflow:auto;margin-top:10px' }, list.map(x => h('button', {
        class: 'ent', type: 'button', onclick: () => { out = x.name; dlg.close(); }
      }, h('span', {}, x.name), h('span', { class: 'faint small', style: 'white-space:nowrap' }, `${Math.round(x.d)} m`)))),
      h('button', { class: 'btn full', type: 'button', style: 'margin-top:8px', onclick: () => dlg.close() }, 'None of these (type the name)'),
      h('p', { class: 'small muted' }, h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit' }, '© OpenStreetMap contributors'), ' · search by Photon (komoot)'));
    dlg.addEventListener('close', () => { dlg.remove(); res(out); });
    document.body.append(dlg); dlg.showModal();
  });
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
let BAL_DRAW = [];      // redraw the wallet balance lines on Add/Edit
let DATE_PAINT = null;  // redraw the date block on Add/Edit without rebuilding the form
let NEAR_REFRESH = null;   // look for saved places again (back from the background)
const drawBal = () => BAL_DRAW.forEach(f => f());
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
  REPAINT = []; BAL_DRAW = []; DATE_PAINT = null; NEAR_REFRESH = null;
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
    here: null, hereMsg: '',   // position to remember for this store on Save (📍)
    handDate: false, handTime: false,   // set by hand: the app must not change the date/time
    guessed: new Set(), touched: new Set(), created: null
  };
}
function formFromEntry(e) {
  const f = blankForm(e.type === 'adjust' ? 'income' : e.type);
  Object.assign(f, {
    id: e.id, type: e.type, date: e.date, time: e.time || '', store: e.store || '', wallet: e.wallet || CFG.defaultWallet,
    from: e.from || 'Maybank', to: e.to || 'TNG', amount: money2(e.amount), category: e.category || '',
    items: (e.items || []).map(it => ({ ...it, qty: String(it.qty ?? 1), unit: money2(it.unit), orig: money2(it.orig), key: uid(),
      category: it.category === e.category && CFG.expenseCats.includes(e.category) ? '' : it.category })),   // same as the main one: follow it
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
  return !!(F.store.trim() || num(F.amount) || F.items.length || F.note.trim() || F.receiptBlob || F.here);
}
// money shown with two decimals when an entry opens for editing (12.3 -> "12.30"); empty stays empty
const money2 = v => (v === '' || v == null ? '' : r2(num(v)).toFixed(2));
// An empty new form follows the clock; once something is typed (or the date/time is set by hand) it stays put.
function refreshDateTime() {
  if (F && !F.id && F.type !== 'adjust' && !F.handDate && !F.handTime && !formDirty()) { F.date = todayStr(); F.time = nowTime(); }
  if (DATE_PAINT && F) DATE_PAINT();
}
// Items follow the main category: an item's own category is '' until it is set by hand (the saved entry always has the real one).
const mainCat = () => (CFG.expenseCats.includes(F.category) ? F.category : '');
function computedTotal() { return r2(F.items.reduce((s, it) => s + itemTotal(it), 0)); }

function renderAdd(m) {
  if (!F) F = blankForm();
  refreshDateTime();
  const isEdit = !!F.id;
  // banners
  if (!S.settings.openingSet && !isEdit)
    m.append(h('div', { class: 'banner info' }, 'Start by entering your opening wallet balances. ',
      h('button', { class: 'btn link', onclick: () => go('wallets') }, 'Go to Wallets')));
  if (F.copiedFrom && !isEdit)
    m.append(h('div', { class: 'banner info' }, `↻ Copied from ${F.copiedFrom}. Check quantities and prices, then Save.`));
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
        onclick: () => { if (F.type !== t) { F.type = t; F.here = null; F.hereMsg = ''; F.guessed.clear(); fitType(); go('add', true); } }
      }, t[0].toUpperCase() + t.slice(1))));
    card.append(seg);
  }

  // shortcuts
  if (!isEdit && F.type === 'expense' && !F.store && !F.amount && !F.items.length) {
    const sc = quickShortcuts();
    if (sc.length) card.append(h('span', { class: 'lbl' }, 'Usual at this time'),
      h('div', { class: 'chips' }, sc.map(c => h('button', {
        class: 'chip small', type: 'button', onclick: () => {
          Object.assign(F, { store: c.store, wallet: c.wallet, category: c.category, amount: money2(c.amount) });
          F.guessed = new Set(['store', 'wallet', 'category', 'amount']); go('add', true);
        }
      }, `${c.store} ${fmt(c.amount)} · ${c.wallet}`))));
  }

  // date
  card.append(h('span', { class: 'lbl' }, 'Date'));
  const dateInput = h('input', { type: 'date', value: F.date, max: todayStr(), onchange: ev => { F.date = ev.target.value || todayStr(); F.handDate = true; if (F.date !== todayStr()) F.here = null; go('add', true); } });
  const timeInput = h('input', { type: 'time', value: F.time, 'aria-label': 'Time (optional)', oninput: ev => { F.time = ev.target.value; F.handTime = true; } });
  const bToday = h('button', {
    type: 'button', class: 'chip', onclick: () => {
      F.date = todayStr(); F.handDate = false;
      if (!F.time) { F.time = nowTime(); F.handTime = false; }
      go('add', true);
    }
  }, 'Today');
  const bYest = h('button', { type: 'button', class: 'chip', onclick: () => { F.date = addDays(todayStr(), -1); F.time = ''; F.handDate = true; F.handTime = false; F.here = null; go('add', true); } }, 'Yesterday');
  const bPick = h('button', { type: 'button', class: 'chip', onclick: () => dateInput.showPicker ? dateInput.showPicker() : dateInput.focus() }, 'Pick date');
  const dateNote = h('div', { class: 'small faint', style: 'margin-top:3px' });
  DATE_PAINT = () => {
    const t = todayStr(), y = addDays(t, -1);
    bToday.classList.toggle('on', F.date === t);
    bYest.classList.toggle('on', F.date === y);
    bPick.classList.toggle('on', F.date !== t && F.date !== y);
    dateInput.max = t;
    if (dateInput.value !== F.date) dateInput.value = F.date;
    if (timeInput.value !== F.time) timeInput.value = F.time;
    dateNote.textContent = niceDate(F.date) + (F.time ? '' : ' · time optional');
  };
  DATE_PAINT();
  card.append(h('div', { class: 'chips' }, bToday, bYest, bPick));
  card.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('div', { class: 'grow' }, dateInput),
    h('div', { style: 'width:136px' }, timeInput)));
  card.append(dateNote);

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
  if (isEdit && F.type !== 'adjust') card.append(h('button', {
    class: 'btn full', type: 'button', style: 'margin-top:12px', onclick: async () => {
      if (formDirty() && !(await ask({ title: 'Discard changes?', lines: ['Your unsaved changes to this entry will be lost. The saved version is copied.'], ok: 'Discard' }))) return;
      repeatEntry(S.entries.find(x => x.id === F.id));
    }
  }, '↻ Repeat as new entry (today)'));
  const actions = h('div', { class: 'row', style: 'margin-top:12px' });
  if (isEdit) actions.append(h('button', { class: 'btn danger', type: 'button', onclick: deleteEntry }, 'Delete'),
    h('button', { class: 'btn', type: 'button', onclick: () => { F = null; go('history'); } }, 'Cancel'));
  actions.append(h('button', { class: 'btn primary grow', type: 'button', onclick: saveEntry }, isEdit ? 'Save changes' : 'Save'));
  card.append(actions);
}

// After switching type: a wallet or category the new type doesn't have goes back to the default wallet / blank.
function fitType() {
  if (F.type === 'transfer') return;
  const cats = F.type === 'income' ? CFG.incomeCats : CFG.expenseCats;
  const wals = F.type === 'income' ? ALL_WALLETS : SPEND_WALLETS;
  if (!cats.includes(F.category)) { F.category = ''; F.touched.delete('category'); }
  if (!wals.includes(F.wallet)) { F.wallet = CFG.defaultWallet; F.touched.delete('wallet'); }
}

function walletChips(key, list, label) {
  const wrap = h('div', { class: 'chips' });
  const paint = () => wrap.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === F[key]);
    b.classList.toggle('guess', b.dataset.v === F[key] && F.guessed.has(key));
  });
  for (const w of list) wrap.append(h('button', {
    type: 'button', class: 'chip', 'data-v': w,
    onclick: () => { F[key] = w; F.touched.add(key); F.guessed.delete(key); paint(); drawBal(); }
  }, w));
  paint(); REPAINT.push(paint);
  return [h('span', { class: 'lbl' }, label), wrap];
}

// What the chosen wallet (key = wallet / from / to) holds, and what it will hold after this entry (null = no amount yet).
// When editing, the saved version of the entry is left out, so it isn't counted twice.
function walletPreview(key, base) {
  const a = F.type === 'expense' && F.items.length ? computedTotal() : r2(num(F.amount));
  const w = F[key], now = r2(base[w] || 0);
  if (!(a > 0) || (F.type === 'transfer' && F.from === F.to)) return { w, now, after: null };
  const d = effects({ type: F.type, wallet: F.wallet, from: F.from, to: F.to, amount: a })[w] || 0;
  return { w, now, after: r2(now + d) };
}
function balanceLine(key) {
  const el = h('div', { class: 'small muted', style: 'margin-top:6px' }), base = balances(F.id);
  const money = v => h('span', { class: v < 0 ? 'neg' : null }, `RM ${fmt(v)}`);
  const draw = () => {
    const p = walletPreview(key, base);
    el.textContent = '';
    el.append(`${p.w} ${F.id ? 'before this' : 'now'} `, money(p.now));
    if (p.after != null) el.append(' · after this ', money(p.after));
  };
  draw(); BAL_DRAW.push(draw); REPAINT.push(draw);
  return el;
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

function storeInput(onPicked, onText = () => { }) {
  const idx = storeIndex();
  const box = h('div', { class: 'sugg', hidden: true });
  const inp = h('input', {
    type: 'text', value: F.store, placeholder: 'McD, Lotus\'s Kepong, Lazada…', autocomplete: 'off',
    class: F.guessed.has('store') ? 'guess' : '',
    oninput: ev => { F.store = ev.target.value; F.guessed.delete('store'); inp.classList.remove('guess'); show(); onText(); },
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
      onclick: () => { F.store = s.name; inp.value = s.name; box.hidden = true; onText(); onPicked(true); }
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

// Store field, 📍, "Near you" and "Find new place nearby". The GPS parts are only on a new entry dated today.
function storeRow() {
  const f = F, gps = !F.id && F.date === todayStr() && !!navigator.geolocation;
  const guesses = () => { if (applyStoreGuesses()) REPAINT.forEach(x => x()); };
  if (!gps) return storeInput(guesses);
  const pin = h('button', { type: 'button', 'aria-label': 'I\'m here: remember this place', style: 'flex:0 0 48px;padding:0' }, '📍');
  const status = h('div', { class: 'small muted', style: 'margin-top:4px' });
  const near = h('div', { class: 'chips', style: 'margin-top:6px;min-height:32px;flex-wrap:nowrap;overflow-x:auto;align-items:center' });   // fixed height: no jump when it fills
  const find = h('button', { type: 'button', class: 'btn link small' }, 'Find new place nearby (online)');
  const msg = t => { f.hereMsg = t; draw(); };
  function draw() {
    pin.className = 'btn' + (f.here ? ' primary' : '');
    pin.setAttribute('aria-pressed', f.here ? 'true' : 'false');
    status.textContent = f.hereMsg || (f.here ? `Here (±${Math.round(f.here.acc)} m). Remembered when you Save.` : '');
    status.hidden = !status.textContent;
    const empty = !f.store.trim();
    find.hidden = !empty;
    near.hidden = !empty || !GEO_OK || !S.places.length;
  }
  function drawNear(pos, text) {
    near.textContent = '';
    const list = pos ? nearPlaces(pos) : [];
    near.append(h('span', { class: 'small muted', style: 'white-space:nowrap' }, text || (list.length ? 'Near you:' : 'Near you: none of your saved places')));
    for (const x of list) near.append(h('button', {
      type: 'button', class: 'chip small', style: 'white-space:nowrap', onclick: () => { f.store = x.name; f.guessed.delete('store'); applyStoreGuesses(); go('add', true); }
    }, x.name));
  }
  function locate() {
    if (near.hidden) return;
    if (!(POS && Date.now() - POS.at < 60000)) drawNear(null, 'Near you: locating…');
    getPos().then(p => tooRough(p) ? drawNear(null, 'Near you: ' + tooRough(p)) : drawNear(p), e => drawNear(null, 'Near you: ' + e.message));
  }
  // a position good enough to use, or null (and the reason is shown)
  async function goodPos(wait) {
    msg(wait);
    try {
      let p = await getPos();
      if (tooRough(p)) { POS = null; msg(tooRough(p)); return null; }
      return p;
    } catch (e) { msg(e.message); return null; }
  }
  pin.addEventListener('click', async () => {
    if (f.here) { f.here = null; msg(''); return; }
    const p = await goodPos('Getting your position…');
    if (p) { f.here = { lat: p.lat, lon: p.lon, acc: p.acc }; msg(''); }
  });
  find.addEventListener('click', async () => {
    if (!navigator.onLine) { msg('No internet. Type the name.'); return; }
    find.disabled = true;
    const p = await goodPos('Getting your position…');
    let list = null;
    if (p) {
      msg('Looking up places…');
      try { list = await placeSearch(p); } catch (_) { msg('The map search didn\'t answer. Try again, or type the name.'); }
    }
    find.disabled = false;
    if (!list) return;
    if (F !== f || S.tab !== 'add' || f.type !== 'expense' || f.store.trim() || document.querySelector('dialog[open]')) { msg(''); return; }   // moved on meanwhile
    if (!list.length) { msg('No named places found here. Type the name.'); return; }
    msg('');
    const name = await pickPlace(list);
    if (!name || F !== f || S.tab !== 'add') return;
    f.store = name; f.here = { lat: p.lat, lon: p.lon, acc: p.acc }; f.guessed.delete('store');
    applyStoreGuesses(); go('add', true);
  });
  draw(); locate();
  NEAR_REFRESH = () => { draw(); locate(); };
  return h('div', {}, h('div', { class: 'row' }, h('div', { class: 'grow' }, storeInput(guesses, draw)), pin), status, near, find);
}

function renderExpenseFields(card) {
  card.append(h('span', { class: 'lbl' }, 'Store'),
    storeRow());
  card.append(...walletChips('wallet', SPEND_WALLETS, 'Paid with'), balanceLine('wallet'));

  const hasItems = F.items.length > 0;
  card.classList.toggle('has-items', hasItems);   // room below Save, so a new item can glide to the top
  card.append(h('span', { class: 'lbl' }, hasItems ? 'Category (for all items)' : 'Category'));
  card.append(categoryChips(CFG.expenseCats, () => F.category,
    c => { F.category = c; F.touched.add('category'); F.guessed.delete('category'); REPAINT.forEach(f => f()); }, () => F.guessed.has('category')));

  // amount or items
  if (!hasItems) {
    card.append(h('span', { class: 'lbl' }, 'Amount (RM)'),
      h('input', {
        ...MONEY, class: 'big' + (F.guessed.has('amount') ? ' guess' : ''), value: F.amount, placeholder: '0.00',
        oninput: ev => { F.amount = cashify(ev); F.guessed.delete('amount'); ev.target.classList.remove('guess'); drawBal(); }
      }));
  }
  card.append(h('span', { class: 'lbl' }, hasItems ? 'Items' : 'Items (optional)'));
  const itemsBox = h('div', {});
  card.append(itemsBox);
  const totalLine = h('div', { class: 'totalline' });
  const drawTotal = () => {
    drawBal();
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
        F.items.push({ key: uid(), name: '', qty: '1', unit: money2(F.amount), orig: '', category: '' });
      } else F.items.push({ key: uid(), name: '', qty: '1', unit: '', orig: '', category: '' });
      go('add', true);
      // focus the new item's name without a jump, then glide it to the top so it stays above the keyboard
      const all = document.querySelectorAll('.item'), last = all[all.length - 1];
      if (last) {
        last.querySelector('textarea[name=iname]').focus({ preventScroll: true });
        requestAnimationFrame(() => last.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      }
    }
  }, '+ Add item'));
  card.append(totalLine, budgetLine()); drawTotal();
}

function itemRow(it, i, drawTotal) {
  const sI = () => storeIndex().get(norm(F.store));
  const gItems = globalItems();
  const box = h('div', { class: 'sugg', hidden: true });
  const hintEl = h('div', {});
  const unitInp = h('input', {
    ...MONEY, placeholder: 'Unit price', value: it.unit, 'aria-label': 'Unit price',
    class: it.guessUnit ? 'guess' : '', enterkeyhint: 'next', 'data-nav': '',
    oninput: ev => { it.unit = cashify(ev); it.guessUnit = false; unitInp.classList.remove('guess'); drawTotal(); }
  });
  const sameOpt = h('option', { value: '' });
  const catSel = h('select', { 'aria-label': 'Item category', onchange: ev => { it.category = ev.target.value; paintCat(); drawBal(); } },
    sameOpt,
    CFG.expenseCats.map(c => h('option', { value: c, selected: c === it.category }, c)));
  function paintCat() {
    sameOpt.textContent = mainCat() ? `Same as above: ${mainCat()}` : 'Same as above (not set yet)';
    catSel.classList.toggle('guess', !it.category && F.guessed.has('category'));
  }
  paintCat(); REPAINT.push(paintCat);
  const origWrap = h('div', { class: 'row', hidden: !(it.orig !== '' && it.orig != null) && !it.showOrig },
    h('span', { class: 'small muted', style: 'white-space:nowrap' }, 'Was RM'),
    h('input', { ...MONEY, placeholder: 'original price per unit', value: it.orig ?? '', enterkeyhint: 'next', 'data-nav': '', oninput: ev => { it.orig = cashify(ev); drawTotal(); } }));

  function pickItem(name) {
    it.name = name; nameInp.value = name; box.hidden = true;
    const sIdx = sI(); const here = sIdx && sIdx.items.get(norm(name));
    if (here) {
      const ru = repeated(here.hist.map(x => x.unit));
      if (ru != null && !num(it.unit)) { it.unit = money2(ru); unitInp.value = it.unit; it.guessUnit = true; unitInp.classList.add('guess'); }
      const lastO = here.hist[here.hist.length - 1].orig;
      if (lastO != null && lastO !== '' && (it.orig === '' || it.orig == null)) { it.orig = money2(lastO); origWrap.hidden = false; origWrap.querySelector('input').value = it.orig; }
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
      type: 'button', class: 'hint', onclick: () => { it.unit = money2(last.unit); unitInp.value = it.unit; it.guessUnit = false; unitInp.classList.remove('guess'); drawTotal(); }
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
    h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { style: 'flex:1 0 100%' }, catSel),
      origWrap.hidden ? h('button', { type: 'button', class: 'btn link small', onclick: ev => { it.showOrig = true; origWrap.hidden = false; ev.target.remove(); } }, '+ Original price') : null)
  );
}

function renderIncomeFields(card) {
  card.append(h('span', { class: 'lbl' }, 'From / description'),
    h('input', { type: 'text', value: F.store, placeholder: 'Allowance, part-time pay, TNG GO+…', oninput: ev => (F.store = ev.target.value) }));
  card.append(h('span', { class: 'lbl' }, 'Category'));
  card.append(categoryChips(CFG.incomeCats, () => F.category, c => { F.category = c; F.touched.add('category'); }, () => false));
  card.append(...walletChips('wallet', SPEND_WALLETS.concat(['FD']), 'Received into'), balanceLine('wallet'));
  card.append(h('span', { class: 'lbl' }, 'Amount (RM)'),
    h('input', { ...MONEY, class: 'big', value: F.amount, placeholder: '0.00', oninput: ev => { F.amount = cashify(ev); drawBal(); } }));
}

function renderTransferFields(card) {
  const pairs = transferPairs();
  if (pairs.length && !F.id) card.append(h('span', { class: 'lbl' }, 'Usual transfers'),
    h('div', { class: 'chips' }, pairs.map(p => h('button', {
      type: 'button', class: 'chip small', onclick: () => {
        F.from = p.from; F.to = p.to;
        const top = [...p.amounts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] >= CFG.fillAfter && !F.amount) F.amount = money2(top[0]);
        go('add', true);
      }
    }, `${p.from} → ${p.to}`))));
  card.append(...walletChips('from', ALL_WALLETS, 'From'), balanceLine('from'));
  card.append(...walletChips('to', ALL_WALLETS, 'To'), balanceLine('to'));
  card.append(h('span', { class: 'lbl' }, 'Amount (RM)'),
    h('input', { ...MONEY, class: 'big', value: F.amount, placeholder: '0.00', oninput: ev => { F.amount = cashify(ev); drawBal(); } }));
  const p = pairs.find(x => x.from === F.from && x.to === F.to);
  if (p) {
    const common = [...p.amounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(a => a[0]);
    card.append(h('div', { class: 'chips', style: 'margin-top:6px' }, common.map(a =>
      h('button', { type: 'button', class: 'chip small', onclick: () => { F.amount = money2(a); go('add', true); } }, fmt(a)))));
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
        if (!it.category && !mainCat()) return `Pick a category at the top, or one for “${it.name}”.`;
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
        orig: it.orig === '' || it.orig == null ? null : r2(num(it.orig)), category: it.category || mainCat()
      }));
      e.amount = computedTotal();
      e.category = mainCat() || e.items[0].category;
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
  if (e.type !== 'adjust' && S.noSpend.includes(e.date)) try { await setNoSpend(e.date, false); } catch (_) { }
  await markChanged();
  requestPersist();
  let learned = false;
  if (F.type === 'expense' && !F.id && F.here) try { await rememberPlace(e.store, F.here); learned = true; } catch (_) { }
  const wasEdit = !!F.id;
  F = blankForm(wasEdit ? 'expense' : e.type === 'adjust' ? 'expense' : e.type);
  toast(wasEdit ? 'Changes saved' : learned ? 'Saved · place remembered' : 'Saved');
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
// The Add tab may hold an entry the user started typing: never drop it without asking
async function okToReplace(line) {
  return !(F && !F.id && formDirty()) || ask({ title: 'Replace the entry you started?', lines: [line], ok: 'Replace' });
}
async function openEdit(e) {
  if (!(await okToReplace('What you typed on Add will be cleared so you can edit this entry.'))) return;
  F = formFromEntry(e); go('add');
}
function entryLine(e) {
  let title, sub, amt, cls = '';
  if (e.type === 'expense') {
    title = e.store; amt = '−' + fmt(e.amount);
    sub = [e.items && e.items.length ? `${e.items.length} item${e.items.length > 1 ? 's' : ''}` : e.category, e.wallet].join(' · ');
  } else if (e.type === 'income') { title = e.store || e.category; sub = `${e.category} · into ${e.wallet}`; amt = '+' + fmt(e.amount); cls = 'in'; }
  else if (e.type === 'transfer') { title = `${e.from} → ${e.to}`; sub = 'Transfer'; amt = fmt(e.amount); cls = 'tr'; }
  else { title = `Adjustment · ${e.wallet}`; sub = 'Reconcile'; amt = (e.amount >= 0 ? '+' : '−') + fmt(Math.abs(e.amount)); cls = 'tr'; }
  if (e.note) sub += ' · ' + e.note;
  const row = h('button', { class: 'ent', type: 'button', onclick: () => openEdit(e) },
    h('div', {}, h('div', {}, title), h('div', { class: 'sub' }, sub)), h('div', { class: 'amt ' + cls }, amt));
  const side = [];
  if (e.receipt) side.push(h('button', { class: 'rcpt', type: 'button', 'aria-label': 'View receipt photo', onclick: () => openViewer(e.receipt) }, '🧾'));
  if (e.type !== 'adjust') side.push(h('button', {
    class: 'rcpt rep', type: 'button', 'aria-label': 'Repeat as new entry today', onclick: async () => {
      if (await okToReplace('What you typed on Add will be replaced by a copy of this entry.')) repeatEntry(e);
    }
  }, '↻'));
  if (!side.length) return row;
  return h('div', { class: 'entrow' }, row, ...side);
}

// Copy a saved entry into a new Add form dated today (no photo, no note). The original is untouched.
function repeatEntry(e) {
  if (!e || e.type === 'adjust') return;
  const f = formFromEntry(e);
  Object.assign(f, { id: null, created: null, date: todayStr(), time: nowTime(), note: '', receiptName: null, receiptBlob: null, removeReceipt: false });
  delete f.snap;
  const what = e.type === 'transfer' ? `${e.from} → ${e.to}` : (e.store || e.category);
  f.copiedFrom = `${what}, ${niceDate(e.date)}`;
  F = f; go('add');
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
let SUMV = 'overview';   // which Summary screen is open
function renderSummary(m) {
  m.append(h('div', { class: 'chips', style: 'margin-bottom:10px' }, [['overview', 'Overview'], ['calendar', 'Calendar'], ['budgets', 'Budgets'], ['prices', 'Prices'], ['trends', 'Trends']].map(([v, t]) =>
    h('button', {
      type: 'button', class: 'chip' + (SUMV === v ? ' on' : ''), onclick: () => {
        if (SUMV === v) return;
        SUMV = v; if (v === 'calendar') CAL = { month: todayStr().slice(0, 7), day: todayStr() };
        if (v === 'trends') TRD = { n: TRD.n, cat: null };
        if (v === 'prices') PRC = { q: '', item: null, limit: 30 };
        if (v === 'budgets') BUD = { month: todayStr().slice(0, 7), edit: null };
        go('summary');
      }
    }, t))));
  ({ calendar: renderCalendar, budgets: renderBudgets, prices: renderPrices, trends: renderTrends }[SUMV] || renderOverview)(m);
}
function renderOverview(m) {
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

/* ---------- Calendar (inside Summary) ---------- */
let CAL = { month: '', day: '' };   // 'YYYY-MM' and the chosen day
const cleanDates = list => [...new Set((Array.isArray(list) ? list : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
async function setNoSpend(day, on) {
  S.noSpend = cleanDates(on ? S.noSpend.concat(day) : S.noSpend.filter(d => d !== day));
  await DB.put('meta', S.noSpend, 'noSpend');
}
// Per day: how much was spent, and whether it has an entry (a Reconcile adjustment alone doesn't count).
// first = the first day with an entry: earlier days are never marked as missing.
function dayIndex() {
  const days = new Map(); let first = '';
  for (const e of S.entries) {
    if (e.type === 'adjust') continue;
    if (!first || e.date < first) first = e.date;
    const d = days.get(e.date) || { spent: 0, n: 0 };
    d.n++; if (e.type === 'expense') d.spent = r2(d.spent + num(e.amount));
    days.set(e.date, d);
  }
  return { days, first };
}
// 'has' (entries), 'zero' (marked nothing spent), 'miss' (past day without entries) or '' (today, future, before the first entry)
function dayState(day, ix, today) {
  if (ix.days.has(day)) return 'has';
  if (!ix.first || day < ix.first || day >= today) return '';
  return S.noSpend.includes(day) ? 'zero' : 'miss';
}
const cellMoney = v => (v > 0 && Math.round(v) === 0 ? '<1' : Math.round(v).toLocaleString('en-MY'));
function monthDays(ym) {   // every day of the month, with blanks in front so weeks start on Monday
  const [y, mo] = ym.split('-').map(Number), n = new Date(y, mo, 0).getDate();
  const blanks = (new Date(y, mo - 1, 1).getDay() + 6) % 7;
  return Array(blanks).fill(null).concat(Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`));
}
function shiftMonth(ym, n) { const [y, mo] = ym.split('-').map(Number); return localDate(new Date(y, mo - 1 + n, 1)).slice(0, 7); }
function renderCalendar(m) {
  const today = todayStr(), ix = dayIndex();
  if (!CAL.month) CAL = { month: today.slice(0, 7), day: today };
  const list = monthDays(CAL.month), days = list.filter(Boolean);
  const open = (month, day) => { CAL = { month, day }; go('summary', true); };
  const move = n => { const mo = shiftMonth(CAL.month, n); open(mo, mo === today.slice(0, 7) ? today : ''); };
  m.append(h('div', { class: 'navrow' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous month', onclick: () => move(-1) }, '‹'),
    h('b', {}, `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+CAL.month.slice(5) - 1]} ${CAL.month.slice(0, 4)}`),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Next month', disabled: CAL.month >= today.slice(0, 7), onclick: () => move(1) }, '›')));
  const spent = r2(days.reduce((t, d) => t + (ix.days.has(d) ? ix.days.get(d).spent : 0), 0));
  const miss = days.filter(d => dayState(d, ix, today) === 'miss').length;
  m.append(h('p', { class: 'small muted', style: 'margin:0 0 8px' }, `Spent RM ${fmt(spent)} · ${miss ? `${miss} day${miss > 1 ? 's' : ''} with no entries` : 'no missing days'}`));

  const grid = h('div', { class: 'cal' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => h('div', { class: 'dow' }, d)));
  for (const d of list) {
    if (!d) { grid.append(h('div', {})); continue; }
    const st = dayState(d, ix, today), v = st === 'has' ? ix.days.get(d).spent : 0;
    grid.append(h('button', {
      type: 'button', class: 'cell' + (st === 'miss' ? ' miss' : '') + (d === today ? ' today' : '') + (d === CAL.day ? ' sel' : ''), disabled: d > today,
      'aria-label': `${niceDate(d)}: ${st === 'has' ? `RM ${fmt(v)} spent` : st === 'miss' ? 'no entries' : st === 'zero' ? 'nothing spent' : 'nothing yet'}`,
      'aria-pressed': d === CAL.day ? 'true' : 'false', onclick: () => open(CAL.month, d)
    }, h('span', {}, String(+d.slice(8))), h('span', { class: 'amt' }, st === 'has' ? cellMoney(v) : st === 'miss' ? '?' : st === 'zero' ? '0' : '')));
  }
  m.append(grid, h('p', { class: 'small faint', style: 'margin:6px 0 0' }, '? = past day with no entries · amounts in whole RM'));

  const day = CAL.day;
  if (!day || day.slice(0, 7) !== CAL.month) { m.append(h('p', { class: 'small muted' }, 'Tap a day to see its entries.')); return; }
  const st = dayState(day, ix, today);
  const info = st === 'has' ? `RM ${fmt(ix.days.get(day).spent)} spent` : st === 'zero' ? 'nothing spent' : 'no entries';
  const box = h('div', { class: 'list' }, h('div', { class: 'day' }, h('span', {}, niceDate(day)), h('span', {}, info)));
  for (const e of sortEntries(S.entries.filter(x => x.date === day))) box.append(entryLine(e));
  box.append(h('button', { class: 'btn full', type: 'button', style: 'margin-top:6px', onclick: () => addForDay(day) }, '+ Add an entry for this day'));
  const mark = async on => { await setNoSpend(day, on); await markChanged(); go('summary', true); };
  if (st === 'miss') box.append(h('button', { class: 'btn full', type: 'button', style: 'margin-top:8px', onclick: () => mark(true) }, 'Nothing spent this day'));
  if (st === 'zero') box.append(h('button', { class: 'btn full', type: 'button', style: 'margin-top:8px', onclick: () => mark(false) }, 'Undo "Nothing spent"'));
  m.append(box);
}
async function addForDay(day) {
  if (!(await okToReplace('What you typed on Add will be cleared.'))) return;
  F = blankForm();
  if (day !== todayStr()) Object.assign(F, { date: day, time: '', handDate: true });
  go('add');
}

/* ---------- Price history (inside Summary) ---------- */
let PRC = { q: '', item: null, limit: 30 };   // item = the opened item's key (its normalised name)
const shortDate = d => { const x = parseDate(d); return `${x.getDate()} ${MON[x.getMonth()]}${d.slice(0, 4) === todayStr().slice(0, 4) ? '' : ' ' + d.slice(0, 4)}`; };
// Every item ever bought: key -> {key, name (latest spelling), buys: newest first}
function priceIndex() {
  const m = new Map();
  for (const e of sortEntries(S.entries)) if (e.type === 'expense') for (const it of e.items || []) {
    const k = norm(it.name); if (!k) continue;
    if (!m.has(k)) m.set(k, { key: k, name: it.name, buys: [] });
    m.get(k).buys.push({ date: e.date, store: e.store || '', unit: num(it.unit), qty: num(it.qty || 1), orig: it.orig, e });
  }
  return m;
}
function priceMatches(q) {
  const words = norm(q).split(' ').filter(Boolean);
  return [...priceIndex().values()].filter(x => {
    const hay = x.key + ' ' + [...new Set(x.buys.map(b => norm(b.store)))].join(' ');
    return words.every(w => hay.includes(w));
  });   // already newest first: the index is built from the newest entry back
}
// Free items (RM 0) are listed as purchases but don't count as a price
function priceStats(x) {
  const paid = x.buys.filter(b => b.unit > 0), b = paid.length ? paid : x.buys;
  const pick = f => b.reduce((a, c) => (f(c.unit, a.unit) ? c : a));
  const stores = new Map();
  for (const y of b) {
    const k = norm(y.store);
    if (!stores.has(k)) stores.set(k, { store: y.store, last: y.unit, n: 0 });
    stores.get(k).n++;
  }
  return {
    n: x.buys.length, last: b[0], low: pick((c, a) => c < a), high: pick((c, a) => c > a), avg: r2(b.reduce((t, y) => t + y.unit, 0) / b.length),
    stores: [...stores.values()].sort((a, c) => a.last - c.last)
  };
}
const times = n => `${n} time${n === 1 ? '' : 's'}`;
function renderPrices(m) {
  const x = PRC.item && priceIndex().get(PRC.item);
  if (x) { renderPriceItem(m, x); return; }
  PRC.item = null;
  const list = h('div', { style: 'margin-top:10px' });
  m.append(h('input', { type: 'search', placeholder: 'Search item or store', value: PRC.q, 'aria-label': 'Search item or store', oninput: ev => { PRC.q = ev.target.value; PRC.limit = 30; draw(); } }), list);
  function draw() {
    list.textContent = '';
    const all = priceMatches(PRC.q);
    if (!all.length) { list.append(h('p', { class: 'muted' }, norm(PRC.q) ? 'Nothing matches that search.' : 'No items yet. Prices come from expenses with items.')); return; }
    for (const y of all.slice(0, PRC.limit)) {
      const l = priceStats(y).last;
      list.append(h('button', { class: 'ent', type: 'button', onclick: () => { PRC.item = y.key; go('summary'); } },
        h('div', { style: 'min-width:0' }, h('div', {}, y.name), h('div', { class: 'sub' }, `${l.store} · ${shortDate(l.date)} · ${times(y.buys.length)}`)), h('div', { class: 'amt' }, fmt(l.unit))));
    }
    if (all.length > PRC.limit) list.append(h('button', { class: 'btn full', type: 'button', onclick: () => { PRC.limit += 30; draw(); } }, 'Show more'));
  }
  draw();
}
function renderPriceItem(m, x) {
  const st = priceStats(x);
  m.append(h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('button', { class: 'btn', type: 'button', style: 'min-width:44px', 'aria-label': 'Back to the list', onclick: () => { PRC.item = null; go('summary'); } }, '‹'),
    h('div', { class: 'grow' }, h('b', {}, x.name), h('div', { class: 'small muted' }, `bought ${times(st.n)}`))));
  const line = (t, b) => h('div', { class: 'wl' }, h('span', {}, t), h('span', {}, h('span', { class: 'v' }, fmt(b.unit)), h('span', { class: 'small muted' }, ` ${b.store} · ${shortDate(b.date)}`)));
  m.append(h('div', { class: 'card' }, line('Last', st.last), line('Lowest', st.low), line('Highest', st.high),
    h('div', { class: 'wl' }, h('span', {}, 'Average'), h('span', { class: 'v' }, fmt(st.avg)))));
  m.append(h('div', { class: 'card' }, h('b', {}, 'By store'), h('div', { class: 'small muted' }, 'Last price there, lowest first'),
    st.stores.map(y => h('div', { class: 'wl' }, h('span', {}, y.store), h('span', {}, h('span', { class: 'v' }, fmt(y.last)), h('span', { class: 'small muted' }, ` · ${times(y.n)}`))))));
  m.append(h('span', { class: 'lbl' }, 'Purchases (tap to open)'));
  for (const b of x.buys) m.append(h('button', { class: 'ent', type: 'button', onclick: () => openEdit(b.e) },
    h('div', { style: 'min-width:0' }, h('div', {}, b.store), h('div', { class: 'sub' }, niceDate(b.date))),
    h('div', { class: 'amt', style: 'text-align:right' }, `${b.qty === 1 ? '' : b.qty + ' × '}${fmt(b.unit)}`, b.orig != null && num(b.orig) > b.unit ? h('div', { class: 'small muted', style: 'font-weight:400' }, `was ${fmt(b.orig)}`) : null)));
}

/* ---------- Trends (inside Summary) ---------- */
let TRD = { n: 6, cat: null };   // months shown; the opened category
// The last n months up to the current one, oldest first, not before the first entry.
// full = counts in averages: not the current month, and not a first month that began part-way.
function trendData(n) {
  const today = todayStr(), cur = today.slice(0, 7), first = dayIndex().first;
  if (!first || first.slice(0, 7) > cur) return [];
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ym = shiftMonth(cur, -i);
    if (ym < first.slice(0, 7)) continue;
    out.push({ ym, income: 0, spent: 0, cats: new Map(), full: ym < cur && !(ym === first.slice(0, 7) && first.slice(8) !== '01') });
  }
  const at = new Map(out.map(x => [x.ym, x]));
  for (const e of S.entries) {
    const x = at.get(e.date.slice(0, 7)); if (!x) continue;
    if (e.type === 'income') x.income = r2(x.income + num(e.amount));
    if (e.type !== 'expense') continue;
    x.spent = r2(x.spent + num(e.amount));
    for (const l of expenseLines(e)) x.cats.set(l.category, r2((x.cats.get(l.category) || 0) + l.amount));
  }
  return out;
}
// average of f over the full months, or null when there is none yet
function trendAvg(data, f) { const d = data.filter(x => x.full); return d.length ? r2(d.reduce((t, x) => t + f(x), 0) / d.length) : null; }
const monthShort = ym => `${MON[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
const soFar = ym => monthShort(ym) + (ym === todayStr().slice(0, 7) ? ' so far' : '');
const hbar = (cls, v, top) => h('div', { class: 'hb' }, h('div', { class: 'fill ' + cls, style: `width:${top > 0 ? Math.max(0, v / top * 100).toFixed(2) : 0}%` }));
function renderTrends(m) {
  m.append(h('div', { class: 'chips', style: 'margin-bottom:10px' }, [6, 12].map(n => h('button', {
    type: 'button', class: 'chip small' + (TRD.n === n ? ' on' : ''), onclick: () => { TRD.n = n; go('summary', true); }
  }, `${n} months`))));
  const data = trendData(TRD.n);
  if (!data.length) { m.append(h('p', { class: 'muted' }, 'No entries yet.')); return; }
  if (TRD.cat) { renderTrendCat(m, data, TRD.cat); return; }
  const top = Math.max(...data.map(x => Math.max(x.income, x.spent)));
  const card = h('div', { class: 'card' }, h('b', {}, 'Income vs spending'));
  for (const x of data.slice().reverse()) {
    const left = r2(x.income - x.spent);
    card.append(h('div', { class: 'tm' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, soFar(x.ym)), h('span', { class: 'small ' + (left < 0 ? 'neg' : 'muted') }, `left over ${left < 0 ? '−' : '+'}${fmt(Math.abs(left))}`)),
      h('div', { class: 'trow' }, h('span', { class: 'k' }, 'Income'), hbar('inc', x.income, top), h('span', { class: 'n' }, fmt(x.income))),
      h('div', { class: 'trow' }, h('span', { class: 'k' }, 'Spent'), hbar('spe', x.spent, top), h('span', { class: 'n' }, fmt(x.spent)))));
  }
  const ai = trendAvg(data, x => x.income), as = trendAvg(data, x => x.spent);
  card.append(h('p', { class: 'small muted', style: 'margin:12px 0 0' }, ai == null ? 'Average: no full month yet.' : `Average per full month: income ${fmt(ai)}, spending ${fmt(as)}`));
  m.append(card);

  const totals = new Map();
  for (const x of data) for (const [c, v] of x.cats) totals.set(c, (totals.get(c) || 0) + v);
  const cats = [...totals.entries()].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const cc = h('div', { class: 'card' }, h('div', { class: 'tc muted', style: 'font-size:12px' }, h('b', { style: 'color:var(--text);font-size:16px' }, 'By category'), h('span', {}), h('span', { class: 'n' }, 'this month'), h('span', { class: 'n' }, 'average')));
  if (!cats.length) cc.append(h('p', { class: 'muted small' }, 'No spending in these months.'));
  for (const c of cats) {
    const vals = data.map(x => x.cats.get(c) || 0), mx = Math.max(...vals), av = trendAvg(data, x => x.cats.get(c) || 0);
    cc.append(h('button', { type: 'button', class: 'tc', 'aria-label': `${c}: this month ${fmt(vals[vals.length - 1])}, average ${av == null ? 'not yet' : fmt(av)}`, onclick: () => { TRD.cat = c; go('summary'); } },
      h('span', { class: 'nm' }, c),
      h('span', { class: 'mini', 'aria-hidden': 'true' }, vals.map(v => h('i', { style: `height:${v > 0 ? Math.max(2, Math.round(v / mx * 22)) : 0}px` }))),
      h('span', { class: 'n' }, fmt(vals[vals.length - 1])), h('span', { class: 'n' }, av == null ? '–' : fmt(av))));
  }
  if (cats.length) cc.append(h('p', { class: 'small faint', style: 'margin:8px 0 0' }, 'Small bars: oldest month left. Each row has its own scale. Tap a row for the amounts.'));
  m.append(cc);
}
function renderTrendCat(m, data, c) {
  const val = x => x.cats.get(c) || 0, top = Math.max(...data.map(val)), av = trendAvg(data, val);
  m.append(h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('button', { class: 'btn', type: 'button', style: 'min-width:44px', 'aria-label': 'Back to Trends', onclick: () => { TRD.cat = null; go('summary'); } }, '‹'), h('b', { class: 'grow' }, c)));
  const card = h('div', { class: 'card' });
  for (const x of data.slice().reverse()) {
    const v = val(x), L = limitsFor(x.ym)[c], st = L > 0 ? limitState(v, L) : '';
    card.append(h('div', { class: 'tm' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, soFar(x.ym)),
        h('span', { class: st === 'over' ? 'neg' : st === 'near' ? 'near' : '' }, fmt(v) + (L > 0 ? ` / ${fmt(L)}` : '') + (st ? ' ' + st : ''))),
      hbar('spe', v, top)));
  }
  card.append(h('p', { class: 'small muted', style: 'margin:12px 0 0' }, av == null ? 'Average: no full month yet.' : `Average per full month: ${fmt(av)}`));
  m.append(card);
}

/* ---------- Budgets (inside Summary) ---------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => `${MONTHS[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
let BUD = { month: '', edit: null };   // edit = {category: text} while the limits are being changed
function cleanBudgets(list) {
  const m = new Map();
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || !/^\d{4}-\d{2}$/.test(b.from) || typeof b.limits !== 'object' || !b.limits) continue;
    m.set(b.from, { from: b.from, limits: Object.fromEntries(Object.entries(b.limits).map(([c, v]) => [c, r2(num(v))]).filter(x => x[1] > 0)) });
  }
  return [...m.values()].sort((a, b) => a.from.localeCompare(b.from));
}
// The limits of a month: the latest record from that month or earlier (past months keep the limits they had)
function limitsFor(ym) {
  let l = {};
  for (const b of S.budgets) if (b.from <= ym) l = b.limits;
  return l;
}
async function setLimits(limits, ym = todayStr().slice(0, 7)) {
  S.budgets = cleanBudgets(S.budgets.filter(b => b.from !== ym).concat({ from: ym, limits }));
  await DB.put('meta', S.budgets, 'budgets');
}
function spentByCat(ym, skipId = null) {
  const m = new Map();
  for (const e of S.entries) if (e.type === 'expense' && e.id !== skipId && e.date.slice(0, 7) === ym)
    for (const l of expenseLines(e)) m.set(l.category, r2((m.get(l.category) || 0) + l.amount));
  return m;
}
const limitState = (v, limit) => (v > limit + 0.004 ? 'over' : v >= limit * CFG.nearLimit - 0.004 ? 'near' : '');
const pct = (v, limit) => Math.floor(v / limit * 100 + 1e-9);
const budDirty = () => JSON.stringify(BUD.edit) !== BUD.snap;
function renderBudgets(m) {
  const cur = todayStr().slice(0, 7);
  if (!BUD.month) BUD.month = cur;
  if (BUD.edit) { renderLimits(m, cur); return; }
  const move = n => { BUD.month = shiftMonth(BUD.month, n); go('summary', true); };
  m.append(h('div', { class: 'navrow' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous month', onclick: () => move(-1) }, '‹'),
    h('b', {}, monthName(BUD.month)),
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Next month', disabled: BUD.month >= cur, onclick: () => move(1) }, '›')));
  const limits = limitsFor(BUD.month), spent = spentByCat(BUD.month), got = c => spent.get(c) || 0;
  const cats = [...new Set(CFG.expenseCats.concat(Object.keys(limits), [...spent.keys()]))].filter(Boolean);
  const withL = cats.filter(c => limits[c] > 0), without = cats.filter(c => !(limits[c] > 0) && got(c) > 0);
  const card = h('div', { class: 'card' });
  if (!withL.length) card.append(h('p', { class: 'small muted', style: 'margin:0' }, `No limits for ${monthName(BUD.month)}.` + (BUD.month === cur ? ' Tap Edit limits to set some.' : '')));
  else card.append(h('div', { class: 'small muted' }, `With limits: RM ${fmt(withL.reduce((t, c) => t + got(c), 0))} of ${fmt(withL.reduce((t, c) => t + limits[c], 0))}`));
  for (const c of withL) {
    const v = got(c), L = limits[c], st = limitState(v, L);
    card.append(h('div', { class: 'barrow' },
      h('div', { class: 'row' }, h('span', {}, c), h('span', { class: 'small ' + (st === 'over' ? 'neg' : st === 'near' ? 'near' : 'muted'), style: 'text-align:right' },
        `${fmt(v)} / ${fmt(L)} · ${pct(v, L)}%${st === 'over' ? ` · over ${fmt(v - L)}` : st === 'near' ? ' · near' : ''}`)),
      h('div', { class: 'track' }, h('div', { class: 'bar ' + st, style: `width:${Math.min(100, v / L * 100)}%` }))));
  }
  if (without.length) card.append(h('p', { class: 'small muted', style: 'margin:12px 0 0' }, 'No limit: ' + without.map(c => `${c} ${fmt(got(c))}`).join(' · ')));
  m.append(card);
  m.append(h('button', {
    class: 'btn full', type: 'button', onclick: () => {
      const l = limitsFor(cur); BUD.edit = {};
      for (const c of CFG.expenseCats) BUD.edit[c] = l[c] ? money2(l[c]) : '';
      BUD.snap = JSON.stringify(BUD.edit); go('summary');
    }
  }, 'Edit limits'));
}
function renderLimits(m, cur) {
  const card = h('div', { class: 'card' }, h('b', {}, 'Monthly limits'),
    h('p', { class: 'small muted' }, `From ${monthName(cur)} on. Earlier months keep their limits. Leave blank for no limit.`));
  for (const c of CFG.expenseCats) card.append(h('div', { class: 'row', style: 'margin-top:6px' },
    h('span', { style: 'flex:1' }, c),
    h('div', { style: 'width:130px' }, h('input', { ...MONEY, value: BUD.edit[c], placeholder: 'no limit', 'aria-label': `Limit for ${c}`, oninput: ev => { BUD.edit[c] = cashify(ev); } }))));
  card.append(h('div', { class: 'row', style: 'margin-top:12px' },
    h('button', { class: 'btn', type: 'button', onclick: () => handleBack() }, 'Cancel'),
    h('button', {
      class: 'btn primary grow', type: 'button', onclick: async () => {
        if (budDirty()) {
          const keep = Object.fromEntries(Object.entries(limitsFor(cur)).filter(([c]) => !CFG.expenseCats.includes(c)));
          await setLimits({ ...keep, ...Object.fromEntries(Object.entries(BUD.edit).map(([c, v]) => [c, r2(num(v))])) }, cur);
          await markChanged(); requestPersist(); toast('Limits saved');
        }
        BUD.edit = null; BUD.month = cur; go('summary');
      }
    }, 'Save limits')));
  m.append(card);
}
// Add/Edit: one line per category that is near or over its limit in the entry's own month (the entry being edited isn't counted twice)
function budgetWarnings(base) {
  const lim = limitsFor(F.date.slice(0, 7)), here = new Map();
  if (F.items.length) for (const it of F.items) { const c = it.category || mainCat(); if (c) here.set(c, r2((here.get(c) || 0) + itemTotal(it))); }
  else if (mainCat()) here.set(mainCat(), r2(num(F.amount)));
  const out = [];
  for (const [c, a] of here) {
    if (!(lim[c] > 0)) continue;
    const before = base.get(c) || 0, after = r2(before + a), st = limitState(after, lim[c]);
    if (!st) continue;
    const when = F.date.slice(0, 7) === todayStr().slice(0, 7) ? 'this month' : `in ${monthName(F.date.slice(0, 7))}`;
    out.push({ st, text: `${st === 'over' ? 'Over limit' : 'Near limit'} · ${c}: RM ${fmt(before)} of ${fmt(lim[c])} ${when}` + (a > 0 ? ` · after this RM ${fmt(after)} (${pct(after, lim[c])}%)` : '') });
  }
  return out;
}
function budgetLine() {
  const el = h('div', {});
  let key = '', base = null;
  const draw = () => {
    const k = F.date.slice(0, 7);
    if (k !== key) { key = k; base = spentByCat(k, F.id); }
    el.textContent = '';
    for (const w of budgetWarnings(base)) el.append(h('div', { class: 'budwarn ' + w.st }, w.text));
  };
  draw(); BAL_DRAW.push(draw); REPAINT.push(draw);
  return el;
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
    inputs[w] = h('input', { ...MONEY, value: S.settings.opening[w] ? money2(S.settings.opening[w]) : '', placeholder: '0.00', oninput: cashify });
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

  // saved places (GPS)
  const pl = h('details', { class: 'card' }, h('summary', {}, h('b', {}, `Saved places (${S.places.length})`)),
    h('p', { class: 'small muted' }, S.places.length ? 'Stores the app suggests when you are near them. Kept on this phone and in full backups only.'
      : 'None yet. On Add, tap 📍 beside Store while you are there, or pick a name from Find new place nearby.'));
  for (const p of S.places.slice().sort((a, b) => a.name.localeCompare(b.name))) pl.append(h('div', { class: 'wl' },
    h('span', {}, p.name),
    h('span', { class: 'row' }, h('span', { class: 'small muted', style: 'white-space:nowrap' }, `${p.spots.length} spot${p.spots.length > 1 ? 's' : ''}`),
      h('button', {
        class: 'btn link small', type: 'button', onclick: async () => {
          if (!(await ask({ title: `Forget where ${p.name} is?`, lines: ['Only the position is removed. Your entries are not affected.'], ok: 'Forget' }))) return;
          S.places = S.places.filter(x => x !== p); await DB.put('meta', S.places, 'places');
          toast('Place removed'); go('wallets', true);
          const d = document.querySelector('details.places'); if (d) d.open = true;
        }
      }, 'Remove'))));
  pl.classList.add('places');
  m.append(pl);

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
  const inp = h('input', { ...MONEY, placeholder: fmt(current), oninput: cashify });
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
  data.noSpend = S.noSpend;
  data.budgets = S.budgets;
  if (full) data.places = S.places;   // positions go into the full backup only (the weekly ZIP may travel by Telegram)
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
    const nMiss = (data.receipts || []).length - nPh;
    if (!(await ask({
      title: 'Restore from this file?',
      lines: [`${file.name}: ${nNew} entr${nNew === 1 ? 'y' : 'ies'} and ${nPh} photo${nPh === 1 ? '' : 's'}.`,
        nMiss ? `⚠ ${nMiss} older photo${nMiss === 1 ? ' isn\'t' : 's aren\'t'} in this file. After restoring, the next Sync will move ${nMiss === 1 ? 'it' : 'them'} on the laptop to Receipts\\_removed. Use a Full backup to bring every photo back.` : '',
        data.places ? `· Saved places: ${cleanPlaces(data.places).length} in this file will replace the ${S.places.length} on this phone.` : S.places.length ? '· Saved places on this phone are kept.' : '',
        `· This replaces everything on this phone (${nNow} entr${nNow === 1 ? 'y' : 'ies'} now).`],
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
    if (data.places) await DB.put('meta', cleanPlaces(data.places), 'places');
    if (data.budgets) await DB.put('meta', cleanBudgets(data.budgets), 'budgets');
    if (data.noSpend) await DB.put('meta', cleanDates(data.noSpend), 'noSpend');
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
  if (S.tab === 'summary' && SUMV === 'budgets' && BUD.edit) {
    if (budDirty() && !(await ask({ title: 'Discard changes?', lines: ['Your changes to the limits will be lost.'], ok: 'Discard' }))) return;
    BUD.edit = null; go('summary'); return;
  }
  if (S.tab === 'summary' && SUMV === 'prices' && PRC.item) { PRC.item = null; go('summary'); return; }
  if (S.tab === 'summary' && SUMV === 'trends' && TRD.cat) { TRD.cat = null; go('summary'); return; }
  if (S.tab === 'summary' && SUMV !== 'overview') { SUMV = 'overview'; go('summary'); return; }
  if (S.tab !== 'add') { go('add'); return; }
  if (formDirty() && await ask({ title: 'Discard this entry?', lines: ['What you have typed will be cleared.'], ok: 'Discard' })) {
    F = blankForm(F.type); go('add');
  }
}
addEventListener('popstate', () => {
  backArmed = false;
  if (atHome()) {            // nothing to step back from: warn once, a second Back within 2 s closes the app
    toast('Press back again to exit');   // the guard comes back on the next tap
    return;
  }
  armBack(); handleBack();
});
// Chrome only honours a guard added during a real tap or key press, so re-arm on click/keydown (not at load, not on a timer)
document.addEventListener('click', armBack, true);
document.addEventListener('keydown', armBack, true);

/* ---------- Keep the date/time of an empty Add form current ---------- */
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshDateTime(); if (NEAR_REFRESH && F && !F.store.trim()) NEAR_REFRESH(); } });
addEventListener('pageshow', refreshDateTime);
document.addEventListener('focusin', ev => {
  if (S.tab === 'add' && ev.target.closest && ev.target.closest('#main') && !ev.target.matches('input[type=date], input[type=time]')) refreshDateTime();
});

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
  geoInit().then(() => { if (NEAR_REFRESH) NEAR_REFRESH(); });   // not awaited: the app must open even if this never answers
  history.replaceState({ app: 'root' }, '');   // the Back guard is added on the first tap
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
