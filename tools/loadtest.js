/* ทดสอบโหลดและความแม่นของการซิงค์
 * จำลองมือถือ N เครื่องเข้าที่นั่ง ซิงค์นาฬิกาแบบเดียวกับหน้า Seat แล้วสั่งนับ 1 2 3 หลายรอบ
 * วัด: ค่าคลาดของนาฬิกาที่ประมาณได้เทียบกับค่าจริง และเวลาที่คำสั่งมาถึงก่อน startAt
 *
 * ใช้:  DIRECTOR_PASSWORD=xxx node tools/loadtest.js --n 1000 --jitter 150
 *   --url     http://localhost:3000
 *   --n       จำนวนเครื่องจำลอง (ค่าเริ่มต้น 500)
 *   --jitter  หน่วงสุ่ม 0..jitter ms ทั้งขาไปและขากลับ จำลองเน็ตในสนามที่แกว่ง (ค่าเริ่มต้น 0)
 *   --rounds  จำนวนรอบนับ (ค่าเริ่มต้น 3)
 */
'use strict';
const WebSocket = require('ws');
const S = require('../public/shared.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://localhost:3000');
const N = Number(arg('n', 500));
const JITTER = Number(arg('jitter', 0));
const ROUNDS = Number(arg('rounds', 3));
const PASSWORD = process.env.DIRECTOR_PASSWORD || arg('password');
const WSURL = BASE.replace(/^http/, 'ws') + '/ws';

const localNow = () => performance.timeOrigin + performance.now();
const trueOffset = () => Date.now() - localNow(); // เซิร์ฟเวอร์ใช้ Date.now() บนเครื่องเดียวกัน
const delay = () => (JITTER ? Math.random() * JITTER : 0);
const later = (fn) => (JITTER ? setTimeout(fn, delay()) : fn());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function main() {
  if (!PASSWORD) { console.error('ต้องใส่ DIRECTOR_PASSWORD=... (ดูจากหน้าต่างเซิร์ฟเวอร์)'); process.exit(1); }
  const lr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  if (!lr.ok) throw new Error('ล็อกอินไม่ได้');
  const { token } = await lr.json();
  const data = await (await fetch(BASE + '/api/data', { headers: { Authorization: 'Bearer ' + token } })).json();
  if (!data.published) throw new Error('ยังไม่ได้เผยแพร่ชุดการแสดง');
  const L = S.layout(data.stand);
  const seats = L.seats.filter(s => s.active).slice(0, N);
  console.log(`เชื่อมต่อ ${seats.length} เครื่องจำลอง (jitter ${JITTER} ms) …`);

  const clients = [];
  const t0 = Date.now();
  await Promise.all(seats.map((seat, i) => new Promise((resolve) => {
    const c = { seat, offset: 0, samples: [], arrivals: [] };
    clients.push(c);
    setTimeout(() => {
      const ws = c.ws = new WebSocket(WSURL);
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'join', eventToken: data.event.token, seatId: seat.id, deviceId: 'lt-' + i }));
        for (let k = 0; k < 10; k++) setTimeout(() => later(() => ws.send(JSON.stringify({ t: 'ping', c: localNow() }))), k * 120);
        setTimeout(() => {
          const best = c.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a), { rtt: Infinity });
          c.offset = best.off; c.rtt = best.rtt;
          ws.send(JSON.stringify({ t: 'sync', rtt: Math.round(best.rtt), offset: Math.round(best.off) }));
          resolve();
        }, 10 * 120 + 400 + JITTER * 2);
      });
      ws.on('message', raw => later(() => {
        const m = JSON.parse(raw);
        if (m.t === 'pong') { const t = localNow(), rtt = t - m.c; c.samples.push({ rtt, off: m.s + rtt / 2 - t }); }
        if (m.t === 'live' && c.joinSeq == null) { c.joinSeq = m.live.seq; return; } // สถานะเดิมตอนเข้า ไม่นับ
        if (m.t === 'live' && m.live.status === 'counting' && m.live.seq > c.joinSeq) {
          // เวลาที่ "1" จะขึ้นบนเครื่องนี้ ตามนาฬิกาจริง (Date.now)
          const shownAtTrue = (m.live.startAt - c.offset) + trueOffset();
          c.arrivals.push({ seq: m.live.seq, errMs: shownAtTrue - m.live.startAt, leadMs: m.live.startAt - (localNow() + c.offset) });
        }
      }));
      ws.on('error', () => resolve());
    }, Math.floor(i / 50) * 20); // ทยอยเข้าเหมือนคนสแกน QR
  })));
  console.log(`เข้าครบใน ${Date.now() - t0} ms · ออนไลน์ ${clients.filter(c => c.ws.readyState === 1).length}`);

  const dir = new WebSocket(WSURL);
  await new Promise(r => dir.on('open', r));
  dir.send(JSON.stringify({ t: 'hello', role: 'director', token }));
  for (let r = 0; r < ROUNDS; r++) {
    dir.send(JSON.stringify({ t: 'cmd', action: 'countdown', imageIndex: r % data.published.names.length }));
    await sleep(data.show.leadMs + 3 * data.show.beatMs + 500);
  }
  dir.send(JSON.stringify({ t: 'cmd', action: 'idle' }));

  const errs = [], leads = [];
  for (const c of clients) for (const a of c.arrivals) { errs.push(Math.abs(a.errMs)); leads.push(a.leadMs); }
  const rtts = clients.map(c => c.rtt).filter(Number.isFinite);
  console.log('\nผลลัพธ์');
  console.log(`  RTT ต่ำสุดต่อเครื่อง     p50 ${pct(rtts, .5).toFixed(1)} ms · p95 ${pct(rtts, .95).toFixed(1)} ms`);
  console.log(`  ความคลาดของเลข "1"     p50 ${pct(errs, .5).toFixed(1)} ms · p95 ${pct(errs, .95).toFixed(1)} ms · max ${Math.max(...errs).toFixed(1)} ms`);
  console.log(`  คำสั่งมาถึงก่อน startAt  min ${Math.min(...leads).toFixed(0)} ms · p50 ${pct(leads, .5).toFixed(0)} ms (ติดลบ = มาช้า)`);
  console.log(`  ได้รับคำสั่ง ${errs.length} / ${clients.length * ROUNDS}`);
  const pass = pct(errs, .95) <= 50 && Math.min(...leads) > 0;
  console.log(pass ? '\n✅ ผ่านเป้า: คลาดไม่เกิน 50 ms สำหรับ 95% และทุกเครื่องได้คำสั่งก่อนเวลาเริ่ม' : '\n❌ ไม่ผ่านเป้า');
  console.log('  หมายเหตุ: วัดบนเครื่องเดียวกัน ไม่รวมความหน่วงของจอมือถือจริงและเน็ตในสนาม');
  for (const c of clients) c.ws.close();
  dir.close();
  setTimeout(() => process.exit(pass ? 0 : 2), 200);
}
main().catch(e => { console.error(e.message); process.exit(1); });
