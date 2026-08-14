/* extract-plan.mjs — turn a geometry-only CAD floor-plan SVG into a compact plan JSON the
 * 3D engine can render.
 *
 * The exports carry two things that make this reliable:
 *   1. a <metadata id="plan-plate"> block with world bounds + px-per-world-unit, so pixels
 *      convert back to real millimetres, and
 *   2. data-layer attributes carrying the original CAD layer names, so wall / door / glazing /
 *      furniture geometry can be told apart instead of guessed at.
 *
 * Paths are pure polylines (M/L/Z only) with no transforms, so parsing is exact — no curve
 * flattening, no matrix stack.
 *
 * Everything not on a recognised layer is DROPPED and reported, so nothing is silently kept or
 * lost. Hatch fills and glazing mullion strokes are the bulk of these files (110k paths in one)
 * and carry no useful structure at 3D viewing scale.
 *
 * Usage: node tools/extract-plan.mjs <in.svg> <out.json> --id <id> --name "Level 1"
 */

import fs from 'node:fs';

/* ---------- layer -> role ---------- */

const ROLES = [
  // order matters: first match wins
  [/dimension|^6-|text|axis|title|q-spcq|detl|hdln|section|cn_|gm_|hatch/i, null],   // annotation / fill noise
  [/wall\s*tiles/i, null],
  [/core\s*wall|^a-wall|\$walls$|\bwalls\b|wallhatch/i, 'walls'],
  [/door/i, 'doors'],
  [/glaz|glass|partition|window|facade/i, 'glazing'],
  [/stair/i, 'stairs'],
  [/furn|joinery|equipment|sanitory|sanitary|flor|hral/i, 'furniture'],
];

function roleFor(layer) {
  for (const [re, role] of ROLES) if (re.test(layer)) return role;
  return undefined;   // unrecognised
}

