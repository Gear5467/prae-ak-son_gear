/* Card Stunt Controller — MVP server
 * HTTP (หน้าเว็บ + REST สำหรับ Director) และ WebSocket (คำสั่งสด, ซิงค์นาฬิกา, แจ้งจุดผิด)
 * เก็บข้อมูลไว้ใน data/db.json และสถานะสดไว้ในหน่วยความจำ (MVP แทน PostgreSQL/Redis)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const S = require('./public/shared.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');

const now = () => Date.now();
const rid = (n = 8) => crypto.randomBytes(n).toString('base64url');

/* ---------- ข้อมูลถาวร ---------- */
function defaultDb() {
  return {
    password: process.env.DIRECTOR_PASSWORD || rid(6),
    stand: S.defaultStand(),
    palette: S.defaultPalette(),
    images: [],
    show: { imageIds: [], beatMs: 800, leadMs: 1500 },
    published: null,
    event: { token: rid(9), expires: now() + 24 * 3600e3 }
  };
}
let db;
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
catch { db = defaultDb(); }
if (process.env.DIRECTOR_PASSWORD) db.password = process.env.DIRECTOR_PASSWORD;
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  }, 200);
}
save();

let L = S.layout(db.stand);

/* ---------- สถานะสด (ในหน่วยความจำ) ---------- */
let live = { status: 'idle', imageIndex: 0, startAt: 0, beatMs: db.show.beatMs, seq: 0 };
const directorTokens = new Set();
const seatSockets = new Map();   // seatId -> ws
const directorSockets = new Set();
const deviceInfo = new Map();    // deviceId -> { seatId, rtt, offset, lastSeen }
const marks = new Map();         // markId -> mark
let beatReports = new Map();     // deviceId -> { lateMs, rtt } สำหรับการนับครั้งล่าสุด

/* ---------- HTTP ---------- */
const STATIC = {
  '/director': ['director.html', 'text/html; charset=utf-8'],
  '/s': ['seat.html', 'text/html; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
  '/director.js': ['director.js', 'text/javascript; charset=utf-8'],
  '/director.css': ['director.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8']
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 5e6) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authed(req) {
  const h = req.headers.authorization || '';
  return directorTokens.has(h.replace(/^Bearer /, ''));
}

function eventValid(token) {
  return db.event && token && token === db.event.token && now() < db.event.expires;
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

function publicData() {
  return {
    stand: db.stand, palette: db.palette, images: db.images, show: db.show,
    published: db.published && {
      version: db.published.version, publishedAt: db.published.publishedAt,
      names: db.published.names, grids: db.published.grids
    },
    event: db.event, live, lanUrls: lanUrls()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/') { res.writeHead(302, { Location: '/director' }); return res.end(); }
    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUB, file)), type);
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.password !== 'string' || b.password !== db.password) return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
      const t = rid(18); directorTokens.add(t);
      return send(res, 200, { token: t });
    }

    // ผังสำหรับหน้า Seat (ต้องมี token ของงาน)
    if (p === '/api/seatmap' && req.method === 'GET') {
      if (!eventValid(url.searchParams.get('t'))) return send(res, 403, { error: 'ลิงก์หมดอายุหรือไม่ถูกต้อง' });
      return send(res, 200, { stand: db.stand });
    }

    // QR แค่เข้ารหัสข้อความ ไม่ต้องล็อกอิน (จำกัดความยาว)
    if (p === '/api/qr' && req.method === 'GET') {
      const svg = await QRCode.toString((url.searchParams.get('text') || '').slice(0, 500), { type: 'svg', margin: 1 });
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (!authed(req)) return send(res, 401, { error: 'ต้องล็อกอิน' });

    if (p === '/api/data' && req.method === 'GET') return send(res, 200, publicData());

    if (p === '/api/stand' && req.method === 'PUT') {
      const b = await readBody(req);
      const st = validateStand(b);
      if (!st) return send(res, 400, { error: 'ผังสแตนด์ไม่ถูกต้อง' });
      db.stand = st; L = S.layout(db.stand); save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/palette' && req.method === 'PUT') {
      const b = await readBody(req);
      if (!Array.isArray(b) || !b.length || b.some(c => !c.id || !/^#[0-9a-f]{6}$/i.test(c.hex))) return send(res, 400, { error: 'ชุดสีไม่ถูกต้อง' });
      db.palette = b.map(c => ({ id: String(c.id).slice(0, 8), name: String(c.name || c.id).slice(0, 30), hex: c.hex, cardFace: Number(c.cardFace) || 0 }));
      save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/images' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.frames || !Array.isArray(b.frames) || !b.frames.length) return send(res, 400, { error: 'ภาพไม่ถูกต้อง' });
      const img = { id: b.id || rid(6), name: String(b.name || 'ไม่มีชื่อ').slice(0, 60), type: 'static', frames: b.frames.slice(0, 1).map(f => ({ grid: f.grid, beats: 1 })) };
      const i = db.images.findIndex(x => x.id === img.id);
      if (i >= 0) db.images[i] = img; else db.images.push(img);
      save(); return send(res, 200, img);
    }
    const m = p.match(/^\/api\/images\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      db.images = db.images.filter(x => x.id !== m[1]);
      db.show.imageIds = db.show.imageIds.filter(id => id !== m[1]);
      save(); return send(res, 200, { ok: true });
    }
    if (p === '/api/show' && req.method === 'PUT') {
      const b = await readBody(req);
      db.show = {
        imageIds: (b.imageIds || []).filter(id => db.images.some(x => x.id === id)),
        beatMs: clamp(Number(b.beatMs) || 800, 300, 3000),
        leadMs: clamp(Number(b.leadMs) || 1500, 500, 10000)
      };
      save(); return send(res, 200, db.show);
    }
    if (p === '/api/publish' && req.method === 'POST') {
      const r = publish();
      if (r.error) return send(res, 400, r);
      return send(res, 200, r);
    }
    if (p === '/api/event' && req.method === 'POST') {
      const b = await readBody(req);
      const hours = clamp(Number(b.hours) || 24, 1, 24 * 14);
      db.event = { token: rid(9), expires: now() + hours * 3600e3 };
      save(); return send(res, 200, db.event);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'server error' });
  }
});

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function validateStand(b) {
  if (!b || !Array.isArray(b.zones) || !b.zones.length || b.zones.length > 26) return null;
  const zones = [];
  const ids = new Set();
  let total = 0;
  for (const z of b.zones) {
    const id = String(z.id || '').trim().slice(0, 3).toUpperCase();
    if (!id || ids.has(id) || !Array.isArray(z.rows) || !z.rows.length || z.rows.length > 99) return null;
    const rows = z.rows.map(n => Math.floor(Number(n)));
    if (rows.some(n => !(n >= 1 && n <= 99))) return null;
    ids.add(id); total += rows.reduce((a, c) => a + c, 0);
    zones.push({ id, rows });
  }
  if (total > 20000) return null;
  return {
    name: String(b.name || 'สแตนด์').slice(0, 60),
    numbering: b.numbering === 'audienceRight' ? 'audienceRight' : 'audienceLeft',
    gap: clamp(Math.floor(Number(b.gap) || 0), 0, 5),
    zones,
    blocked: Array.isArray(b.blocked) ? b.blocked.filter(x => typeof x === 'string').slice(0, 20000) : []
  };
}

