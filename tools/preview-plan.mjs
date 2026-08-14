/* preview-plan.mjs — rasterise an extracted plan JSON to a PNG so the extraction can be eyeballed
 * against the original drawing. Debug aid for tuning layer selection and room detection.
 *
 * Usage: node tools/preview-plan.mjs public/plans/foo.json /tmp/foo.png [--px 1600] [--rooms]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const ROLE_COLOR = {
  walls: [20, 26, 38],
  doors: [200, 110, 50],
  glazing: [40, 150, 200],
  stairs: [110, 125, 150],
  furniture: [150, 165, 185],
};

const ROOM_TINT = [
  [255, 214, 214], [214, 235, 255], [219, 255, 219], [255, 246, 200], [238, 219, 255],
  [255, 228, 205], [205, 255, 245], [235, 235, 235], [255, 205, 235], [225, 245, 205],
];

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [inFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const plan = JSON.parse(fs.readFileSync(inFile, 'utf8'));

const PX = parseInt(arg('px', '1600'), 10);
const pad = 20;
const scale = (PX - pad * 2) / plan.widthM;
const W = PX, H = Math.round(plan.depthM * scale) + pad * 2;
const buf = Buffer.alloc(W * H * 3, 255);

const put = (x, y, c) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const n = (y * W + x) * 3;
  buf[n] = c[0]; buf[n + 1] = c[1]; buf[n + 2] = c[2];
};
const sx = (x) => Math.round((x + plan.widthM / 2) * scale) + pad;
const sy = (z) => Math.round((z + plan.depthM / 2) * scale) + pad;

/* room fills first, so line work draws over them */
if (process.argv.includes('--rooms')) {
  plan.rooms.forEach((r, i) => {
    const c = ROOM_TINT[i % ROOM_TINT.length];
    for (const [x0, z0, x1, z1] of r.rects) {
      for (let y = sy(z0); y <= sy(z1); y++) for (let x = sx(x0); x <= sx(x1); x++) put(x, y, c);
    }
  });
  // mark centroids
  plan.rooms.forEach((r) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) put(sx(r.cx) + dx, sy(r.cz) + dy, [200, 0, 0]);
  });
}

const line = (x0, y0, x1, y1, c, thick) => {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    put(x, y, c);
    if (thick) { put(x + 1, y, c); put(x, y + 1, c); }
  }
};

for (const role of ['furniture', 'glazing', 'stairs', 'doors', 'walls']) {
  const c = ROLE_COLOR[role];
  for (const poly of plan.layers[role] || []) {
    for (let k = 1; k < poly.length; k++) {
      line(sx(poly[k - 1][0]), sy(poly[k - 1][1]), sx(poly[k][0]), sy(poly[k][1]), c, role === 'walls');
    }
  }
}

fs.writeFileSync(outFile, png(W, H, buf));
console.log(`${outFile}  ${W}x${H}  ${plan.rooms.length} rooms  ${plan.widthM}x${plan.depthM}m`);