/* ---------- parse ---------- */

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function parsePath(d) {
  // pure polyline: M x y (L x y)* [Z]
  const out = [];
  let cur = null;
  const re = /([MLZ])\s*(-?[\d.]+)?[\s,]*(-?[\d.]+)?/gi;
  let m;
  while ((m = re.exec(d))) {
    const cmd = m[1].toUpperCase();
    if (cmd === 'Z') { if (cur && cur.length > 1) { cur.push(cur[0].slice()); } continue; }
    const x = parseFloat(m[2]), y = parseFloat(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (cmd === 'M') { if (cur && cur.length > 1) out.push(cur); cur = [[x, y]]; }
    else if (cur) cur.push([x, y]);
  }
  if (cur && cur.length > 1) out.push(cur);
  return out;
}

/* ---------- room detection ----------
 * Walls come out of CAD as loose line segments, not as closed room polygons, so enclosed spaces
 * have to be recovered. Rasterising is far more robust here than planar-subdivision: rasterise
 * every barrier (walls, glazing/partitions and door leaves — a door leaf closes the wall opening,
 * which is exactly the separation we want), dilate by one cell to seal hairline gaps where CAD
 * lines don't quite meet, flood-fill the outside from the border, and every remaining pocket of
 * connected free cells is a room.
 */
function detectRooms(layers, widthM, depthM, cell, minArea, seal) {
  const pad = 0.5;
  const W = Math.ceil((widthM + pad * 2) / cell);
  const H = Math.ceil((depthM + pad * 2) / cell);
  const ox = widthM / 2 + pad, oz = depthM / 2 + pad;      // world -> grid origin offset
  const gx = (x) => Math.round((x + ox) / cell);
  const gz = (z) => Math.round((z + oz) / cell);

  const barrier = new Uint8Array(W * H);
  const mark = (i, j) => { if (i >= 0 && i < W && j >= 0 && j < H) barrier[j * W + i] = 1; };

  for (const role of ['walls', 'glazing', 'doors']) {
    for (const poly of layers[role]) {
      for (let k = 1; k < poly.length; k++) {
        let [x0, z0] = poly[k - 1], [x1, z1] = poly[k];
        let i0 = gx(x0), j0 = gz(z0), i1 = gx(x1), j1 = gz(z1);
        const steps = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
        for (let s = 0; s <= steps; s++) {
          const t = steps ? s / steps : 0;
          mark(Math.round(i0 + (i1 - i0) * t), Math.round(j0 + (j1 - j0) * t));
        }
      }
    }
  }

  /* separable square dilation — radius in cells */
  const dilate = (src, r) => {
    if (r <= 0) return new Uint8Array(src);
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let v = 0;
        for (let d = -r; d <= r && !v; d++) { const ni = i + d; if (ni >= 0 && ni < W && src[j * W + ni]) v = 1; }
        tmp[j * W + i] = v;
      }
    }
    for (let i = 0; i < W; i++) {
      for (let j = 0; j < H; j++) {
        let v = 0;
        for (let d = -r; d <= r && !v; d++) { const nj = j + d; if (nj >= 0 && nj < H && tmp[nj * W + i]) v = 1; }
        out[j * W + i] = v;
      }
    }
    return out;
  };

  const solid = dilate(barrier, 1);                            // seal hairline gaps between line ends
  const sealCells = Math.max(1, Math.round(seal / cell));
  const sealed = dilate(barrier, sealCells);                   // seal door openings for connectivity only

  /* label = 0 outside, 1..N rooms, -1 unassigned */
  const label = new Int32Array(W * H).fill(-1);
  const stack = [];

  const floodSealed = (startI, startJ, lab) => {
    const n0 = startJ * W + startI;
    if (sealed[n0] || label[n0] !== -1) return false;
    label[n0] = lab; stack.push(n0);
    let count = 0;
    while (stack.length) {
      const n = stack.pop(); count++;
      const i = n % W, j = (n - i) / W;
      const nb = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]];
      for (const [ni, nj] of nb) {
        if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue;
        const m = nj * W + ni;
        if (sealed[m] || label[m] !== -1) continue;
        label[m] = lab; stack.push(m);
      }
    }
    return count;
  };

  // outside first, from the border
  for (let i = 0; i < W; i++) { floodSealed(i, 0, 0); floodSealed(i, H - 1, 0); }
  for (let j = 0; j < H; j++) { floodSealed(0, j, 0); floodSealed(W - 1, j, 0); }

  // remaining pockets on the sealed grid are room cores
  let next = 1;
  const coreSize = new Map();
  for (let n = 0; n < W * H; n++) {
    if (sealed[n] || label[n] !== -1) continue;
    const i = n % W, j = (n - i) / W;
    const size = floodSealed(i, j, next);
    coreSize.set(next, size);
    next++;
  }

  /* Grow the cores back over the real (un-sealed) free space so areas are true room areas rather
     than the shrunken cores. Multi-source BFS: nearest core wins, and the outside label competes
     too so nothing bleeds out through a doorway. */
  const full = new Int32Array(label);
  const q = [];
  for (let n = 0; n < W * H; n++) if (full[n] !== -1 && !solid[n]) q.push(n);
  for (let head = 0; head < q.length; head++) {
    const n = q[head], i = n % W, j = (n - i) / W, lab = full[n];
    const nb = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]];
    for (const [ni, nj] of nb) {
      if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue;
      const m = nj * W + ni;
      if (solid[m] || full[m] !== -1) continue;
      full[m] = lab; q.push(m);
    }
  }

  const acc = new Map();
  for (let n = 0; n < W * H; n++) {
    const lab = full[n];
    if (lab === undefined || lab <= 0) continue;
    const i = n % W, j = (n - i) / W;
    const x = i * cell - ox, z = j * cell - oz;
    let a = acc.get(lab);
    if (!a) { a = { n: 0, sx: 0, sz: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }; acc.set(lab, a); }
    a.n++; a.sx += x; a.sz += z;
    if (x < a.x0) a.x0 = x; if (x > a.x1) a.x1 = x;
    if (z < a.z0) a.z0 = z; if (z > a.z1) a.z1 = z;
  }

  /* Rooms are rarely rectangles — an open-plan floor wraps in an L around the core, so its bounding
     box would swallow every other room. Decompose each room's actual cell mask into a small set of
     non-overlapping rectangles instead. Coarse cells are assigned to whichever room owns most of
     the fine cells inside them, so no two rooms can claim the same ground. */
  const STEP = Math.max(1, Math.round(0.25 / cell));
  const CW = Math.ceil(W / STEP), CH = Math.ceil(H / STEP);
  const owner = new Int32Array(CW * CH).fill(0);
  {
    const tally = new Map();
    for (let cj = 0; cj < CH; cj++) {
      for (let ci = 0; ci < CW; ci++) {
        tally.clear();
        for (let j = cj * STEP; j < Math.min((cj + 1) * STEP, H); j++) {
          for (let i = ci * STEP; i < Math.min((ci + 1) * STEP, W); i++) {
            const lab = full[j * W + i];
            if (lab > 0) tally.set(lab, (tally.get(lab) || 0) + 1);
          }
        }
        let best = 0, bestN = STEP * STEP * 0.35;    // needs a real majority to claim the cell
        for (const [lab, n] of tally) if (n > bestN) { best = lab; bestN = n; }
        owner[cj * CW + ci] = best;
      }
    }
  }

  const rectsFor = (lab) => {
    const used = new Uint8Array(CW * CH);
    const out = [];
    for (let cj = 0; cj < CH; cj++) {
      for (let ci = 0; ci < CW; ci++) {
        if (owner[cj * CW + ci] !== lab || used[cj * CW + ci]) continue;
        let w = 0;
        while (ci + w < CW && owner[cj * CW + ci + w] === lab && !used[cj * CW + ci + w]) w++;
        let h = 1;
        grow: while (cj + h < CH) {
          for (let k = 0; k < w; k++) {
            const n = (cj + h) * CW + ci + k;
            if (owner[n] !== lab || used[n]) break grow;
          }
          h++;
        }
        for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) used[(cj + dj) * CW + ci + di] = 1;
        out.push([
          ci * STEP * cell - ox, cj * STEP * cell - oz,
          (ci + w) * STEP * cell - ox, (cj + h) * STEP * cell - oz,
        ]);
      }
    }
    return out;
  };

  const cellArea = cell * cell;
  const r2 = (v) => Math.round(v * 100) / 100;
  const rooms = [];
  for (const [lab, a] of acc) {
    const area = a.n * cellArea;
    if (area < minArea) continue;
    const rects = rectsFor(lab)
      .filter(([x0, z0, x1, z1]) => (x1 - x0) * (z1 - z0) > 0.2)
      .sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]))
      .slice(0, 48)
      .map((r) => r.map(r2));
    if (!rects.length) continue;
    rooms.push({
      area: r2(area),
      cx: r2(a.sx / a.n), cz: r2(a.sz / a.n),     // centroid — stays inside L-shaped rooms
      x0: r2(a.x0), z0: r2(a.z0), x1: r2(a.x1), z1: r2(a.z1),
      rects,
    });
  }
  rooms.sort((a, b) => b.area - a.area);
  return rooms.map((r, i) => ({ id: i + 1, ...r }));
}

