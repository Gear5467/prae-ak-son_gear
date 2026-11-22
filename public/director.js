/* เว็บผู้ควบคุม (Director / Designer / Spotter) — vanilla JS ไม่ต้อง build */
'use strict';
const $ = id => document.getElementById(id);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}
const clone = g => g.map(r => r.slice());
const fmt = n => Number(n).toLocaleString('th-TH');
let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2600); }

/* ---------- สถานะ ---------- */
let token = localStorage.getItem('cs_dir_token');
let D = null, L = null, pal = {};
let live = { status: 'idle', imageIndex: 0, startAt: 0, beatMs: 800, seq: 0 };
let stats = null, marks = [];
let tab = localStorage.getItem('cs_dir_tab') || 'setup';
let offset = 0;
const serverNow = () => Date.now() + offset;

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { logout(); throw new Error('ต้องล็อกอินใหม่'); }
  if (!r.ok) throw new Error(j.error || 'เกิดข้อผิดพลาด');
  return j;
}
async function load() {
  D = await api('GET', '/api/data');
  setLayout();
  if (D.live) live = D.live;
}
function setLayout() { L = Stunt.layout(D.stand); pal = Object.fromEntries(D.palette.map(c => [c.id, c])); }

/* ---------- ล็อกอิน ---------- */
function logout() { token = null; localStorage.removeItem('cs_dir_token'); $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    token = j.token; localStorage.setItem('cs_dir_token', token); start();
  } catch (err) { $('loginErr').textContent = err.message; }
};

async function start() {
  try { await load(); } catch (e) { return logout(); }
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  connectWs(); render();
}

/* ---------- WebSocket ---------- */
let ws, wsRetry = 0;
function connectWs() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    wsRetry = 0; ws.send(JSON.stringify({ t: 'hello', role: 'director', token }));
    setConn(true);
    // ซิงค์นาฬิกาแบบเดียวกับเครื่องนักเรียน (ใช้แสดงจังหวะบนหน้าผู้ควบคุม)
    let best = Infinity;
    for (let i = 0; i < 8; i++) setTimeout(() => wsSend({ t: 'ping', c: Date.now() }), i * 100);
    ws._best = () => best; ws._setBest = v => { best = v; };
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'pong') { const t = Date.now(), rtt = t - m.c; if (rtt < ws._best()) { ws._setBest(rtt); offset = m.s + rtt / 2 - t; } }
    else if (m.t === 'live') { live = m.live; if (tab === 'live') updateLive(); if (tab === 'spot') renderSpotCanvas(true); }
    else if (m.t === 'stats') { stats = m; if (tab === 'live') updateLive(); }
    else if (m.t === 'marks') { marks = m.marks; if (tab === 'spot') renderSpotCanvas(); }
    else if (m.t === 'published') { D.published = m.published; }
    else if (m.t === 'error' && m.error === 'auth') logout();
  };
  ws.onclose = () => { setConn(false); if (token) setTimeout(connectWs, Math.min(5000, 500 * 2 ** wsRetry++)); };
}
function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function setConn(ok) { const c = $('conn'); c.textContent = ok ? 'เชื่อมต่อแล้ว' : 'ขาดการเชื่อมต่อ'; c.className = 'pill ' + (ok ? 'ok' : 'bad'); }

/* ---------- วาดกริด ---------- */
function drawGrid(cv, grid, o = {}) {
  const W = L.width, H = L.height;
  let cs = o.cs;
  if (!cs) {
    const mw = o.maxW || (cv.parentElement && cv.parentElement.clientWidth) || 600;
    cs = Math.max(1, Math.floor(Math.min(mw / W, (o.maxH || 420) / H)));
  }
  // วาดที่ความละเอียดจอจริง (จอ Retina) ให้เส้นคม
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  cv.width = W * cs * dpr; cv.height = H * cs * dpr;
  if (!o.fluid) { cv.style.width = W * cs + 'px'; cv.style.height = H * cs + 'px'; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#20242e'; g.fillRect(0, 0, W * cs, H * cs);
  const gp = cs >= 6 ? 1 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = L.cellAt[y][x];
    if (!s) continue;
    let col;
    if (!s.active) col = '#3d4250';
    else if (o.colorFn) col = o.colorFn(s);
    else { const c = grid && grid[y] && pal[grid[y][x]]; col = c ? c.hex : '#ffffff'; }
    g.fillStyle = col; g.fillRect(x * cs, y * cs, cs - gp, cs - gp);
  }
  if (o.overlay) o.overlay(g, cs);
  cv._cs = cs;
  return cs;
}
function cellFromEvent(cv, e) {
  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * L.width);
  const y = Math.floor((e.clientY - r.top) / r.height * L.height);
  return { x: Math.max(0, Math.min(L.width - 1, x)), y: Math.max(0, Math.min(L.height - 1, y)) };
}
const imgGrid = img => Stunt.fitGrid(img.frames[0].grid, L.width, L.height);
function thumb(grid, w = 260, hgt = 90) { const cv = h('canvas', { class: 'grid' }); drawGrid(cv, grid, { maxW: w, maxH: hgt, fluid: true }); return cv; }

/* แปลงภาพวาดบน canvas เป็นกริดสีที่ใกล้ที่สุดในชุดสีแผ่น */
function rasterize(draw, bgId) {
  const S = 6, W = L.width, H = L.height;
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const g = cv.getContext('2d');
  if (bgId) { g.fillStyle = (pal[bgId] || D.palette[0]).hex; g.fillRect(0, 0, cv.width, cv.height); }
  draw(g, cv.width, cv.height);
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const out = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
      const i = ((y * S + (S >> 1)) * cv.width + x * S + (S >> 1)) * 4;
      row.push(d[i + 3] < 100 ? null : Stunt.nearestColor(D.palette, d[i], d[i + 1], d[i + 2]));
    }
    out.push(row);
  }
  return out;
}
const hx = id => (pal[id] ? pal[id].hex : ({ w: '#fff', k: '#000', b: '#38bdf8', p: '#f472b6', r: '#dc2626', n: '#1e3a8a', y: '#facc15' })[id] || '#888');

/* ---------- แท็บ ---------- */
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; localStorage.setItem('cs_dir_tab', tab); render(); });
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const m = $('main'); m.innerHTML = '';
  ({ setup: renderSetup, library: renderLibrary, editor: renderEditor, show: renderShow, live: renderLive, spot: renderSpot })[tab](m);
}

