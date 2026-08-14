/* plantroom-models.js — procedural three.js models, one silhouette per Facilio asset category.
   Each builder returns a THREE.Group sized to roughly its real footprint (metres).
   Children tagged userData.spin rotate in the render loop (fans, motor shafts). */
(function () {
  'use strict';

  function hexInt(h) { return parseInt(String(h).replace('#', ''), 16); }
  function shade(hex, amt) {
    var n = parseInt(String(hex).replace('#', ''), 16);
    function mix(c) { return Math.max(0, Math.min(255, Math.round(amt > 0 ? c + (255 - c) * amt : c * (1 + amt)))); }
    return (mix((n >> 16) & 255) << 16) | (mix((n >> 8) & 255) << 8) | mix(n & 255);
  }
  var STEEL = 0xB8C4D4, DARK = 0x51617A, GLASS = 0x2C3E56, WHITE = 0xEEF3FA, RUBBER = 0x3A4557;

  function M(T, geo, color) { return new T.Mesh(geo, new T.MeshLambertMaterial({ color: color })); }
  function box(T, w, h, d, color, x, y, z) { var m = M(T, new T.BoxGeometry(w, h, d), color); m.position.set(x || 0, y || 0, z || 0); return m; }
  function cyl(T, rt, rb, h, color, seg) { return M(T, new T.CylinderGeometry(rt, rb, h, seg || 18), color); }
  function louvre(T, w, h, d, n, color, x, y, z) {
    var g = new T.Group();
    for (var i = 0; i < n; i++) {
      var s = box(T, w, h / n * 0.55, d, color, 0, (i - (n - 1) / 2) * (h / n), 0);
      g.add(s);
    }
    g.position.set(x || 0, y || 0, z || 0);
    return g;
  }
  function fan(T, r, blades, color) {
    var g = new T.Group();
    g.add(M(T, new T.CylinderGeometry(r * 0.18, r * 0.18, 0.12, 12), DARK));
    for (var i = 0; i < blades; i++) {
      var b = M(T, new T.BoxGeometry(r * 0.9, 0.04, r * 0.3), color);
      b.position.set(Math.cos(i / blades * 6.283) * r * 0.5, 0, Math.sin(i / blades * 6.283) * r * 0.5);
      b.rotation.y = -i / blades * 6.283;
      b.rotation.x = 0.35;
      g.add(b);
    }
    g.userData.spin = 2.2;
    return g;
  }
  function pipe(T, r, len, color, axis) {
    var m = cyl(T, r, r, len, color, 14);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    return m;
  }
  function skid(T, w, d, color) { return box(T, w, 0.12, d, color, 0, 0.06, 0); }
  function screen(T, w, h, x, y, z, ry) {
    var g = new T.Group();
    g.add(box(T, w, h, 0.05, DARK, 0, 0, 0));
    g.add(box(T, w * 0.82, h * 0.7, 0.02, 0x4FD1C5, 0, 0, 0.035));
    g.position.set(x, y, z); if (ry) g.rotation.y = ry;
    return g;
  }
  function leds(T, n, w, y, z, color) {
    var g = new T.Group();
    for (var i = 0; i < n; i++) g.add(box(T, 0.05, 0.05, 0.02, i % 3 === 0 ? 0x29A01E : color, (i - (n - 1) / 2) * (w / n), 0, 0));
    g.position.set(0, y, z);
    return g;
  }

  // ---- builders ---------------------------------------------------------
  var B = {};

  B.chiller = function (T, c) {
    var g = new T.Group(), body = shade(c, 0), light = shade(c, 0.25);
    g.add(skid(T, 3.3, 1.3, DARK));
    var evap = pipe(T, 0.36, 3.0, body, 'x'); evap.position.set(0, 0.44, -0.28); g.add(evap);
    var cond = pipe(T, 0.32, 3.0, light, 'x'); cond.position.set(0, 1.02, -0.2); g.add(cond);
    var comp = cyl(T, 0.3, 0.34, 0.9, STEEL, 16); comp.rotation.z = Math.PI / 2; comp.position.set(-0.5, 1.02, 0.42); g.add(comp);
    g.add(box(T, 0.62, 0.8, 0.28, WHITE, 1.15, 0.95, 0.36));
    g.add(screen(T, 0.34, 0.24, 1.15, 1.12, 0.51));
    [-1.1, 0.1, 1.2].forEach(function (x) { var iso = pipe(T, 0.09, 0.62, STEEL, 'y'); iso.position.set(x, 0.75, -0.24); g.add(iso); });
    g.add(box(T, 3.3, 0.06, 0.06, DARK, 0, 1.42, -0.5));
    return g;
  };
  B['chiller-plant-manager'] = function (T, c) {
    var g = new T.Group();
    g.add(box(T, 0.9, 1.7, 0.42, shade(c, 0.1), 0, 0.85, 0));
    g.add(box(T, 0.84, 0.5, 0.03, DARK, 0, 1.28, 0.22));
    g.add(screen(T, 0.5, 0.32, 0, 1.28, 0.245));
    g.add(leds(T, 7, 0.6, 0.92, 0.225, 0xFFD405));
    g.add(box(T, 0.06, 0.5, 0.06, STEEL, 0.5, 1.95, 0));
    g.add(box(T, 0.96, 0.08, 0.48, DARK, 0, 0.04, 0));
    return g;
  };
  function pumpModel(T, c, scale, vertical) {
    var g = new T.Group(), s = scale || 1;
    g.add(skid(T, 1.5 * s, 0.7 * s, DARK));
    var motor = cyl(T, 0.26 * s, 0.26 * s, 0.85 * s, shade(c, 0.12), 20);
    motor.rotation.z = Math.PI / 2; motor.position.set(-0.3 * s, 0.42 * s, 0); g.add(motor);
    for (var i = 0; i < 8; i++) {
      var a = i / 8 * 6.283;
      var fin = box(T, 0.86 * s, 0.05, 0.16 * s, shade(c, -0.15),
        -0.3 * s, 0.42 * s + Math.cos(a) * 0.27 * s, Math.sin(a) * 0.27 * s);
      fin.rotation.x = a; g.add(fin);
    }
    var shaft = cyl(T, 0.07 * s, 0.07 * s, 0.3 * s, STEEL, 10);
    shaft.rotation.z = Math.PI / 2; shaft.position.set(0.1 * s, 0.42 * s, 0); shaft.userData.spin = 3; g.add(shaft);
    var volute = cyl(T, 0.34 * s, 0.34 * s, 0.32 * s, shade(c, -0.1), 22);
    volute.rotation.z = Math.PI / 2; volute.position.set(0.42 * s, 0.42 * s, 0); g.add(volute);
    var suction = pipe(T, 0.15 * s, 0.5 * s, STEEL, vertical ? 'y' : 'x');
    suction.position.set(vertical ? 0.42 * s : 0.85 * s, vertical ? 0.85 * s : 0.42 * s, 0); g.add(suction);
    var flange = cyl(T, 0.2 * s, 0.2 * s, 0.06 * s, STEEL, 16);
    if (vertical) flange.position.set(0.42 * s, 1.1 * s, 0); else { flange.rotation.z = Math.PI / 2; flange.position.set(1.1 * s, 0.42 * s, 0); }
    g.add(flange);
    var disc = pipe(T, 0.14 * s, 0.55 * s, STEEL, 'y'); disc.position.set(0.42 * s, 0.78 * s, 0); g.add(disc);
    return g;
  }
  B['primary-pump'] = function (T, c) { return pumpModel(T, c, 1, true); };
  B['secondary-pump'] = function (T, c) { return pumpModel(T, c, 0.85, true); };
  B['condenser-pump'] = function (T, c) { return pumpModel(T, c, 1.05, false); };

  B.ahu = function (T, c) {
    var g = new T.Group(), body = shade(c, 0.08);
    g.add(skid(T, 3.4, 1.5, DARK));
    g.add(box(T, 3.2, 1.4, 1.3, body, 0, 0.82, 0));
    [-1.05, -0.05, 0.95].forEach(function (x) { g.add(box(T, 0.05, 1.4, 1.32, shade(c, -0.18), x, 0.82, 0)); });
    var door = box(T, 0.7, 1.0, 0.04, shade(c, 0.22), 0.55, 0.82, 0.67); g.add(door);
    var handle = cyl(T, 0.05, 0.05, 0.3, STEEL, 8); handle.position.set(0.86, 0.82, 0.7); g.add(handle);
    g.add(louvre(T, 0.7, 0.9, 0.05, 6, STEEL, -1.4, 0.9, 0.66));
    var duct = pipe(T, 0.34, 0.9, STEEL, 'x'); duct.position.set(1.95, 1.05, 0); g.add(duct);
    var out = box(T, 0.16, 0.86, 0.86, shade(c, -0.2), 2.4, 1.05, 0); g.add(out);
    var f = fan(T, 0.5, 5, WHITE); f.rotation.z = Math.PI / 2; f.position.set(1.35, 1.05, 0); g.add(f);
    g.add(box(T, 0.5, 0.3, 0.24, WHITE, -1.2, 1.75, 0));
    return g;
  };
  B.fahu = function (T, c) {
    var g = B.ahu(T, c);
    var hood = box(T, 0.9, 0.95, 1.36, shade(c, -0.12), -2.0, 1.2, 0); g.add(hood);
    hood.rotation.z = 0.12;
    g.add(louvre(T, 0.05, 0.85, 1.2, 7, STEEL, -2.44, 1.2, 0));
    return g;
  };
  B['cooling-tower'] = function (T, c) {
    var g = new T.Group(), body = shade(c, 0.1);
    g.add(box(T, 2.6, 0.5, 2.6, shade(c, -0.2), 0, 0.25, 0));
    var shell = M(T, new T.CylinderGeometry(1.15, 1.35, 1.5, 4), body);
    shell.rotation.y = Math.PI / 4; shell.position.y = 1.25; g.add(shell);
    g.add(louvre(T, 2.3, 0.9, 0.06, 6, STEEL, 0, 0.8, 1.22));
    g.add(louvre(T, 0.06, 0.9, 2.3, 6, STEEL, -1.22, 0.8, 0));
    g.add(box(T, 2.1, 0.16, 2.1, DARK, 0, 2.05, 0));
    var ring = M(T, new T.CylinderGeometry(0.95, 0.95, 0.42, 26, 1, true), STEEL);
    ring.position.y = 2.3; g.add(ring);
    var f = fan(T, 1.6, 6, WHITE); f.position.y = 2.34; g.add(f);
    var riser = pipe(T, 0.13, 1.3, STEEL, 'y'); riser.position.set(1.05, 0.9, 1.05); g.add(riser);
    return g;
  };
  B['heat-pump'] = function (T, c) {
    var g = new T.Group(), body = shade(c, 0.12);
    g.add(box(T, 1.9, 1.5, 0.95, body, 0, 0.82, 0));
    g.add(box(T, 2.0, 0.1, 1.05, DARK, 0, 0.05, 0));
    [-0.45, 0.45].forEach(function (x) {
      var grille = M(T, new T.CylinderGeometry(0.42, 0.42, 0.05, 26), DARK);
      grille.rotation.x = Math.PI / 2; grille.position.set(x, 0.95, 0.5); g.add(grille);
      var f = fan(T, 0.68, 3, WHITE); f.rotation.x = Math.PI / 2; f.position.set(x, 0.95, 0.53); g.add(f);
    });
    g.add(louvre(T, 1.8, 0.5, 0.05, 5, STEEL, 0, 0.32, 0.49));
    g.add(box(T, 0.36, 0.5, 0.06, WHITE, 0.72, 1.4, 0.5));
    return g;
  };
  B.fcu = function (T, c) {
    var g = new T.Group();
    g.add(box(T, 1.5, 0.42, 0.95, shade(c, 0.18), 0, 0.9, 0));
    g.add(box(T, 1.32, 0.06, 0.78, WHITE, 0, 0.67, 0));
    g.add(louvre(T, 1.2, 0.16, 0.7, 4, STEEL, 0, 0.66, 0));
    [0.62, 0.44].forEach(function (x) { var cw = pipe(T, 0.07, 0.55, STEEL, 'y'); cw.position.set(x, 1.35, -0.3); g.add(cw); });
    [-0.6, 0.6].forEach(function (x) { g.add(box(T, 0.04, 0.62, 0.04, DARK, x, 1.42, 0.3)); });
    return g;
  };
  function meterModel(T, c, kind) {
    var g = new T.Group(), body = shade(c, 0.12);
    if (kind === 'water') {
      var run = pipe(T, 0.17, 2.0, STEEL, 'x'); run.position.y = 0.5; g.add(run);
      g.add(box(T, 0.62, 0.5, 0.5, body, 0, 0.55, 0));
      var dial = cyl(T, 0.2, 0.2, 0.06, WHITE, 22); dial.position.set(0, 0.83, 0); g.add(dial);
      var lens = cyl(T, 0.16, 0.16, 0.02, GLASS, 20); lens.position.set(0, 0.87, 0); g.add(lens);
      [-0.75, 0.75].forEach(function (x) { var f = cyl(T, 0.24, 0.24, 0.07, STEEL, 16); f.rotation.z = Math.PI / 2; f.position.set(x, 0.5, 0); g.add(f); });
      return g;
    }
    g.add(box(T, 0.12, 1.35, 0.9, DARK, -0.28, 0.7, 0));           // backplate
    g.add(box(T, 0.42, 1.1, 0.72, body, 0, 0.72, 0));
    g.add(box(T, 0.05, 0.42, 0.56, GLASS, 0.23, 0.92, 0));
    g.add(screen(T, 0.34, 0.2, 0.25, 0.92, 0, Math.PI / 2));
    var pilot = leds(T, 4, 0.4, 0.55, 0, 0x29A01E); pilot.rotation.y = Math.PI / 2; pilot.position.x = 0.24; g.add(pilot);
    if (kind === 'utility') g.add(box(T, 0.46, 0.16, 0.76, shade(c, -0.2), 0, 0.2, 0));
    g.add(box(T, 0.36, 0.1, 0.66, STEEL, 0, 1.3, 0));
    return g;
  }
  B['energy-meter'] = function (T, c) { return meterModel(T, c, 'energy'); };
  B['utility-meter'] = function (T, c) { return meterModel(T, c, 'utility'); };
  B['water-meter'] = function (T, c) { return meterModel(T, c, 'water'); };

  function controllerModel(T, c, ports) {
    var g = new T.Group(), body = shade(c, 0.16);
    g.add(box(T, 1.0, 1.25, 0.34, shade(c, -0.12), 0, 0.68, -0.06)); // enclosure
    g.add(box(T, 0.9, 1.1, 0.06, DARK, 0, 0.68, 0.13));              // backpanel
    g.add(box(T, 0.86, 0.06, 0.1, STEEL, 0, 1.02, 0.16));            // DIN rail
    g.add(box(T, 0.86, 0.06, 0.1, STEEL, 0, 0.5, 0.16));
    var n = Math.max(2, Math.min(5, ports));
    for (var i = 0; i < n; i++) {
      var mod = box(T, 0.72 / n, 0.3, 0.16, body, (i - (n - 1) / 2) * (0.84 / n), 1.15, 0.2);
      g.add(mod);
      g.add(box(T, 0.72 / n * 0.7, 0.05, 0.02, 0x29A01E, (i - (n - 1) / 2) * (0.84 / n), 1.26, 0.29));
    }
    g.add(box(T, 0.8, 0.16, 0.16, DARK, 0, 0.62, 0.2));              // terminal strip
    for (var j = 0; j < 8; j++) g.add(box(T, 0.05, 0.05, 0.02, 0xFFD405, -0.34 + j * 0.1, 0.62, 0.3));
    g.add(box(T, 1.04, 1.29, 0.03, GLASS, 0.02, 0.68, 0.3));         // hinged clear door
    g.add(box(T, 0.05, 0.2, 0.05, STEEL, 0.5, 0.68, 0.34));
    return g;
  }
  B.controller = function (T, c) { return controllerModel(T, c, 3); };
  B.devices = function (T, c) {
    var g = new T.Group();
    var stalk = cyl(T, 0.06, 0.09, 1.0, STEEL, 12); stalk.position.y = 0.5; g.add(stalk);
    var puck = cyl(T, 0.3, 0.3, 0.16, shade(c, 0.2), 24); puck.position.y = 1.06; g.add(puck);
    var face = cyl(T, 0.2, 0.2, 0.03, WHITE, 20); face.position.y = 1.15; g.add(face);
    g.add(box(T, 0.06, 0.06, 0.02, 0x29A01E, 0.18, 1.06, 0.24));
    var ant = cyl(T, 0.02, 0.02, 0.34, DARK, 8); ant.position.set(0.22, 1.28, 0); ant.rotation.z = -0.25; g.add(ant);
    return g;
  };
  B.refrigeration = function (T, c) {
    var g = new T.Group(), body = shade(c, 0.14);
    g.add(box(T, 1.5, 2.0, 0.95, body, 0, 1.0, 0));
    g.add(box(T, 1.54, 0.1, 1.0, DARK, 0, 0.05, 0));
    [-0.37, 0.37].forEach(function (x) {
      g.add(box(T, 0.68, 1.55, 0.05, shade(c, -0.1), x, 1.15, 0.49));
      g.add(box(T, 0.5, 1.2, 0.02, GLASS, x, 1.2, 0.52));
      g.add(box(T, 0.05, 0.5, 0.06, STEEL, x + (x > 0 ? -0.3 : 0.3), 1.15, 0.56));
    });
    g.add(box(T, 1.4, 0.3, 0.85, DARK, 0, 2.2, 0));
    var f = fan(T, 0.3, 4, WHITE); f.rotation.x = Math.PI / 2; f.position.set(0, 2.2, 0.44); g.add(f);
    g.add(screen(T, 0.3, 0.18, 0.5, 2.2, 0.44));
    return g;
  };

  var TYPE_FALLBACK = {
    ENERGY: function (T, c) { return meterModel(T, c, 'energy'); },
    HVAC: B.ahu,
    CONTROLLER: function (T, c) { return controllerModel(T, c, 3); },
    DEVICE: B.devices,
    REFRIGERANT: B.refrigeration
  };
  var LABELS = {
    chiller: 'Water-cooled chiller skid', 'chiller-plant-manager': 'Plant manager cabinet',
    'primary-pump': 'End-suction pump set', 'secondary-pump': 'End-suction pump set',
    'condenser-pump': 'Horizontal condenser pump', ahu: 'Air handling unit',
    fahu: 'Fresh-air handling unit', 'cooling-tower': 'Induced-draft cooling tower',
    'heat-pump': 'Air-source heat pump', fcu: 'Ceiling fan-coil unit',
    'energy-meter': 'Panel energy meter', 'utility-meter': 'Utility meter board',
    'water-meter': 'In-line water meter', devices: 'Field sensor', refrigeration: 'Refrigeration cabinet'
  };
  var TYPE_LABEL = { ENERGY: 'Meter body', HVAC: 'Air handling unit', CONTROLLER: 'DIN-rail control panel', DEVICE: 'Field sensor', REFRIGERANT: 'Refrigeration cabinet' };

  function ports(id) { return 2 + (id.length % 4); }

  window.PlantRoomModels = {
    build: function (T, node) {
      var c = node.color, id = node.id, g;
      if (B[id]) g = B[id](T, c);
      else if (/controller$/.test(id)) g = controllerModel(T, c, ports(id));
      else if (id === 'hvac') g = B.ahu(T, c);
      else g = (TYPE_FALLBACK[node.type] || B.devices)(T, c);
      var bb = new T.Box3().setFromObject(g);
      g.userData.height = bb.max.y - bb.min.y;
      g.userData.radius = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
      return g;
    },
    labelFor: function (node) {
      return LABELS[node.id] || (/controller$/.test(node.id) ? 'DIN-rail control panel' : TYPE_LABEL[node.type] || 'Equipment');
    }
  };
})();