/* ---------- เผยแพร่: คำนวณบทรายที่นั่ง ---------- */
function publish() {
  const imgs = db.show.imageIds.map(id => db.images.find(x => x.id === id)).filter(Boolean);
  if (!imgs.length) return { error: 'ยังไม่มีภาพในชุดการแสดง' };
  const grids = imgs.map(im => S.fitGrid(im.frames[0].grid, L.width, L.height));
  const scripts = S.buildScripts(L, grids);
  const old = db.published;
  const version = (old ? old.version : 0) + 1;
  db.published = {
    version, publishedAt: now(), names: imgs.map(i => i.name), grids, scripts,
    beatMs: db.show.beatMs, leadMs: db.show.leadMs, palette: db.palette, stand: db.stand
  };
  // ปิดจุดผิดของเวอร์ชันเก่า
  marks.clear(); broadcastMarks();
  live.beatMs = db.show.beatMs;
  if (live.imageIndex >= grids.length) live.imageIndex = 0;
  save();
  // ส่งบทใหม่เฉพาะที่นั่งที่บทเปลี่ยน ที่เหลือส่งแค่เลขเวอร์ชัน
  let changed = 0;
  for (const [seatId, ws] of seatSockets) {
    const before = old && old.scripts[seatId];
    const after = scripts[seatId];
    if (JSON.stringify(before) !== JSON.stringify(after) || !old || JSON.stringify(old.palette) !== JSON.stringify(db.palette)) {
      sendJson(ws, scriptMsg(seatId)); changed++;
    } else {
      sendJson(ws, { t: 'version', version, names: db.published.names, beatMs: db.published.beatMs });
    }
  }
  broadcastDirectors({ t: 'published', published: publicData().published });
  return { version, images: grids.length, seats: Object.keys(scripts).length, resent: changed };
}