/* ================= 1. ตั้งค่าสแตนด์ ================= */
function rowsToText(rows) { return rows.every(r => r === rows[0]) ? `${rows[0]}x${rows.length}` : rows.join(','); }
function textToRows(t) {
  t = t.trim();
  const m = t.match(/^(\d+)\s*[x×*]\s*(\d+)$/);
  if (m) return Array(+m[2]).fill(+m[1]);
  const a = t.split(/[,\s]+/).filter(Boolean).map(Number);
  return a.length && a.every(n => n >= 1 && n <= 99) ? a : null;
}
function renderSetup(m) {
  let st = JSON.parse(JSON.stringify(D.stand));
  let palette = JSON.parse(JSON.stringify(D.palette));
  const zoneBox = h('tbody');
  const prev = h('canvas', { class: 'grid' });
  const hover = h('span', { class: 'muted' }, 'ชี้ที่ช่องเพื่อดูรหัสที่นั่ง · คลิกเพื่อทำเครื่องหมาย “ไม่ใช้” (เสา/บันได)');
  const summary = h('span', { class: 'muted' });
  let tmpL = Stunt.layout(st);

  function redraw() {
    try { tmpL = Stunt.layout(st); } catch (e) { return; }
    const oldL = L; L = tmpL;
    drawGrid(prev, null, { maxW: Math.min(1300, m.clientWidth - 40), maxH: 360, colorFn: s => (s.active ? '#d6dbe3' : '#3d4250') });
    L = oldL;
    summary.textContent = `กว้าง ${tmpL.width} × สูง ${tmpL.height} ช่อง · ใช้งาน ${fmt(tmpL.activeCount)} ที่นั่ง`;
  }
  function zoneRows() {
    zoneBox.innerHTML = '';
    st.zones.forEach((z, i) => {
      zoneBox.append(h('tr', null,
        h('td', null, h('input', { value: z.id, style: 'width:60px', oninput: e => { z.id = e.target.value.toUpperCase(); redraw(); } })),
        h('td', null, h('input', { value: rowsToText(z.rows), style: 'width:100%', title: 'เช่น 24x20 (24 ที่นั่ง × 20 แถว) หรือ 20,20,22,22 (เรียงจากแถว 1)',
          oninput: e => { const r = textToRows(e.target.value); e.target.style.borderColor = r ? '' : 'var(--bad)'; if (r) { z.rows = r; redraw(); } } })),
        h('td', null, `${z.rows.length} แถว`),
        h('td', null, h('button', { onclick: () => { st.zones.splice(i, 1); zoneRows(); redraw(); }, disabled: st.zones.length < 2 }, 'ลบ'))));
    });
  }
  prev.onmousemove = e => { const c = cellFromEventL(prev, e, tmpL); const s = tmpL.cellAt[c.y][c.x]; hover.textContent = s ? `${s.id}${s.active ? '' : ' (ไม่ใช้)'}` : 'ทางเดิน'; };
  prev.onclick = e => {
    const c = cellFromEventL(prev, e, tmpL); const s = tmpL.cellAt[c.y][c.x]; if (!s) return;
    const set = new Set(st.blocked); set.has(s.id) ? set.delete(s.id) : set.add(s.id); st.blocked = [...set]; redraw();
  };

  const palBox = h('tbody');
  function palRows() {
    palBox.innerHTML = '';
    palette.forEach((c, i) => palBox.append(h('tr', null,
      h('td', null, h('input', { type: 'color', value: c.hex, oninput: e => { c.hex = e.target.value; } })),
      h('td', null, h('input', { value: c.name, oninput: e => { c.name = e.target.value; } })),
      h('td', null, h('input', { type: 'number', value: c.cardFace, min: 0, style: 'width:70px', oninput: e => { c.cardFace = +e.target.value; } })),
      h('td', { class: 'muted small' }, c.id),
      h('td', null, h('button', { disabled: palette.length < 2, onclick: () => { palette.splice(i, 1); palRows(); } }, 'ลบ')))));
  }

  m.append(
    h('div', { class: 'card' },
      h('h2', null, 'ผังสแตนด์'),
      h('div', { class: 'row' },
        h('label', null, 'ชื่อ ', h('input', { value: st.name, oninput: e => { st.name = e.target.value; } })),
        h('label', null, 'ทางเดินระหว่างโซน ', h('input', { type: 'number', min: 0, max: 5, value: st.gap, oninput: e => { st.gap = +e.target.value; redraw(); } }), ' ช่อง'),
        h('label', null, 'เลขที่ 1 อยู่ ', h('select', { onchange: e => { st.numbering = e.target.value; redraw(); } },
          h('option', { value: 'audienceLeft', selected: st.numbering !== 'audienceRight' }, 'ซ้ายสุด (มองจากฝั่งตรงข้าม)'),
          h('option', { value: 'audienceRight', selected: st.numbering === 'audienceRight' }, 'ขวาสุด (มองจากฝั่งตรงข้าม)')))),
      h('p', { class: 'muted small' }, 'โซนเรียงจากซ้ายไปขวาตามที่ผู้ชมฝั่งตรงข้ามเห็น · แถว 1 คือแถวติดสนาม (ล่างสุดของภาพ) · รหัสที่นั่ง = โซน-แถว-เลขที่ เช่น B-12-07'),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'โซน'), h('th', null, 'ที่นั่งต่อแถว'), h('th', null, ''), h('th', null, ''))), zoneBox),
      h('div', { class: 'row', style: 'margin:10px 0' },
        h('button', { onclick: () => { const ids = st.zones.map(z => z.id); let c = 65; while (ids.includes(String.fromCharCode(c))) c++; st.zones.push({ id: String.fromCharCode(c), rows: Array(20).fill(24) }); zoneRows(); redraw(); } }, '+ เพิ่มโซน'),
        summary),
      h('div', { class: 'scroll' }, prev), hover,
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'primary', onclick: async () => {
          try { await api('PUT', '/api/stand', st); await load(); toast('บันทึกผังแล้ว · ภาพเดิมจะถูกย่อ/ขยายให้พอดี ต้องกดเผยแพร่ใหม่'); render(); } catch (e) { toast(e.message); }
        } }, 'บันทึกผัง'),
        h('button', { onclick: () => { st.blocked = []; redraw(); } }, 'ล้างช่องไม่ใช้'))),
    h('div', { class: 'card' },
      h('h2', null, 'ชุดสีแผ่น'),
      h('p', { class: 'muted small' }, 'ใส่เฉพาะสีที่มีจริงบนแผ่น และเลขหน้าแผ่นที่ตรงกับสีนั้น ภาพทุกภาพใช้ได้เฉพาะสีในชุดนี้'),
      h('table', null, h('thead', null, h('tr', null, h('th', null, 'สี'), h('th', null, 'ชื่อสี'), h('th', null, 'หน้าแผ่น'), h('th', null, 'รหัส'), h('th', null, ''))), palBox),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { onclick: () => { let n = palette.length; while (palette.some(c => c.id === 'c' + n)) n++; palette.push({ id: 'c' + n, name: 'สีใหม่', hex: '#22c55e', cardFace: palette.length + 1 }); palRows(); } }, '+ เพิ่มสี'),
        h('button', { class: 'primary', onclick: async () => { try { await api('PUT', '/api/palette', palette); await load(); toast('บันทึกชุดสีแล้ว'); } catch (e) { toast(e.message); } } }, 'บันทึกชุดสี')))
  );
  zoneRows(); palRows(); redraw();
}
function cellFromEventL(cv, e, lay) {
  const r = cv.getBoundingClientRect();
  return { x: Math.max(0, Math.min(lay.width - 1, Math.floor((e.clientX - r.left) / r.width * lay.width))),
           y: Math.max(0, Math.min(lay.height - 1, Math.floor((e.clientY - r.top) / r.height * lay.height))) };
}

