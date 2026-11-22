/* โค้ดที่ใช้ร่วมกันระหว่างเซิร์ฟเวอร์ (Node) และเบราว์เซอร์
 * - ผังสแตนด์ -> กริดภาพ (มุมมองจากฝั่งตรงข้าม = มุมผู้ชม)
 * - ชุดสี, การย่อ/ขยายกริด, การคำนวณบทรายที่นั่ง
 */
(function (root) {
  'use strict';

  function defaultStand() {
    return {
      name: 'สแตนด์หลัก',
      // audienceLeft = ที่นั่งเลข 1 อยู่ซ้ายสุดเมื่อมองจากฝั่งตรงข้าม
      numbering: 'audienceLeft',
      gap: 1, // ช่องว่างระหว่างโซน (ทางเดิน)
      zones: ['A', 'B', 'C', 'D'].map(function (id) {
        return { id: id, rows: fill(20, 24) };
      }),
      blocked: [] // รหัสที่นั่งที่ไม่ใช้ เช่น เสา บันได
    };
  }

  function defaultPalette() {
    return [
      { id: 'w', name: 'ขาว', hex: '#f8fafc', cardFace: 1 },
      { id: 'k', name: 'ดำ', hex: '#111827', cardFace: 2 },
      { id: 'b', name: 'ฟ้า', hex: '#38bdf8', cardFace: 3 },
      { id: 'p', name: 'ชมพู', hex: '#f472b6', cardFace: 4 },
      { id: 'r', name: 'แดง', hex: '#dc2626', cardFace: 5 },
      { id: 'n', name: 'น้ำเงิน', hex: '#1e3a8a', cardFace: 6 },
      { id: 'y', name: 'เหลือง', hex: '#facc15', cardFace: 7 }
    ];
  }

  function fill(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function seatId(zone, row, seat) { return zone + '-' + pad2(row) + '-' + pad2(seat); }

  /* แปลงผังสแตนด์เป็นกริด: แถว 1 (ติดสนาม) อยู่ล่างสุด, โซนเรียงซ้ายไปขวาตามที่ผู้ชมเห็น */
  function layout(stand) {
    var blocked = new Set(stand.blocked || []);
    var height = 1;
    stand.zones.forEach(function (z) { height = Math.max(height, z.rows.length); });
    var gap = stand.gap == null ? 1 : stand.gap;
    var x0 = 0, seats = [], byId = new Map(), zoneSpans = [];
    stand.zones.forEach(function (z, zi) {
      var zw = Math.max.apply(null, [1].concat(z.rows));
      if (zi > 0) x0 += gap;
      z.rows.forEach(function (len, ri) {
        var r = ri + 1, y = height - 1 - ri, padL = Math.floor((zw - len) / 2);
        for (var s = 1; s <= len; s++) {
          var x = x0 + padL + (stand.numbering === 'audienceRight' ? len - s : s - 1);
          var id = seatId(z.id, r, s);
          var seat = { id: id, zone: z.id, row: r, seat: s, x: x, y: y, active: !blocked.has(id) };
          seats.push(seat); byId.set(id, seat);
        }
      });
      zoneSpans.push({ id: z.id, x0: x0, w: zw });
      x0 += zw;
    });
    var width = Math.max(1, x0);
    var cellAt = [];
    for (var y = 0; y < height; y++) cellAt.push(fill(width, null));
    seats.forEach(function (s) { cellAt[s.y][s.x] = s; });
    return {
      width: width, height: height, seats: seats, byId: byId, cellAt: cellAt, zoneSpans: zoneSpans,
      activeCount: seats.filter(function (s) { return s.active; }).length
    };
  }

  function emptyGrid(w, h, colorId) {
    var g = [];
    for (var y = 0; y < h; y++) g.push(fill(w, colorId));
    return g;
  }

  /* ย่อ/ขยายภาพให้พอดีกับผังปัจจุบัน (nearest neighbour) */
  function fitGrid(grid, w, h) {
    var gh = grid.length, gw = gh ? grid[0].length : 0;
    if (gw === w && gh === h) return grid;
    var out = [];
    for (var y = 0; y < h; y++) {
      var row = [], sy = Math.min(gh - 1, Math.floor((y + 0.5) * gh / h));
      for (var x = 0; x < w; x++) {
        var sx = Math.min(gw - 1, Math.floor((x + 0.5) * gw / w));
        row.push(gh ? grid[sy][sx] : null);
      }
      out.push(row);
    }
    return out;
  }

  /* บทรายที่นั่ง: seatId -> [colorId ของภาพที่ 0..N-1] */
  function buildScripts(L, grids) {
    var scripts = {};
    L.seats.forEach(function (s) {
      if (!s.active) return;
      scripts[s.id] = grids.map(function (g) { return g[s.y][s.x]; });
    });
    return scripts;
  }

  /* จำนวนที่นั่งที่ต้องเปลี่ยนสีจากภาพก่อนหน้า (ใช้บอกความยาก) */
  function changedSeats(L, a, b) {
    if (!a || !b) return null;
    var n = 0;
    L.seats.forEach(function (s) { if (s.active && a[s.y][s.x] !== b[s.y][s.x]) n++; });
    return n;
  }

  function colorCounts(L, grid) {
    var c = {};
    L.seats.forEach(function (s) { if (s.active) { var k = grid[s.y][s.x]; c[k] = (c[k] || 0) + 1; } });
    return c;
  }

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function nearestColor(palette, r, g, b) {
    var best = palette[0].id, bd = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var c = palette[i]._rgb || (palette[i]._rgb = hexToRgb(palette[i].hex));
      // ถ่วงน้ำหนักตามการรับรู้สีของตา
      var dr = r - c[0], dg = g - c[1], db = b - c[2];
      var d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = palette[i].id; }
    }
    return best;
  }

  function textOn(hex) {
    var c = hexToRgb(hex);
    var lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    return lum > 0.6 ? '#0b0b0b' : '#ffffff';
  }

  function colorById(palette, id) {
    for (var i = 0; i < palette.length; i++) if (palette[i].id === id) return palette[i];
    return null;
  }

  var api = {
    defaultStand: defaultStand, defaultPalette: defaultPalette, seatId: seatId, layout: layout,
    emptyGrid: emptyGrid, fitGrid: fitGrid, buildScripts: buildScripts, changedSeats: changedSeats,
    colorCounts: colorCounts, hexToRgb: hexToRgb, nearestColor: nearestColor, textOn: textOn,
    colorById: colorById
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stunt = api;
})(this);
