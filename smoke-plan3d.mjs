/* Offline check for the three.js geometry path the engine uses to render a CAD plan. The engine
   itself can't be instantiated in Node (its constructor needs a WebGL context), so this exercises
   the exact same operations — box extrusion along each wall segment, matrix placement, de-indexing,
   attribute merge, and the multi-rect room prism — against the real plan data, and asserts the
   result is finite and inside the plate. Catches three-version API drift and winding/NaN bugs.
   Run with: npm run check:3d */
import fs from 'node:fs';
import * as T from 'three';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } };

/* estate-engine.js is vendored code written against r128, and three breaks these APIs routinely:
   r152 turned ColorManagement on by default (every hardcoded hex in the scene shifts) and r155
   went physically-correct (both light intensities need x pi). The dependency is pinned exactly for
   that reason — assert it here so a well-meaning bump trips a check instead of quietly re-grading
   the whole scene. */
const THREE_PIN = '0.128.0';
ok(T.REVISION === '128', `three is r128 as pinned (got r${T.REVISION})`);
const threePkg = JSON.parse(fs.readFileSync(new URL('./node_modules/three/package.json', import.meta.url), 'utf8'));
ok(threePkg.version === THREE_PIN, `three resolves to exactly ${THREE_PIN} (got ${threePkg.version})`);

/* --- mirrors buildPlan()/multiPrism() in public/estate-engine.js --- */
function mergeGeos(list) {
  let total = 0;
  list.forEach((g) => { total += g.attributes.position.count; });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  list.forEach((g) => {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  });
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
  return out;
}

const PLAN_WALL_H = 0.85, PLAN_WALL_T = 0.09;  // low soft wall volumes (reference-style linework carries the plan)

function wallGeom(walls) {
  const geos = [];
  for (const poly of walls) {
    for (let k = 1; k < poly.length; k++) {
      const [x0, z0] = poly[k - 1], [x1, z1] = poly[k];
      const dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.02) continue;
      const bg = new T.BoxGeometry(len, PLAN_WALL_H, PLAN_WALL_T);
      bg.applyMatrix4(new T.Matrix4().makeRotationY(Math.atan2(-dz, dx)));
      bg.translate((x0 + x1) / 2, PLAN_WALL_H / 2 + 0.24, (z0 + z1) / 2);
      geos.push(bg.toNonIndexed());
    }
  }
  return { geo: geos.length ? mergeGeos(geos) : null, n: geos.length };
}

function multiPrism(rects, h) {
  const geos = rects.map((r) => {
    const shape = new T.Shape();
    shape.moveTo(r[0], -r[1]); shape.lineTo(r[2], -r[1]);
    shape.lineTo(r[2], -r[3]); shape.lineTo(r[0], -r[3]);
    const g = new T.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return g.index ? g.toNonIndexed() : g;
  });
  return mergeGeos(geos);
}

const dir = new URL('./public/plans/', import.meta.url);
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const plan = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
  console.log(`\n=== ${plan.name} (${file}) ${plan.widthM}x${plan.depthM}m ===`);

  const { geo, n } = wallGeom(plan.layers.walls);
  ok(!!geo, 'wall geometry built');
  const p = geo.attributes.position.array;
  ok(p.length > 0 && p.every(Number.isFinite), 'wall vertices all finite');

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  const halfW = plan.widthM / 2 + 0.5, halfD = plan.depthM / 2 + 0.5;
  ok(minX >= -halfW && maxX <= halfW, `walls within plate on x (${minX.toFixed(2)}..${maxX.toFixed(2)})`);
  ok(minZ >= -halfD && maxZ <= halfD, `walls within plate on z (${minZ.toFixed(2)}..${maxZ.toFixed(2)})`);
  ok(minY >= 0.2 && maxY <= 0.24 + PLAN_WALL_H + 0.01, `walls stand on the slab (${minY.toFixed(2)}..${maxY.toFixed(2)})`);
  ok(geo.attributes.normal.array.some((v) => v !== 0), 'wall normals present (lambert shading will work)');
  console.log(`  wall segments=${n} verts=${geo.attributes.position.count} height=${maxY.toFixed(2)}m`);

  // line layers
  let segs = 0;
  for (const role of ['doors', 'glazing', 'furniture', 'stairs']) {
    const pts = [];
    for (const poly of plan.layers[role] || []) {
      for (let k = 1; k < poly.length; k++) pts.push(poly[k - 1][0], 0.3, poly[k - 1][1], poly[k][0], 0.3, poly[k][1]);
    }
    segs += pts.length / 6;
    if (!pts.length) continue;
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(pts), 3));
    ok(lg.attributes.position.array.every(Number.isFinite), `${role}: line vertices finite`);
  }
  console.log(`  line segments=${segs}`);

  // room pads
  let padVerts = 0;
  for (const room of plan.rooms) {
    const g = multiPrism(room.rects, 0.12);
    const a = g.attributes.position.array;
    ok(a.length > 0 && a.every(Number.isFinite), `room ${room.id}: pad vertices finite`);
    padVerts += g.attributes.position.count;
  }
  console.log(`  room pads=${plan.rooms.length} verts=${padVerts}`);
}

console.log(fails === 0 ? '\nALL 3D CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