/* ================= 2. คลังภาพ ================= */
const FONT = '"Noto Sans Thai","Sukhumvit Set","Thonburi",sans-serif';
const LIBRARY = [
  { name: 'ธงชาติไทย', make: () => rasterize((g, w, h) => {
      const bands = [['r', 1], ['w', 1], ['n', 2], ['w', 1], ['r', 1]]; let y = 0;
      for (const [c, n] of bands) { g.fillStyle = hx(c); g.fillRect(0, y, w, h * n / 6 + 1); y += h * n / 6; }
    }) },
  { name: 'ชมพู–ฟ้า', make: () => rasterize((g, w, h) => {
      g.fillStyle = hx('p'); g.fillRect(0, 0, w, h);
      g.fillStyle = hx('b'); g.beginPath(); g.moveTo(w * 0.62, 0); g.lineTo(w, 0); g.lineTo(w, h); g.lineTo(w * 0.38, h); g.closePath(); g.fill();
    }) },
  { name: 'หัวใจ', make: () => rasterize((g, w, h) => {
      g.fillStyle = hx('w'); g.fillRect(0, 0, w, h);
      g.fillStyle = hx('p'); const cx = w / 2, s = h * 0.5;
      g.beginPath(); g.moveTo(cx, h * 0.92);
      g.bezierCurveTo(cx - s * 2.1, h * 0.42, cx - s * 0.8, -h * 0.12, cx, h * 0.3);
      g.bezierCurveTo(cx + s * 0.8, -h * 0.12, cx + s * 2.1, h * 0.42, cx, h * 0.92); g.fill();
    }) },
  { name: 'ดาว', make: () => rasterize((g, w, h) => {
      g.fillStyle = hx('n'); g.fillRect(0, 0, w, h);
      g.fillStyle = hx('y'); const cx = w / 2, cy = h * 0.54, R = h * 0.48, r = R * 0.42;
      g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; g.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); } g.closePath(); g.fill();
    }) },
  { name: 'ข้อความ “สู้!”', make: () => textImage('สู้!', 'w', 'b') },
  { name: 'ข้อความ “SK”', make: () => textImage('SK', 'p', 'n') },
  { name: 'แถบสีทุกสี', make: () => rasterize((g, w, h) => { D.palette.forEach((c, i) => { g.fillStyle = c.hex; g.fillRect(w * i / D.palette.length, 0, w / D.palette.length + 1, h); }); }) },
  { name: 'เป้าวงกลม', make: () => rasterize((g, w, h) => {
      g.fillStyle = hx('w'); g.fillRect(0, 0, w, h);
      ['r', 'w', 'r', 'w', 'r'].forEach((c, i) => { g.fillStyle = hx(c); g.beginPath(); g.arc(w / 2, h / 2, h * 0.5 * (1 - i * 0.2), 0, 7); g.fill(); });
    }) }
];
function textImage(text, fg, bg) {
  return rasterize((g, w, h) => {
    g.fillStyle = hx(bg); g.fillRect(0, 0, w, h);
    g.fillStyle = hx(fg); g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = h * 0.62; g.font = `800 ${size}px ${FONT}`;
    const mw = g.measureText(text).width; if (mw > w * 0.92) { size *= w * 0.92 / mw; g.font = `800 ${size}px ${FONT}`; }
    g.fillText(text, w / 2, h * 0.52);
  });
}

function renderLibrary(m) {
  const lib = h('div', { class: 'lib' });
  for (const item of LIBRARY) {
    const grid = item.make();
    lib.append(h('div', { class: 'libItem' }, thumb(grid), h('b', null, item.name),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => { await saveImage(null, item.name, grid, true); toast(`เพิ่ม “${item.name}” เข้าชุดการแสดงแล้ว`); } }, 'เพิ่มเข้าชุด'),
        h('button', { onclick: () => { openEditor({ id: null, name: item.name, grid }); } }, 'แก้ไข'))));
  }
  const mine = h('div', { class: 'lib' });
  if (!D.images.length) mine.append(h('p', { class: 'muted' }, 'ยังไม่มีภาพที่บันทึกไว้'));
  for (const img of D.images) {
    const inShow = D.show.imageIds.filter(id => id === img.id).length;
    mine.append(h('div', { class: 'libItem' }, thumb(imgGrid(img)), h('b', null, img.name),
      h('span', { class: 'muted small' }, inShow ? `อยู่ในชุดการแสดง ${inShow} ครั้ง` : 'ยังไม่ได้อยู่ในชุด'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { D.show.imageIds.push(img.id); await saveShow(); toast('เพิ่มเข้าชุดแล้ว'); render(); } }, 'เพิ่มเข้าชุด'),
        h('button', { onclick: () => openEditor({ id: img.id, name: img.name, grid: imgGrid(img) }) }, 'แก้ไข'),
        h('button', { onclick: async () => { if (!confirm(`ลบ “${img.name}”?`)) return; await api('DELETE', '/api/images/' + img.id); await load(); render(); } }, 'ลบ'))));
  }
  m.append(
    h('div', { class: 'card' }, h('h2', null, 'คลังภาพสำเร็จรูป'), h('p', { class: 'muted small' }, 'ภาพถูกย่อ/ขยายให้พอดีกับผังสแตนด์ปัจจุบันโดยอัตโนมัติ'), lib),
    h('div', { class: 'card' }, h('h2', null, 'ภาพของฉัน'), mine));
}