function main() {
  const [inFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flag = (n, dflt) => {
    const i = process.argv.indexOf('--' + n);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  const svg = fs.readFileSync(inFile, 'utf8');

  const meta = JSON.parse(decode(/<metadata id="plan-plate">(.*?)<\/metadata>/s.exec(svg)[1]));
  const pxPerM = meta.transform.px_per_unit_x * 1000;      // world units are mm
  const pxPerMy = meta.transform.px_per_unit_y * 1000;

  /* collect polylines per role, in pixels */
  const byRole = { walls: [], doors: [], glazing: [], stairs: [], furniture: [] };
  const dropped = new Map();
  const kept = new Map();

  const gRe = /<g\s+data-layer="([^"]*)"[^>]*>(.*?)<\/g>/gs;
  let g;
  while ((g = gRe.exec(svg))) {
    const layer = decode(g[1]);
    const role = roleFor(layer);
    const body = g[2];
    const paths = [...body.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
    if (!role) {
      if (role === undefined) dropped.set(layer, (dropped.get(layer) || 0) + paths.length);
      else dropped.set(layer + ' (annotation)', (dropped.get(layer + ' (annotation)') || 0) + paths.length);
      continue;
    }
    kept.set(layer, (kept.get(layer) || 0) + paths.length);
    for (const d of paths) for (const poly of parsePath(d)) byRole[role].push(poly);
  }

  /* plate extents come from structure (walls first), not from the drawing border/title block */
  const ref = byRole.walls.length > 40 ? byRole.walls : [...byRole.walls, ...byRole.glazing, ...byRole.doors];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ref) for (const [x, y] of p) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const widthM = (maxX - minX) / pxPerM;
  const depthM = (maxY - minY) / pxPerMy;

  /* px -> metres, centred on the plate. SVG y runs down, which is +z in the 3D view. */
  const R = 1000;
  const conv = (p) => p.map(([x, y]) => [
    Math.round(((x - cx) / pxPerM) * R) / R,
    Math.round(((y - cy) / pxPerMy) * R) / R,
  ]);

  const MIN_SEG = 0.004;      // 4 mm — below this a segment is drafting noise
  const MIN_LEN = { walls: 0.05, doors: 0.02, glazing: 0.05, stairs: 0.03, furniture: 0.06 };

  function clean(polys, role) {
    const out = [];
    for (const raw of polys) {
      const p = conv(raw);
      // drop repeated / sub-millimetre points
      const s = [p[0]];
      for (let i = 1; i < p.length; i++) {
        const [ax, az] = s[s.length - 1], [bx, bz] = p[i];
        if (Math.hypot(bx - ax, bz - az) >= MIN_SEG) s.push(p[i]);
      }
      if (s.length < 2) continue;
      // drop polylines outside the plate (title blocks, keynotes, north arrows)
      const halfW = widthM / 2 + 1, halfD = depthM / 2 + 1;
      if (s.some(([x, z]) => Math.abs(x) > halfW || Math.abs(z) > halfD)) continue;
      let len = 0;
      for (let i = 1; i < s.length; i++) len += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
      if (len < MIN_LEN[role]) continue;
      out.push(s);
    }
    return out;
  }

  const layers = {};
  for (const role of Object.keys(byRole)) layers[role] = clean(byRole[role], role);

  const rooms = detectRooms(layers, widthM, depthM, parseFloat(flag('cell', '0.05')), parseFloat(flag('minArea', '2.5')), parseFloat(flag('seal', '0.6')));

  const plan = {
    id: flag('id', 'plan'),
    name: flag('name', 'Floor plan'),
    source: inFile.split('/').pop(),
    widthM: Math.round(widthM * 100) / 100,
    depthM: Math.round(depthM * 100) / 100,
    rooms,
    layers,
  };

  fs.writeFileSync(outFile, JSON.stringify(plan));
  const seg = (a) => a.reduce((n, p) => n + p.length - 1, 0);

  console.log(`\n${plan.name} — ${plan.widthM} x ${plan.depthM} m   ->  ${outFile}`);
  console.log('  kept layers:');
  for (const [k, v] of [...kept].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(7)}  ${k}  [${roleFor(k)}]`);
  console.log('  polylines / segments per role:');
  for (const r of Object.keys(layers)) console.log(`    ${r.padEnd(10)} ${String(layers[r].length).padStart(6)} / ${seg(layers[r])}`);
  console.log(`  rooms detected: ${plan.rooms.length}  (total ${plan.rooms.reduce((n, r) => n + r.area, 0).toFixed(0)} m² of ${(plan.widthM * plan.depthM).toFixed(0)} m² plate)`);
  console.log('    ' + plan.rooms.slice(0, 14).map((r) => `${r.area}m²`).join('  '));
  console.log('  dropped layers:');
  for (const [k, v] of [...dropped].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(v).padStart(7)}  ${k}`);
  console.log(`  output: ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
}

main();