function scriptMsg(seatId) {
  const P = db.published;
  if (!P || !P.scripts[seatId]) return { t: 'script', version: 0, steps: [] };
  return {
    t: 'script', version: P.version, names: P.names, beatMs: P.beatMs,
    palette: P.palette.map(({ id, name, hex, cardFace }) => ({ id, name, hex, cardFace })),
    steps: P.scripts[seatId]
  };
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function sendJson(ws, obj) { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function broadcastSeats(obj) { const s = JSON.stringify(obj); for (const ws of seatSockets.values()) sendJson(ws, s); }
function broadcastDirectors(obj) { const s = JSON.stringify(obj); for (const ws of directorSockets) sendJson(ws, s); }
function broadcastLive() { const m = { t: 'live', live }; broadcastSeats(m); broadcastDirectors(m); }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.joinAttempts = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error('ws handler', e); }
  });
  ws.on('close', () => {
    if (ws.role === 'director') directorSockets.delete(ws);
    if (ws.role === 'seat' && seatSockets.get(ws.seatId) === ws) {
      seatSockets.delete(ws.seatId);
      const d = deviceInfo.get(ws.deviceId); if (d) d.lastSeen = now();
    }
  });
});

function handle(ws, msg) {
  // ping สำหรับซิงค์นาฬิกา ตอบทันทีโดยไม่ต้องยืนยันตัวตน
  if (msg.t === 'ping') return sendJson(ws, { t: 'pong', c: msg.c, s: now() });

  if (msg.t === 'hello' && msg.role === 'director') {
    if (!directorTokens.has(msg.token)) return sendJson(ws, { t: 'error', error: 'auth' });
    ws.role = 'director'; directorSockets.add(ws);
    sendJson(ws, { t: 'live', live });
    sendJson(ws, { t: 'marks', marks: [...marks.values()] });
    return;
  }

  if (msg.t === 'join') {
    if (++ws.joinAttempts > 10) return ws.close(4008, 'too many joins');
    if (!eventValid(msg.eventToken)) return sendJson(ws, { t: 'joinError', error: 'ลิงก์หมดอายุหรือไม่ถูกต้อง ให้สแกน QR ใหม่' });
    const seat = L.byId.get(String(msg.seatId));
    if (!seat || !seat.active) return sendJson(ws, { t: 'joinError', error: 'ไม่พบที่นั่งนี้' });
    const deviceId = String(msg.deviceId || '').slice(0, 40);
    if (!deviceId) return;
    const existing = seatSockets.get(seat.id);
    if (existing && existing !== ws && existing.deviceId !== deviceId && existing.readyState === 1 && !msg.takeover) {
      return sendJson(ws, { t: 'joinConflict', seatId: seat.id });
    }
    if (existing && existing !== ws) { sendJson(existing, { t: 'kicked' }); existing.role = 'kicked'; existing.close(4001, 'seat taken'); }
    if (ws.role === 'seat' && ws.seatId !== seat.id && seatSockets.get(ws.seatId) === ws) seatSockets.delete(ws.seatId);
    ws.role = 'seat'; ws.seatId = seat.id; ws.deviceId = deviceId;
    seatSockets.set(seat.id, ws);
    const d = deviceInfo.get(deviceId) || {};
    deviceInfo.set(deviceId, Object.assign(d, { seatId: seat.id, lastSeen: now() }));
    sendJson(ws, { t: 'joined', seatId: seat.id });
    sendJson(ws, scriptMsg(seat.id));
    sendJson(ws, { t: 'live', live });
    // ส่งจุดผิดที่ยังเปิดอยู่ซ้ำ
    for (const mk of marks.values()) {
      if (mk.seatId === seat.id && ['sent', 'seen', 'nodevice'].includes(mk.status)) {
        if (mk.status === 'nodevice') mk.status = 'sent';
        sendJson(ws, markMsg(mk));
      }
    }
    broadcastMarks();
    return;
  }

  if (ws.role === 'seat') {
    const d = deviceInfo.get(ws.deviceId);
    if (msg.t === 'sync' && d) { d.rtt = +msg.rtt || 0; d.offset = +msg.offset || 0; d.lastSeen = now(); return; }
    if (msg.t === 'beatReport' && msg.seq === live.seq) {
      beatReports.set(ws.deviceId, { lateMs: clamp(+msg.lateMs || 0, -1000, 60000), rtt: +msg.rtt || 0, arrivedLate: !!msg.arrivedLate });
      return;
    }
    if (msg.t === 'markAck') {
      const mk = marks.get(msg.markId);
      if (mk && mk.seatId === ws.seatId && ['seen', 'fixed'].includes(msg.status)) {
        if (!(mk.status === 'fixed' && msg.status === 'seen')) mk.status = msg.status;
        broadcastMarks();
      }
      return;
    }
    return;
  }

  if (ws.role !== 'director') return;

  if (msg.t === 'cmd') return command(msg);
  if (msg.t === 'mark') return createMarks(msg);
  if (msg.t === 'markConfirm') {
    for (const id of msg.markIds || []) { const mk = marks.get(id); if (mk) { mk.status = 'ok'; mk.resolvedAt = now(); } }
    broadcastMarks();
    setTimeout(() => { for (const [id, mk] of marks) if (mk.status === 'ok') marks.delete(id); broadcastMarks(); }, 2500);
    return;
  }
  if (msg.t === 'markResend') {
    for (const id of msg.markIds || []) {
      const mk = marks.get(id); if (!mk) continue;
      const ws2 = seatSockets.get(mk.seatId);
      mk.status = ws2 ? 'sent' : 'nodevice';
      if (ws2) sendJson(ws2, markMsg(mk));
    }
    return broadcastMarks();
  }
}