async function saveImage(id, name, grid, addToShow) {
  const img = await api('POST', '/api/images', { id, name, frames: [{ grid }] });
  const i = D.images.findIndex(x => x.id === img.id);
  if (i >= 0) D.images[i] = img; else D.images.push(img);
  if (addToShow) { D.show.imageIds.push(img.id); await saveShow(); }
  return img;
}
async function saveShow() { D.show = await api('PUT', '/api/show', D.show); }

/* ================= 3. วาดภาพ ================= */
let ed = null;
function openEditor(o) {
  ed = { id: o.id, name: o.name, grid: clone(o.grid), undo: [], redo: [], tool: (ed && ed.tool) || 'pen', color: (ed && ed.color) || (D.palette[2] || D.palette[0]).id };
  tab = 'editor'; localStorage.setItem('cs_dir_tab', tab); render();
}
function renderEditor(m) {
  if (!ed) ed = { id: null, name: 'ภาพใหม่', grid: Stunt.emptyGrid(L.width, L.height, D.palette[0].id), undo: [], redo: [], tool: 'pen', color: (D.palette[2] || D.palette[0]).id };
  ed.grid = Stunt.fitGrid(ed.grid, L.width, L.height);
  const cv = h('canvas', { class: 'grid' });
  const info = h('div', { class: 'muted small' });
  const wrap = h('div', { class: 'scroll' }, cv);
  const tools = [['pen', '✏️ ดินสอ'], ['fill', '🪣 ถังสี'], ['line', '／ เส้น'], ['rect', '▭ สี่เหลี่ยม'], ['rectF', '■ สี่เหลี่ยมทึบ'], ['ellipse', '◯ วงกลม'], ['ellipseF', '● วงกลมทึบ'], ['pick', '💧 ดูดสี']];
  const toolBox = h('div', { class: 'tools' });
  const swBox = h('div', { class: 'tools' });
  function drawTools() {
    toolBox.innerHTML = '';
    for (const [id, label] of tools) toolBox.append(h('button', { class: ed.tool === id ? 'on' : '', onclick: () => { ed.tool = id; drawTools(); } }, label));
    swBox.innerHTML = '';
    for (const c of D.palette) swBox.append(h('span', { class: 'sw' + (ed.color === c.id ? ' on' : ''), onclick: () => { ed.color = c.id; drawTools(); } }, h('i', { style: `background:${c.hex}` }), `${c.name} · ${c.cardFace}`));
  }
  function redraw() {
    drawGrid(cv, ed.grid, { maxW: m.clientWidth - 40, maxH: Math.max(300, innerHeight - 330) });
    const cnt = Stunt.colorCounts(L, ed.grid);
    info.textContent = 'จำนวนแผ่นที่ต้องใช้: ' + D.palette.filter(c => cnt[c.id]).map(c => `${c.name} ${fmt(cnt[c.id])}`).join(' · ');
  }
  const pushUndo = () => { ed.undo.push(clone(ed.grid)); if (ed.undo.length > 100) ed.undo.shift(); ed.redo = []; };
  const set = (x, y) => { if (y >= 0 && y < L.height && x >= 0 && x < L.width) ed.grid[y][x] = ed.color; };
  const line = (a, b, f) => { let x0 = a.x, y0 = a.y; const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0), sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1; let err = dx + dy;
    for (;;) { f(x0, y0); if (x0 === b.x && y0 === b.y) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } } };
  function shape(a, b, kind) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (kind === 'line') return line(a, b, set);
    if (kind.startsWith('rect')) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (kind === 'rectF' || y === y0 || y === y1 || x === x0 || x === x1) set(x, y); return; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2 + 0.5, ry = (y1 - y0) / 2 + 0.5;
    const inE = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!inE(x, y)) continue;
      if (kind === 'ellipseF' || !inE(x - 1, y) || !inE(x + 1, y) || !inE(x, y - 1) || !inE(x, y + 1)) set(x, y);
    }
  }
  function flood(x, y) {
    const from = ed.grid[y][x]; if (from === ed.color) return;
    const st = [[x, y]];
    while (st.length) { const [a, b] = st.pop(); if (a < 0 || b < 0 || a >= L.width || b >= L.height || ed.grid[b][a] !== from) continue; ed.grid[b][a] = ed.color; st.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]); }
  }
  let drag = null;
  cv.onpointerdown = e => {
    cv.setPointerCapture(e.pointerId);
    const c = cellFromEvent(cv, e);
    if (ed.tool === 'pick') { ed.color = ed.grid[c.y][c.x] || ed.color; ed.tool = 'pen'; drawTools(); return; }
    pushUndo();
    if (ed.tool === 'fill') { flood(c.x, c.y); redraw(); return; }
    drag = { start: c, last: c, base: clone(ed.grid) };
    if (ed.tool === 'pen') set(c.x, c.y); else shape(c, c, ed.tool);
    redraw();
  };
  cv.onpointermove = e => {
    if (!drag) return;
    const c = cellFromEvent(cv, e);
    if (ed.tool === 'pen') { line(drag.last, c, set); drag.last = c; }
    else { ed.grid = clone(drag.base); shape(drag.start, c, ed.tool); }
    redraw();
  };
  cv.onpointerup = cv.onpointercancel = () => { drag = null; };

  const txt = h('input', { placeholder: 'พิมพ์ข้อความ เช่น สวนกุหลาบ', style: 'width:220px' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml', style: 'display:none', onchange: () => {
    const f = file.files[0]; if (!f) return;
    const im = new Image();
    im.onload = () => { pushUndo(); const g2 = rasterize((g, w, hh) => { const s = Math.max(w / im.width, hh / im.height); g.drawImage(im, (w - im.width * s) / 2, (hh - im.height * s) / 2, im.width * s, im.height * s); }, ed.color); ed.grid = g2.map(r => r.map(v => v || ed.color)); redraw(); URL.revokeObjectURL(im.src); file.value = ''; };
    im.src = URL.createObjectURL(f);
  } });
  const nameIn = h('input', { value: ed.name, oninput: e => { ed.name = e.target.value; }, style: 'width:220px' });

  m.append(h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'วาดภาพ'), nameIn, h('span', { class: 'muted small' }, ed.id ? 'แก้ไขภาพที่บันทึกไว้' : 'ภาพใหม่ (ยังไม่บันทึก)')),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { const img = await saveImage(ed.id, ed.name, ed.grid, false); ed.id = img.id; toast('บันทึกแล้ว'); render(); } }, 'บันทึก'),
        h('button', { class: 'primary', onclick: async () => { const img = await saveImage(ed.id, ed.name, ed.grid, !D.show.imageIds.includes(ed.id)); ed.id = img.id; toast('บันทึกและอยู่ในชุดการแสดงแล้ว'); render(); } }, 'บันทึกและเพิ่มเข้าชุด'),
        h('button', { onclick: () => { ed = null; render(); } }, 'ภาพใหม่'))),
    h('div', { style: 'margin:10px 0;display:flex;flex-direction:column;gap:8px' },
      toolBox,
      h('div', { class: 'tools' },
        h('button', { onclick: () => { if (ed.undo.length) { ed.redo.push(clone(ed.grid)); ed.grid = ed.undo.pop(); redraw(); } } }, '↶ ย้อน'),
        h('button', { onclick: () => { if (ed.redo.length) { ed.undo.push(clone(ed.grid)); ed.grid = ed.redo.pop(); redraw(); } } }, '↷ ทำซ้ำ'),
        h('button', { onclick: () => { pushUndo(); ed.grid = ed.grid.map(r => r.slice().reverse()); redraw(); } }, '⇋ กลับซ้ายขวา'),
        h('button', { onclick: () => { pushUndo(); ed.grid = Stunt.emptyGrid(L.width, L.height, ed.color); redraw(); } }, 'เทสีทั้งภาพ'),
        txt,
        h('button', { onclick: () => { if (!txt.value.trim()) return; pushUndo(); const t = rasterize((g, w, hh) => { g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle'; let s = hh * 0.62; g.font = `800 ${s}px ${FONT}`; const mw = g.measureText(txt.value).width; if (mw > w * 0.94) { s *= w * 0.94 / mw; g.font = `800 ${s}px ${FONT}`; } g.fillText(txt.value, w / 2, hh * 0.52); }); t.forEach((r, y) => r.forEach((v, x) => { if (v) ed.grid[y][x] = ed.color; })); redraw(); } }, 'วางข้อความ'),
        h('button', { onclick: () => file.click() }, 'นำเข้ารูป…'), file),
      swBox),
    wrap, info));
  drawTools(); redraw();
}

/* ================= 4. ชุดการแสดง ================= */
function renderShow(m) {
  const list = h('div');
  const imgs = () => D.show.imageIds.map(id => D.images.find(x => x.id === id)).filter(Boolean);
  let dragFrom = null;
  function drawList() {
    list.innerHTML = '';
    const arr = imgs(); let prevGrid = null;
    if (!arr.length) list.append(h('p', { class: 'muted' }, 'ยังไม่มีภาพ เพิ่มจากคลังภาพหรือตัววาด'));
    arr.forEach((img, i) => {
      const g = imgGrid(img), ch = Stunt.changedSeats(L, prevGrid, g); prevGrid = g;
      const row = h('div', { class: 'showItem', draggable: true },
        h('span', { class: 'handle', title: 'ลากเพื่อสลับลำดับ' }, '⋮⋮'),
        h('span', { class: 'idx' }, i + 1), thumb(g, 200, 70),
        h('div', { class: 'grow' }, h('b', null, img.name), h('div', { class: 'muted small' }, ch == null ? 'ภาพแรก' : `ต้องเปลี่ยนสี ${fmt(ch)} ที่นั่งจากภาพก่อนหน้า`)),
        h('button', { disabled: i === 0, onclick: () => move(i, i - 1) }, '↑'),
        h('button', { disabled: i === arr.length - 1, onclick: () => move(i, i + 1) }, '↓'),
        h('button', { onclick: () => openEditor({ id: img.id, name: img.name, grid: g }) }, 'แก้ไข'),
        h('button', { onclick: async () => { D.show.imageIds.splice(i, 1); await saveShow(); drawList(); } }, 'เอาออก'));
      row.ondragstart = () => { dragFrom = i; row.classList.add('drag'); };
      row.ondragend = () => row.classList.remove('drag');
      row.ondragover = e => { e.preventDefault(); row.classList.add('over'); };
      row.ondragleave = () => row.classList.remove('over');
      row.ondrop = e => { e.preventDefault(); row.classList.remove('over'); if (dragFrom != null && dragFrom !== i) move(dragFrom, i); dragFrom = null; };
      list.append(row);
    });
    pubState();
  }
  async function move(a, b) { const ids = D.show.imageIds; const [x] = ids.splice(a, 1); ids.splice(b, 0, x); await saveShow(); drawList(); }
  const addSel = h('select', null, D.images.map(im => h('option', { value: im.id }, im.name)));
  const pubInfo = h('div', { class: 'muted' });
  function pubState() {
    const P = D.published;
    pubInfo.textContent = P ? `เผยแพร่แล้ว เวอร์ชัน ${P.version} · ${new Date(P.publishedAt).toLocaleString('th-TH')} · ${P.names.length} ภาพ` : 'ยังไม่เคยเผยแพร่';
  }

  // ลิงก์เข้างาน + QR
  const bases = [...new Set([...(D.lanUrls || []), location.origin])];
  const baseSel = h('select', null, bases.map(b => h('option', { value: b }, b)));
  const urlBox = h('code', { class: 'url' }), qrBox = h('div', { class: 'qr' }), expBox = h('div', { class: 'muted small' });
  async function drawLink() {
    const u = `${baseSel.value}/s?t=${D.event.token}`;
    urlBox.textContent = u;
    expBox.textContent = 'หมดอายุ ' + new Date(D.event.expires).toLocaleString('th-TH');
    const r = await fetch('/api/qr?text=' + encodeURIComponent(u)); qrBox.innerHTML = await r.text();
  }
  baseSel.onchange = drawLink;
  const hoursIn = h('input', { type: 'number', value: 24, min: 1 });

  m.append(h('div', { class: 'grid2' },
    h('div', { class: 'card' },
      h('h2', null, 'ลำดับภาพ'),
      h('div', { class: 'row', style: 'margin-bottom:10px' }, addSel,
        h('button', { onclick: async () => { if (!addSel.value) return; D.show.imageIds.push(addSel.value); await saveShow(); drawList(); } }, '+ เพิ่มภาพ')),
      list),
    h('div', null,
      h('div', { class: 'card' },
        h('h2', null, 'จังหวะและการเผยแพร่'),
        h('div', { class: 'row' },
          h('label', null, 'จังหวะนับ ', h('input', { type: 'number', value: D.show.beatMs, step: 50, onchange: async e => { D.show.beatMs = +e.target.value; await saveShow(); } }), ' ms'),
          h('label', null, 'ส่งล่วงหน้า ', h('input', { type: 'number', value: D.show.leadMs, step: 100, onchange: async e => { D.show.leadMs = +e.target.value; await saveShow(); } }), ' ms')),
        h('p', { class: 'muted small' }, 'กด “เผยแพร่” แล้วระบบคำนวณบทรายที่นั่งและส่งให้ทุกเครื่องเก็บไว้ล่วงหน้า แก้ภาพแล้วเผยแพร่ซ้ำได้ ระบบส่งเฉพาะที่นั่งที่บทเปลี่ยน'),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: async () => {
            try { const r = await api('POST', '/api/publish'); await load(); pubState(); toast(`เผยแพร่เวอร์ชัน ${r.version} แล้ว · ${fmt(r.seats)} ที่นั่ง · ส่งบทใหม่ ${fmt(r.resent)} เครื่อง`); } catch (e) { toast(e.message); }
          } }, 'เผยแพร่'), pubInfo)),
      h('div', { class: 'card' },
        h('h2', null, 'ลิงก์เข้างานสำหรับนักเรียน'),
        h('div', { class: 'row', style: 'align-items:flex-start' }, qrBox,
          h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:8px;min-width:200px' },
            h('label', null, 'ที่อยู่เซิร์ฟเวอร์ ', baseSel), urlBox, expBox,
            h('p', { class: 'muted small' }, 'มือถือต้องอยู่ใน Wi-Fi เดียวกับเครื่องนี้ (หรือใช้ที่อยู่สาธารณะ) · เพิ่ม &seat=B-12-07 ต่อท้ายลิงก์เพื่อทำ QR ติดเก้าอี้'),
            h('div', { class: 'row' }, 'อายุ', hoursIn, 'ชม.',
              h('button', { onclick: async () => { if (!confirm('ลิงก์เดิมจะใช้ไม่ได้ทันที นักเรียนต้องสแกนใหม่ ทำต่อไหม?')) return; D.event = await api('POST', '/api/event', { hours: +hoursIn.value }); drawLink(); } }, 'สร้างลิงก์ใหม่'))))))));
  drawList(); drawLink();
}

/* ================= 5. ควบคุมสด ================= */
let liveEls = null;
function holdButton(label, cls, fn) {
  const b = h('button', { class: 'hold ' + cls }, label, h('span', { class: 'fillbar' }));
  let t = null;
  const cancel = () => { clearTimeout(t); b.classList.remove('holding'); };
  b.onpointerdown = () => { b.classList.add('holding'); t = setTimeout(() => { cancel(); fn(); }, 800); };
  b.onpointerup = b.onpointerleave = b.onpointercancel = cancel;
  b.title = 'กดค้างไว้เพื่อยืนยัน';
  return b;
}
function cmd(action, extra = {}) {
  wsSend(Object.assign({ t: 'cmd', action, beatMs: +liveEls.beat.value, leadMs: +liveEls.lead.value }, extra));
}
function renderLive(m) {
  const P = D.published;
  if (!P) { m.append(h('div', { class: 'card' }, h('h2', null, 'ยังไม่ได้เผยแพร่ชุดการแสดง'), h('p', { class: 'muted' }, 'ไปที่แท็บ “ชุดการแสดง” แล้วกดเผยแพร่ก่อน'))); liveEls = null; return; }
  const n = P.names.length;
  const E = liveEls = {
    status: h('div', { class: 'status' }), beatNow: h('div', { class: 'beatNow' }),
    cur: h('canvas', { class: 'grid' }), next: h('canvas', { class: 'grid' }),
    curName: h('b'), nextName: h('b'), heat: h('canvas', { class: 'grid' }), stats: h('div', { class: 'stats' }),
    beat: h('input', { type: 'number', value: live.beatMs || P.beatMs, step: 50 }),
    lead: h('input', { type: 'number', value: P.leadMs, step: 100 }),
    jump: h('select', null, P.names.map((nm, i) => h('option', { value: i }, `${i + 1}. ${nm}`)))
  };
  const idx = () => live.imageIndex || 0;
  m.append(h('div', { class: 'liveWrap' },
    h('div', null,
      h('div', { class: 'card' }, E.status, E.beatNow,
        h('div', { class: 'bigBtns' },
          h('button', { class: 'prep wide', onclick: () => cmd('prepare', { imageIndex: Math.min(n - 1, live.status === 'idle' || live.status === 'stopped' ? idx() : idx() + 1) }) }, 'เตรียมภาพถัดไป'),
          h('button', { class: 'go wide', onclick: () => cmd('countdown', { imageIndex: idx() }) }, 'เริ่มนับ 1 2 3'),
          h('button', { onclick: () => cmd('down') }, 'ลดแผ่น'),
          h('button', { onclick: () => cmd('prepare', { imageIndex: Math.min(n - 1, idx() + 2) }) }, 'ข้ามภาพ ⏭'),
          holdButton('⏮ ย้อนภาพ', '', () => cmd('prepare', { imageIndex: Math.max(0, idx() - 1) })),
          h('button', { onclick: () => cmd('idle') }, 'พัก (จอรอคำสั่ง)'),
          holdButton('หยุดฉุกเฉิน', 'stop wide', () => cmd('stop')))),
      h('div', { class: 'card' },
        h('h3', null, 'ไปยังภาพ'), h('div', { class: 'row' }, E.jump, h('button', { onclick: () => cmd('prepare', { imageIndex: +E.jump.value }) }, 'เตรียมภาพนี้')),
        h('h3', { style: 'margin-top:12px' }, 'จังหวะ'),
        h('div', { class: 'row' }, h('label', null, 'จังหวะ ', E.beat, ' ms'), h('label', null, 'ล่วงหน้า ', E.lead, ' ms')),
        h('p', { class: 'muted small' }, 'ปุ่มย้อนภาพและหยุดฉุกเฉินต้องกดค้าง 0.8 วินาที · เปิดหน้านี้ได้หลายเครื่องเป็นผู้ควบคุมสำรอง'))),
    h('div', null,
      h('div', { class: 'card grid2' },
        h('div', null, h('div', { class: 'muted small' }, 'ภาพปัจจุบัน'), E.curName, E.cur),
        h('div', null, h('div', { class: 'muted small' }, 'ภาพถัดไป'), E.nextName, E.next)),
      h('div', { class: 'card' }, h('h3', null, 'สถานะเครื่อง'), E.stats),
      h('div', { class: 'card' }, h('h3', null, 'แผนที่ที่นั่งออนไลน์'),
        h('div', { class: 'legend' }, h('span', null, h('i', { style: 'background:#22c55e' }), 'ออนไลน์'), h('span', null, h('i', { style: 'background:#d6dbe3' }), 'ยังไม่มีเครื่อง'), h('span', null, h('i', { style: 'background:#3d4250' }), 'ไม่ใช้')),
        h('div', { class: 'scroll', style: 'margin-top:8px' }, E.heat)))));
  updateLive(true);
}
let lastLiveKey = '';
function updateLive(force) {
  const E = liveEls; if (!E || !D.published) return;
  const P = D.published, n = P.names.length, i = Math.min(live.imageIndex || 0, n - 1);
  const label = { idle: 'พัก · จอรอคำสั่ง', prepared: 'เตรียมภาพ', counting: 'กำลังนับ', down: 'ลดแผ่น', stopped: 'หยุดฉุกเฉิน' }[live.status] || live.status;
  E.status.textContent = `ภาพที่ ${i + 1} / ${n} · ${label}`;
  E.status.style.color = live.status === 'stopped' ? 'var(--bad)' : '';
  const key = i + ':' + n;
  if (force || key !== lastLiveKey) {
    lastLiveKey = key;
    const w = E.cur.parentElement.clientWidth || 300;
    drawGrid(E.cur, P.grids[i], { maxW: w, maxH: 200, fluid: true }); E.curName.textContent = ` ${i + 1}. ${P.names[i]}`;
    if (i + 1 < n) { drawGrid(E.next, P.grids[i + 1], { maxW: w, maxH: 200, fluid: true }); E.nextName.textContent = ` ${i + 2}. ${P.names[i + 1]}`; }
    else { const g2 = E.next.getContext('2d'); g2.setTransform(1, 0, 0, 1, 0, 0); g2.clearRect(0, 0, E.next.width, E.next.height); E.nextName.textContent = ' (ภาพสุดท้าย)'; }
    E.jump.value = i;
  }
  if (stats) {
    const on = new Set(stats.onlineSeats);
    drawGrid(E.heat, null, { maxW: E.heat.parentElement.clientWidth || 600, maxH: 260, colorFn: s => (on.has(s.id) ? '#22c55e' : '#d6dbe3') });
    const b = stats.beat || {};
    const ok = b.errP95 != null && b.errP95 <= 50;
    E.stats.innerHTML = '';
    E.stats.append(
      stat('ออนไลน์', `${fmt(stats.online)} / ${fmt(stats.total)}`),
      stat('RTT p50 / p95', stats.rttP50 != null ? `${stats.rttP50} / ${stats.rttP95} ms` : '-'),
      stat('รายงานการนับล่าสุด', b.reports ? fmt(b.reports) + ' เครื่อง' : '-'),
      stat('คลาดโดยประมาณ p95', b.errP95 != null ? `${Math.round(b.errP95)} ms` : '-', b.errP95 == null ? '' : ok ? 'good' : 'bad'),
      stat('ได้รับคำสั่งช้ากว่าเวลาเริ่ม', b.reports ? fmt(b.arrivedLate) + ' เครื่อง' : '-', b.arrivedLate ? 'bad' : ''));
  }
}
function stat(label, val, cls = '') { return h('div', { class: 'stat ' + cls }, h('span', { class: 'muted small' }, label), h('b', null, val)); }