function command(msg) {
  const P = db.published;
  const count = P ? P.names.length : 0;
  const lead = clamp(Number(msg.leadMs) || (P ? P.leadMs : 1500), 300, 10000);
  if (msg.beatMs) live.beatMs = clamp(Number(msg.beatMs), 300, 3000);
  switch (msg.action) {
    case 'prepare': {
      if (!count) return;
      live.imageIndex = clamp(Math.floor(Number(msg.imageIndex) || 0), 0, count - 1);
      live.status = 'prepared'; live.startAt = 0;
      break;
    }
    case 'countdown': {
      if (!count) return;
      if (msg.imageIndex != null) live.imageIndex = clamp(Math.floor(Number(msg.imageIndex)), 0, count - 1);
      live.status = 'counting'; live.startAt = now() + lead; live.seq++;
      beatReports = new Map();
      break;
    }
    case 'down': live.status = 'down'; live.startAt = now() + Math.min(lead, 1500); live.seq++; break;
    case 'stop': live.status = 'stopped'; live.startAt = 0; break;
    case 'idle': live.status = 'idle'; live.startAt = 0; break;
    default: return;
  }
  broadcastLive();
}

function markMsg(mk) {
  return { t: 'mark', markId: mk.id, imageIndex: mk.imageIndex, expectedColor: mk.expectedColor };
}

function createMarks(msg) {
  const P = db.published; if (!P) return;
  const imageIndex = clamp(Math.floor(Number(msg.imageIndex) || 0), 0, P.names.length - 1);
  for (const seatId of (msg.seatIds || []).slice(0, 5000)) {
    const seat = L.byId.get(seatId);
    if (!seat || !seat.active || !P.scripts[seatId]) continue;
    // ถ้ามีจุดผิดที่เปิดอยู่ของที่นั่ง+ภาพเดียวกัน ให้ใช้ตัวเดิม
    let mk = [...marks.values()].find(x => x.seatId === seatId && x.imageIndex === imageIndex && x.status !== 'ok');
    if (!mk) {
      mk = { id: rid(6), imageIndex, seatId, expectedColor: P.scripts[seatId][imageIndex], status: 'sent', createdAt: now() };
      marks.set(mk.id, mk);
    }
    const ws = seatSockets.get(seatId);
    mk.status = ws ? 'sent' : 'nodevice';
    if (ws) sendJson(ws, markMsg(mk));
  }
  broadcastMarks();
}

let marksTimer = null;
function broadcastMarks() {
  if (marksTimer) return;
  marksTimer = setTimeout(() => { marksTimer = null; broadcastDirectors({ t: 'marks', marks: [...marks.values()] }); }, 100);
}

/* สถิติสำหรับหน้า Director ทุก 1 วินาที */
function pct(arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
setInterval(() => {
  if (!directorSockets.size) return;
  const rtts = [];
  for (const ws of seatSockets.values()) { const d = deviceInfo.get(ws.deviceId); if (d && d.rtt) rtts.push(d.rtt); }
  const errs = [], late = [];
  for (const r of beatReports.values()) {
    if (r.arrivedLate) late.push(r); else errs.push(Math.abs(r.lateMs) + r.rtt / 2);
  }
  broadcastDirectors({
    t: 'stats',
    online: seatSockets.size, total: L.activeCount,
    onlineSeats: [...seatSockets.keys()],
    rttP50: pct(rtts, 0.5), rttP95: pct(rtts, 0.95),
    beat: { reports: beatReports.size, errP50: pct(errs, 0.5), errP95: pct(errs, 0.95), arrivedLate: late.length }
  });
}, 1000);

/* ตัดการเชื่อมต่อที่ตายแล้ว */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`\nCard Stunt Controller พร้อมแล้ว`);
  console.log(`  Director : http://localhost:${PORT}/director`);
  for (const u of lanUrls()) console.log(`  ในวง LAN : ${u}/director`);
  console.log(`  รหัสผ่าน Director: ${db.password}  (ตั้งเองได้ด้วย DIRECTOR_PASSWORD=...)\n`);
});