/* ตัวเลขนับบนหน้าผู้ควบคุม ตามนาฬิกาเซิร์ฟเวอร์ */
(function tick() {
  if (liveEls && tab === 'live') {
    let txt = '';
    if (live.status === 'counting') {
      const ph = Math.floor((serverNow() - live.startAt) / (live.beatMs || 800));
      txt = ph < 0 ? '…' : ph < 3 ? String(ph + 1) : 'ชู!';
    } else if (live.status === 'down') txt = serverNow() < live.startAt ? '…' : 'ลด';
    if (liveEls.beatNow.textContent !== txt) liveEls.beatNow.textContent = txt;
  }
  requestAnimationFrame(tick);
})();

/* ================= ตรวจภาพ (Spotter) ================= */
let spot = { follow: true, imageIndex: 0, sel: new Set(), cs: 0 };
let spotEls = null;
const MARK_STYLE = {
  sent: { stroke: '#dc2626' }, seen: { fill: '#dc2626' }, fixed: { fill: '#facc15' }, ok: { fill: '#16a34a' }, nodevice: { fill: '#6b7280', stroke: '#dc2626' }
};
function renderSpot(m) {
  const P = D.published;
  if (!P) { m.append(h('div', { class: 'card' }, h('h2', null, 'ยังไม่ได้เผยแพร่ชุดการแสดง'))); spotEls = null; return; }
  const E = spotEls = {
    cv: h('canvas', { class: 'grid' }), info: h('span', { class: 'muted' }), counts: h('div', { class: 'legend' }),
    sel: h('select', null, P.names.map((nm, i) => h('option', { value: i }, `${i + 1}. ${nm}`))),
    follow: h('input', { type: 'checkbox', checked: spot.follow }),
    sendBtn: h('button', { class: 'danger' }), okBtn: h('button'), resendBtn: h('button')
  };
  E.follow.onchange = () => { spot.follow = E.follow.checked; renderSpotCanvas(true); };
  E.sel.onchange = () => { spot.follow = false; E.follow.checked = false; spot.imageIndex = +E.sel.value; spot.sel.clear(); renderSpotCanvas(true); };
  const selectedMarks = st => marks.filter(mk => mk.imageIndex === curSpotIdx() && spot.sel.has(mk.seatId) && (!st || st.includes(mk.status)));
  E.sendBtn.onclick = () => {
    const seats = [...spot.sel].filter(id => { const s = L.byId.get(id); return s && s.active; });
    if (!seats.length) return toast('เลือกช่องที่ผิดก่อน');
    wsSend({ t: 'mark', imageIndex: curSpotIdx(), seatIds: seats }); spot.sel.clear(); renderSpotCanvas();
    toast(`ส่งแจ้งเตือน ${seats.length} ที่นั่ง`);
  };
  E.okBtn.onclick = () => { const ids = selectedMarks().map(x => x.id); if (!ids.length) return toast('เลือกช่องที่แจ้งไว้ก่อน'); wsSend({ t: 'markConfirm', markIds: ids }); spot.sel.clear(); };
  E.resendBtn.onclick = () => { const ids = selectedMarks().map(x => x.id); if (!ids.length) return toast('เลือกช่องที่แจ้งไว้ก่อน'); wsSend({ t: 'markResend', markIds: ids }); spot.sel.clear(); };

  let down = null;
  E.cv.onpointerdown = e => { E.cv.setPointerCapture(e.pointerId); down = cellFromEvent(E.cv, e); renderSpotCanvas(false, { a: down, b: down }); };
  E.cv.onpointermove = e => {
    const c = cellFromEvent(E.cv, e); const s = L.cellAt[c.y][c.x];
    const mk = s && marks.find(x => x.seatId === s.id && x.imageIndex === curSpotIdx());
    E.info.textContent = s ? `${s.id} · ควรเป็น ${(pal[curGrid()[c.y][c.x]] || {}).name || '-'}${mk ? ' · ' + statusTh(mk.status) : ''}` : '';
    if (down) renderSpotCanvas(false, { a: down, b: c });
  };
  E.cv.onpointerup = e => {
    if (!down) return;
    const c = cellFromEvent(E.cv, e);
    const x0 = Math.min(down.x, c.x), x1 = Math.max(down.x, c.x), y0 = Math.min(down.y, c.y), y1 = Math.max(down.y, c.y);
    if (x0 === x1 && y0 === y1) { const s = L.cellAt[y0][x0]; if (s) spot.sel.has(s.id) ? spot.sel.delete(s.id) : spot.sel.add(s.id); }
    else for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const s = L.cellAt[y][x]; if (s && s.active) spot.sel.add(s.id); }
    down = null; renderSpotCanvas();
  };
  const zoom = d => { spot.cs = Math.max(4, Math.min(40, (spot.cs || E.cv._cs || 10) + d)); renderSpotCanvas(true); };

  m.append(h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, 'ตรวจภาพ'), E.sel, h('label', null, E.follow, ' ตามภาพปัจจุบัน')),
      h('div', { class: 'row' }, h('button', { onclick: () => zoom(-3) }, '−'), h('button', { onclick: () => zoom(3) }, '+ ซูม'))),
    h('p', { class: 'muted small' }, 'แตะช่องที่ผิด หรือลากเพื่อเลือกเป็นพื้นที่ แล้วกด “ส่งแจ้งเตือน” · ภาพนี้คือมุมที่เห็นจากฝั่งตรงข้าม'),
    h('div', { class: 'scroll' }, E.cv), E.info,
    h('div', { class: 'row', style: 'margin-top:10px' }, E.sendBtn, E.okBtn, E.resendBtn, h('button', { onclick: () => { spot.sel.clear(); renderSpotCanvas(); } }, 'ล้างที่เลือก')),
    h('div', { style: 'margin-top:10px' }, E.counts)));
  renderSpotCanvas(true);
}
const statusTh = s => ({ sent: 'แจ้งแล้ว รอเครื่องรับ', seen: 'รับทราบ', fixed: 'แก้แล้ว รอยืนยัน', ok: 'ยืนยันถูก', nodevice: 'ไม่มีเครื่อง' })[s] || s;
function curSpotIdx() { const n = D.published ? D.published.names.length : 1; return Math.min(n - 1, spot.follow ? (live.imageIndex || 0) : spot.imageIndex); }
function curGrid() { return D.published.grids[curSpotIdx()]; }
function renderSpotCanvas(reset, rect) {
  const E = spotEls; if (!E || !D.published) return;
  const idx = curSpotIdx();
  if (reset && spot.follow) { spot.sel.clear(); E.sel.value = idx; }
  const my = marks.filter(mk => mk.imageIndex === idx);
  const opts = {
    maxW: Math.max(300, E.cv.parentElement.clientWidth), maxH: innerHeight - 300, cs: spot.cs || undefined,
    overlay: (g, cs) => {
      for (const mk of my) {
        const s = L.byId.get(mk.seatId); if (!s) continue; const st = MARK_STYLE[mk.status] || {};
        if (st.fill) { g.fillStyle = st.fill; g.fillRect(s.x * cs, s.y * cs, cs - 1, cs - 1); }
        if (st.stroke) { g.strokeStyle = st.stroke; g.lineWidth = Math.max(2, cs / 5); g.strokeRect(s.x * cs + 1, s.y * cs + 1, cs - 3, cs - 3); }
      }
      g.strokeStyle = '#06b6d4'; g.lineWidth = Math.max(2, cs / 6);
      for (const id of spot.sel) { const s = L.byId.get(id); if (s) g.strokeRect(s.x * cs + 1, s.y * cs + 1, cs - 3, cs - 3); }
      if (rect) {
        const x0 = Math.min(rect.a.x, rect.b.x), y0 = Math.min(rect.a.y, rect.b.y);
        g.setLineDash([4, 3]); g.strokeRect(x0 * cs, y0 * cs, (Math.abs(rect.a.x - rect.b.x) + 1) * cs, (Math.abs(rect.a.y - rect.b.y) + 1) * cs); g.setLineDash([]);
      }
    }
  };
  drawGrid(E.cv, D.published.grids[idx], opts);
  const n = spot.sel.size, selMarks = my.filter(mk => spot.sel.has(mk.seatId));
  E.sendBtn.textContent = `ส่งแจ้งเตือน${n ? ` (${n})` : ''}`;
  E.okBtn.textContent = `ยืนยันถูก${selMarks.length ? ` (${selMarks.length})` : ''}`;
  E.resendBtn.textContent = 'แจ้งซ้ำ';
  const c = {}; my.forEach(mk => { c[mk.status] = (c[mk.status] || 0) + 1; });
  E.counts.innerHTML = '';
  for (const [k, st] of Object.entries(MARK_STYLE)) {
    E.counts.append(h('span', null, h('i', { style: `background:${st.fill || '#fff'};${st.stroke ? `box-shadow:0 0 0 2px ${st.stroke} inset` : ''}` }), `${statusTh(k)} ${c[k] || 0}`));
  }
  E.counts.append(h('span', null, h('i', { style: 'background:#fff;box-shadow:0 0 0 2px #06b6d4 inset' }), `เลือกอยู่ ${n}`));
}

addEventListener('resize', () => { if (tab === 'live' || tab === 'spot') render(); });

if (token) start(); else logout();
