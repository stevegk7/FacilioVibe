/* estate-engine.js — three.js digital-twin estate scene.
   Taxonomy (asset categories, trades, space categories and their colours) comes from
   facilio-taxonomy.js, extracted verbatim from the org's assetcategory / spacecategory modules.
   Field names mirror the production model: floorlevel, polygon, spaceCategory, spaceCategoryId,
   isOccupied, recordId, markerModuleName, assetCategoryId. Swap makeEstateData() for
   vibe.executeAction reads; prism() takes GeoJSON coordinate rings as V3IndoorFloorPlanGeoJsonContext stores them. */
(function () {
  'use strict';

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var rnd = mulberry32(20260805);
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }
  function rr(a, b) { return a + rnd() * (b - a); }
  var _id = 9000;
  function rid() { return ++_id; }
  var DAY = 86400000;

  function tax() {
    var A = window.FACILIO_ASSET_CATEGORIES || [], S = window.FACILIO_SPACE_CATEGORIES || [];
    return { assets: A, spaces: S, trades: window.FACILIO_TRADES || {} };
  }
  // demo asset mix — real category records, weighted to the ones an office estate actually holds
  var DEMO_ASSET_CATS = ['AHU', 'FCU', 'FCU', 'Chiller', 'Cooling Tower', 'ventilationfans', 'Primary Pump',
    'mainswitchboard', 'lvelectrical', 'lightingcontrol', 'generalpower',
    'fireindicatorpanel', 'extinguishers', 'firesafetyequipment', 'electricpump',
    'hydraulic', 'hotwater', 'pump', 'gas',
    'lifts', 'cctv', 'accesscontrol', 'intercom',
    'Energy Meter', 'Water Meter', 'Devices', 'whitegoods', 'furniture'];
  var DEMO_SPACE_CATS = ['Admin', 'Shared', 'Public', 'Tenancy', 'CBL_Admin', 'HWK_Admin'];

  var WO_BY_TRADE = {
    'HVAC': ['FCU rattling above ceiling', 'Meeting room too warm', 'AHU tripping on high pressure', 'Condensate leak from FCU', 'No airflow at diffusers', 'Chiller short-cycling'],
    'Electrical': ['Corridor lights flickering', 'Socket circuit dead', 'Emergency light fault', 'Main board breaker tripping'],
    'Fire Safety': ['Detector head in fault', 'Sprinkler head weeping', 'Panel zone isolated', 'Extinguisher overdue for test'],
    'Plumbing & Hydraulic': ['Leak under pantry sink', 'Low water pressure in washroom', 'Booster pump cycling', 'Hot water not reaching L09'],
    'Vertical Transport': ['Lift door sensor sticking', 'Lift stopping out of level', 'Ride quality complaint'],
    'Security & Communications': ['Camera offline', 'Reader not accepting fobs', 'Intercom no audio'],
    'Metering & Energy': ['Meter not reporting', 'Pulse output drifting'],
    'Controls & Devices': ['Sensor reading out of range', 'Controller offline'],
    'Appliances & White Goods': ['Fridge not holding temperature', 'Dishwasher not draining'],
    'Furniture & Fixtures': ['Desk height adjust jammed', 'Door closer out of adjustment'],
    'Plant & Equipment': ['Unit vibrating on start', 'Guard panel loose']
  };
  var INSPECTIONS = {
    'HVAC': ['Monthly AHU walkdown', 'Quarterly filter and belt check', 'Annual chiller log review'],
    'Electrical': ['Monthly switchboard thermography', 'Emergency lighting 90-min discharge'],
    'Fire Safety': ['Monthly fire panel test', 'Six-monthly extinguisher inspection', 'Annual ESM audit'],
    'Plumbing & Hydraulic': ['Quarterly backflow check', 'Monthly pump room inspection'],
    'Vertical Transport': ['Monthly lift service log', 'Annual statutory inspection'],
    'Security & Communications': ['Monthly camera health check', 'Quarterly reader audit'],
    'Metering & Energy': ['Monthly meter read verification'],
    'Controls & Devices': ['Quarterly sensor calibration'],
    'Appliances & White Goods': ['Annual appliance safety check'],
    'Furniture & Fixtures': ['Annual condition survey'],
    'Plant & Equipment': ['Quarterly plant inspection']
  };
  var TECHS = ['Priya K.', 'Dan Osei', 'Marta Ruiz', 'Sam Whitfield', 'Ken Adachi', 'Rosa Lim'];

  var TAX_ALIAS = {
    'AHU': 'ahu', 'FAHU': 'fahu', 'FCU': 'fcu', 'Chiller': 'chiller', 'Cooling Tower': 'cooling-tower',
    'Heat Pump': 'heat-pump', 'Chiller Plant Manager': 'chiller-plant-manager',
    'Primary Pump': 'primary-pump', 'Secondary Pump': 'secondary-pump', 'Condenser Pump': 'condenser-pump',
    'Energy Meter': 'energy-meter', 'Utility Meter': 'utility-meter', 'Water Meter': 'water-meter',
    'Devices': 'devices', 'Refrigeration': 'refrigeration',
    'ventilationfans': 'ahu', 'electricpump': 'condenser-pump', 'pump': 'primary-pump',
    'hotwater': 'heat-pump', 'gas': 'utility-meter', 'hydraulic': 'water-meter',
    'mainswitchboard': 'system-controller', 'lvelectrical': 'controller', 'lightingcontrol': 'controller',
    'generalpower': 'misc-controller', 'fireindicatorpanel': 'system-controller',
    'firesafetyequipment': 'devices', 'extinguishers': 'devices', 'cctv': 'devices',
    'accesscontrol': 'rdm-controller', 'intercom': 'devices', 'lifts': 'refrigeration',
    'Water Meter ': 'water-meter', 'whitegoods': 'refrigeration', 'furniture': 'devices'
  };
  var TRADE_TAX = { 'HVAC': 'ahu', 'Metering & Energy': 'energy-meter', 'Controls & Devices': 'controller',
    'Electrical': 'system-controller', 'Fire Safety': 'system-controller', 'Plumbing & Hydraulic': 'water-meter',
    'Vertical Transport': 'refrigeration', 'Security & Communications': 'devices',
    'Appliances & White Goods': 'refrigeration', 'Furniture & Fixtures': 'devices', 'Plant & Equipment': 'primary-pump' };
  function taxNodeFor(cat) {
    var TX = window.AssetTaxonomy; if (!TX) return null;
    var id = TAX_ALIAS[cat.name] || TX.slugify(cat.name);
    return TX.BY_ID[id] || TX.BY_ID[TRADE_TAX[cat.trade] || 'devices'] || null;
  }
  var PLANT_TAX = { chiller: 1, 'cooling-tower': 1, ahu: 1, fahu: 1, 'heat-pump': 1, 'primary-pump': 1,
    'secondary-pump': 1, 'condenser-pump': 1, 'chiller-plant-manager': 1, refrigeration: 1 };

  function catByName(list, n) { for (var i = 0; i < list.length; i++) if (list[i].name === n) return list[i]; return null; }

  function makeWorkOrder(floor, opts) {
    opts = opts || {};
    var trade = opts.trade || 'HVAC';
    var prio = opts.priority || (rnd() < 0.12 ? 1 : rnd() < 0.35 ? 2 : rnd() < 0.75 ? 3 : 4);
    return {
      recordId: rid(), markerModuleName: 'workorder',
      subject: opts.subject || pick(WO_BY_TRADE[trade] || WO_BY_TRADE.HVAC),
      trade: trade, priority: prio,
      status: opts.status || (rnd() < 0.22 ? 'overdue' : 'open'),
      assignedTo: opts.assignedTo || pick(TECHS),
      assetId: opts.assetId || null, assetName: opts.assetName || null,
      color: opts.color || '#1673F6',
      tenantId: floor.tenantId, tenantName: floor.tenantName,
      raisedAt: opts.raisedAt || (Date.now() - Math.floor(rr(4, 240)) * 60000),
      x: opts.x != null ? opts.x : rr(-floor._w / 2 + 2, floor._w / 2 - 2),
      z: opts.z != null ? opts.z : rr(-floor._d / 2 + 2, floor._d / 2 - 2)
    };
  }

  function makeAsset(floor, cat, idx, space) {
    var last = Date.now() - Math.floor(rr(5, 320)) * DAY;
    var every = pick([90, 90, 180, 365]);
    var next = last + every * DAY;
    var overdue = next < Date.now();
    var cond = overdue ? pick(['fair', 'poor']) : rnd() < 0.12 ? 'fair' : 'good';
    var status = cond === 'poor' ? 'critical' : overdue ? 'overdue' : 'healthy';
    var node = taxNodeFor(cat);
    var code = (node ? node.name : cat.name).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) +
      '-' + floor.name.replace('L', '') + '-' + String.fromCharCode(65 + (idx % 26));
    var a = {
      recordId: rid(), markerModuleName: 'asset',
      assetCategoryId: cat.id, category: cat.name, trade: cat.trade, color: cat.color,
      taxonomyId: node ? node.id : null, taxonomyName: node ? node.name : cat.name,
      taxonomyType: node ? node.type : null,
      taxonomyPath: node && window.AssetTaxonomy ? window.AssetTaxonomy.hierarchyPath(node.id) : cat.name,
      modelLabel: node && window.PlantRoomModels ? window.PlantRoomModels.labelFor(node) : 'Equipment',
      code: code, isPlant: node ? !!PLANT_TAX[node.id] : false,
      name: code,
      serial: 'FA' + Math.floor(rr(100000, 999999)),
      manufacturer: pick(['Daikin', 'Trane', 'Schneider', 'Grundfos', 'Honeywell', 'Siemens', 'Kone']),
      installedOn: Date.now() - Math.floor(rr(400, 3600)) * DAY,
      lastServicedOn: last, nextServiceDue: next, serviceEveryDays: every,
      condition: cond, status: status,
      criticality: cond === 'poor' ? 'High' : pick(['Medium', 'Medium', 'Low']),
      runHours: Math.floor(rr(1200, 42000)),
      spaceId: space ? space.recordId : null, spaceName: space ? space.name : '—',
      tenantId: floor.tenantId, tenantName: floor.tenantName,
      x: space ? (space.polygon[0][0] + space.polygon[2][0]) / 2 + rr(-1, 1) : rr(-floor._w / 2 + 2, floor._w / 2 - 2),
      z: space ? (space.polygon[0][1] + space.polygon[2][1]) / 2 + rr(-1, 1) : rr(-floor._d / 2 + 2, floor._d / 2 - 2),
      inspections: [], workOrders: []
    };
    var insp = INSPECTIONS[cat.trade] || INSPECTIONS.HVAC;
    for (var i = 0; i < 1 + Math.floor(rnd() * 2); i++) {
      var due = Date.now() + Math.floor(rr(-14, 40)) * DAY;
      a.inspections.push({
        recordId: rid(), name: insp[i % insp.length],
        frequency: pick(['Monthly', 'Quarterly', 'Six-monthly', 'Annual']),
        dueOn: due, status: due < Date.now() ? 'overdue' : 'scheduled',
        lastResult: pick(['Pass', 'Pass', 'Pass with notes', 'Fail']),
        assignedTo: pick(TECHS)
      });
    }
    return a;
  }

  function makeFloor(b, level, tenantId, tenantName, spaceCats, assetCats) {
    var w = b.w, d = b.d, m = 1.4, corr = 3.2;
    var floor = { recordId: rid(), name: 'L' + (level < 10 ? '0' + level : level), floorlevel: level, tenantId: tenantId, tenantName: tenantName, _w: w, _d: d, spaces: [], markers: [] };
    [[-d / 2 + m, -corr / 2], [corr / 2, d / 2 - m]].forEach(function (zone) {
      var n = 3 + Math.floor(rnd() * 2), x0 = -w / 2 + m, span = w - 2 * m, acc = 0, cuts = [];
      for (var i = 0; i < n; i++) cuts.push(rr(0.7, 1.4));
      var tot = cuts.reduce(function (a, c) { return a + c; }, 0);
      cuts.forEach(function (c) {
        var x1 = x0 + acc / tot * span, x2 = x0 + (acc + c) / tot * span; acc += c;
        var sc = pick(spaceCats);
        floor.spaces.push({
          recordId: rid(), name: sc.name + ' ' + floor.name + '-' + (floor.spaces.length + 1),
          spaceCategory: sc.name, spaceCategoryId: sc.id, spaceGroup: sc.group, categoryColor: sc.color,
          isOccupied: rnd() < 0.7, utilization: rnd(), area: Math.round(rr(18, 120)),
          polygon: [[x1 + 0.15, zone[0] + 0.15], [x2 - 0.15, zone[0] + 0.15], [x2 - 0.15, zone[1] - 0.15], [x1 + 0.15, zone[1] - 0.15]]
        });
      });
    });
    var byArea = floor.spaces.slice().sort(function (p, q) {
      return Math.abs((q.polygon[2][0] - q.polygon[0][0]) * (q.polygon[2][1] - q.polygon[0][1])) -
             Math.abs((p.polygon[2][0] - p.polygon[0][0]) * (p.polygon[2][1] - p.polygon[0][1]));
    });
    var plantRoom = byArea[0];
    plantRoom.isPlantRoom = true;
    var rooms = byArea.slice(1);
    var plantSlots = 0, roomSlot = 0, panelSlot = 0;
    function placeAsset(a) {
      if (a.isPlant) {
        // rank the plant room floor into a service row, 4 m apart
        var pw = Math.abs(plantRoom.polygon[2][0] - plantRoom.polygon[0][0]);
        var cols = Math.max(1, Math.floor(pw / 4.2));
        var cx = (plantRoom.polygon[0][0] + plantRoom.polygon[2][0]) / 2;
        var cz = (plantRoom.polygon[0][1] + plantRoom.polygon[2][1]) / 2;
        var col = plantSlots % cols, row = Math.floor(plantSlots / cols);
        a.x = cx + (col - (cols - 1) / 2) * 4.2;
        a.z = cz + (row - 0.5) * 3.4;
        a.spaceId = plantRoom.recordId; a.spaceName = plantRoom.name;
        a.placement = 'Plant room'; a.rotationY = 0;
        plantSlots++;
        return;
      }
      if (a.taxonomyType === 'CONTROLLER' || a.taxonomyType === 'ENERGY') {
        // panels and meters live on the corridor wall, facing in
        var side = panelSlot % 2 ? 1 : -1;
        a.x = -floor._w / 2 + 3.5 + Math.floor(panelSlot / 2) * 3.6;
        a.z = side * 1.15;
        a.rotationY = side > 0 ? Math.PI : 0;
        a.spaceId = null; a.spaceName = 'Corridor';
        a.placement = 'Corridor wall';
        panelSlot++;
        return;
      }
      var sp = rooms.length ? rooms[roomSlot % rooms.length] : plantRoom;
      roomSlot++;
      a.x = (sp.polygon[0][0] + sp.polygon[2][0]) / 2 + rr(-0.7, 0.7);
      a.z = (sp.polygon[0][1] + sp.polygon[2][1]) / 2 + rr(-0.5, 0.5);
      a.spaceId = sp.recordId; a.spaceName = sp.name;
      a.placement = sp.spaceCategory;
      a.rotationY = 0;
    }
    var na = 4 + Math.floor(rnd() * 3);
    var order = [];
    for (var q = 0; q < na; q++) order.push(pick(assetCats));
    order.sort(function (p1, p2) {
      var n1 = taxNodeFor(p1), n2 = taxNodeFor(p2);
      return (n2 && PLANT_TAX[n2.id] ? 1 : 0) - (n1 && PLANT_TAX[n1.id] ? 1 : 0);
    });
    for (var i = 0; i < na; i++) {
      var a = makeAsset(floor, order[i], i, null);
      placeAsset(a);
      floor.markers.push(a);
      if (a.status !== 'healthy' && rnd() < 0.55) {
        var wo = makeWorkOrder(floor, {
          trade: a.trade, assetId: a.recordId, assetName: a.name, color: a.color,
          priority: a.status === 'critical' ? 1 : 2, status: a.status === 'critical' ? 'overdue' : 'open',
          x: a.x + rr(-0.8, 0.8), z: a.z + rr(-0.8, 0.8)
        });
        floor.markers.push(wo); a.workOrders.push(wo.recordId);
      }
    }
    return floor;
  }

  window.makeEstateData = function () {
    var t = tax();
    var spaceCats = DEMO_SPACE_CATS.map(function (n) { return catByName(t.spaces, n); }).filter(Boolean);
    if (!spaceCats.length) spaceCats = [{ id: '0', name: 'Space', group: 'Tenancy', color: '#8665b3' }];
    var assetCats = DEMO_ASSET_CATS.map(function (n) { return catByName(t.assets, n); }).filter(Boolean);
    if (!assetCats.length) assetCats = [{ id: '0', name: 'Asset', trade: 'HVAC', color: '#276591' }];

    var buildings = [
      { id: 'towerA', name: 'Tower A', x: -30, z: -6, w: 34, d: 26, nF: 12 },
      { id: 'towerB', name: 'Tower B', x: 20, z: -24, w: 30, d: 24, nF: 8 },
      { id: 'annex', name: 'Annex', x: 16, z: 24, w: 26, d: 20, nF: 4 }
    ];
    var tenancy = {
      towerA: function (l) { return l <= 2 ? ['retail', 'Atrium retail'] : l <= 4 ? ['northbridge', 'Northbridge Capital'] : l <= 9 ? ['meridian', 'Meridian Legal'] : ['helio', 'Helio Systems']; },
      towerB: function (l) { return l <= 4 ? ['vantage', 'Vantage Media'] : ['osier', 'Osier & Co']; },
      annex: function () { return ['estate', 'Estate services']; }
    };
    buildings.forEach(function (b) {
      b.floors = [];
      for (var l = 1; l <= b.nF; l++) {
        var tn = tenancy[b.id](l);
        b.floors.push(makeFloor(b, l, tn[0], tn[1], spaceCats, assetCats));
      }
    });
    var A = buildings[0];
    A.floors[6].markers.push(makeWorkOrder(A.floors[6], { trade: 'HVAC', priority: 1, status: 'overdue', subject: 'Chiller feed to L07 tripping on high head pressure', raisedAt: Date.now() - 52 * 60000, color: '#296a99' }));
    A.floors[4].markers.push(makeWorkOrder(A.floors[4], { trade: 'Electrical', priority: 3, subject: 'Reception downlights flickering', color: '#917627' }));
    A.floors[8].markers.push(makeWorkOrder(A.floors[8], { trade: 'Plumbing & Hydraulic', priority: 2, subject: 'Leak under pantry sink, L09 north', color: '#277f91' }));
    return { name: 'Northgate Estate', buildings: buildings };
  };
  window.makeEstateWorkOrder = function (floor, opts) {
    opts = opts || {};
    var t = tax();
    var cat = catByName(t.assets, pick(DEMO_ASSET_CATS)) || { trade: 'HVAC', color: '#276591' };
    opts.trade = opts.trade || cat.trade; opts.color = opts.color || cat.color;
    return makeWorkOrder(floor, opts);
  };

  // ---------- engine ----------
  var FLOOR_H = 3.2, GAP = 5.4;
  function damp(c, g, dt, l) { return c + (g - c) * (1 - Math.exp(-dt * l)); }
  function hexInt(h) { return parseInt(String(h || '#8899aa').replace('#', ''), 16); }

  function pinCanvas(fill, ring, glyph) {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d');
    g.beginPath(); g.arc(64, 64, 50, 0, 6.29); g.fillStyle = fill; g.fill();
    g.lineWidth = 11; g.strokeStyle = ring; g.stroke();
    g.fillStyle = '#FFFFFF';
    if (glyph === 'bang') { g.fillRect(58, 34, 12, 38); g.beginPath(); g.arc(64, 90, 8, 0, 6.29); g.fill(); }
    else if (glyph === 'square') { g.fillRect(50, 50, 28, 28); }
    else { g.beginPath(); g.arc(64, 64, 13, 0, 6.29); g.fill(); }
    return c;
  }

  // ---------- 3D asset models, one silhouette per trade/category ----------
  function buildAssetModel(T, m) {
    var g = new T.Group();
    var body = new T.Color(hexInt(m.color));
    var matBody = new T.MeshLambertMaterial({ color: body });
    var matDark = new T.MeshLambertMaterial({ color: body.clone().multiplyScalar(0.72) });
    var matMetal = new T.MeshLambertMaterial({ color: 0xC9D4E2 });
    var matTrim = new T.MeshLambertMaterial({ color: 0xF2F6FB });
    function box(w, h, d, x, y, z, mat) { var b = new T.Mesh(new T.BoxGeometry(w, h, d), mat || matBody); b.position.set(x, y, z); g.add(b); return b; }
    function cyl(r, h, x, y, z, mat, rot) { var c = new T.Mesh(new T.CylinderGeometry(r, r, h, 16), mat || matBody); c.position.set(x, y, z); if (rot) c.rotation.z = Math.PI / 2; g.add(c); return c; }
    var c = (m.category || '').toLowerCase(), tr = m.trade;
    if (c === 'ahu' || c === 'fahu' || c === 'hvac' || c === 'filters') {
      box(2.6, 1.5, 1.5, 0, 0.75, 0);
      box(0.12, 1.1, 1.1, 1.32, 0.8, 0, matTrim);
      cyl(0.22, 0.9, -1.1, 1.9, 0, matMetal); box(0.9, 0.12, 0.9, -1.1, 2.4, 0, matDark);
    } else if (c === 'chiller' || c === 'refrigeration' || c === 'heat pump') {
      box(3, 1.3, 1.6, 0, 0.65, 0);
      box(3.1, 0.18, 1.7, 0, 1.42, 0, matDark);
      cyl(0.45, 0.25, -0.8, 1.66, 0, matMetal); cyl(0.45, 0.25, 0.8, 1.66, 0, matMetal);
    } else if (c === 'cooling tower') {
      box(2, 1.2, 2, 0, 0.6, 0);
      cyl(0.85, 0.7, 0, 1.55, 0, matDark);
      cyl(0.9, 0.1, 0, 1.95, 0, matMetal);
    } else if (c === 'fcu') {
      box(1.7, 0.55, 1, 0, 0.3, 0);
      box(1.5, 0.1, 0.2, 0, 0.02, 0.3, matTrim);
    } else if (c.indexOf('pump') >= 0) {
      box(1.3, 0.35, 0.9, 0, 0.18, 0, matDark);
      cyl(0.42, 1.1, 0, 0.75, 0, matBody, true);
      cyl(0.2, 0.5, 0.75, 0.75, 0, matMetal, true);
    } else if (c === 'mainswitchboard' || c === 'lvelectrical' || c === 'generalpower' || c === 'lightingcontrol' || c === 'electricalwaterheater') {
      box(1.5, 2.1, 0.6, 0, 1.05, 0);
      box(1.2, 0.5, 0.06, 0, 1.55, 0.33, matTrim);
      box(1.2, 0.9, 0.06, 0, 0.75, 0.33, matDark);
    } else if (tr === 'Fire Safety') {
      if (c === 'extinguishers') { cyl(0.3, 1.1, 0, 0.55, 0); cyl(0.09, 0.35, 0, 1.25, 0, matDark); }
      else { box(1.1, 1.5, 0.35, 0, 0.75, 0); box(0.8, 0.45, 0.06, 0, 1.05, 0.2, matTrim); }
    } else if (c === 'lifts') {
      box(1.8, 2.6, 1.8, 0, 1.3, 0);
      box(0.9, 2, 0.06, 0, 1, 0.92, matTrim);
      box(0.06, 2, 0.06, 0, 1, 0.96, matDark);
    } else if (c === 'cctv') {
      cyl(0.1, 1.4, 0, 0.7, 0, matMetal);
      box(0.7, 0.35, 0.35, 0.2, 1.5, 0);
      var lens = new T.Mesh(new T.SphereGeometry(0.17, 12, 12), matDark); lens.position.set(0.6, 1.5, 0); g.add(lens);
    } else if (c === 'accesscontrol' || c === 'intercom' || c === 'devices') {
      cyl(0.08, 1.2, 0, 0.6, 0, matMetal);
      box(0.5, 0.75, 0.18, 0, 1.5, 0);
    } else if (tr === 'Metering & Energy') {
      box(0.85, 1.1, 0.4, 0, 0.55, 0);
      box(0.55, 0.4, 0.06, 0, 0.72, 0.22, matTrim);
    } else if (tr === 'Plumbing & Hydraulic') {
      cyl(0.55, 1.9, 0, 0.95, 0);
      cyl(0.6, 0.16, 0, 1.95, 0, matDark);
      cyl(0.12, 0.9, 0.75, 1.5, 0, matMetal, true);
    } else if (tr === 'Appliances & White Goods') {
      box(1, 1.7, 0.9, 0, 0.85, 0);
      box(0.06, 1.5, 0.8, 0.52, 0.9, 0, matTrim);
    } else if (tr === 'Furniture & Fixtures') {
      box(1.8, 0.12, 1, 0, 0.75, 0);
      box(0.1, 0.75, 0.1, -0.8, 0.38, -0.4, matDark); box(0.1, 0.75, 0.1, 0.8, 0.38, -0.4, matDark);
      box(0.1, 0.75, 0.1, -0.8, 0.38, 0.4, matDark); box(0.1, 0.75, 0.1, 0.8, 0.38, 0.4, matDark);
    } else {
      box(1.4, 1.4, 1.1, 0, 0.7, 0);
      box(1.5, 0.14, 1.2, 0, 1.45, 0, matDark);
    }
    g.traverse(function (o) { if (o.isMesh) o.userData.marker = m; });
    var edges = new T.Group();
    g.children.slice().forEach(function (mesh) {
      if (!mesh.isMesh) return;
      var e = new T.LineSegments(new T.EdgesGeometry(mesh.geometry), new T.LineBasicMaterial({ color: 0x2C3A4D, transparent: true, opacity: 0.35 }));
      e.position.copy(mesh.position); e.rotation.copy(mesh.rotation); edges.add(e);
    });
    g.add(edges);
    edges.traverse(function (o) { o.userData.marker = m; o.raycast = function () {}; });
    return g;
  }

  function buildWoModel(T, m) {
    var urgent = m.status === 'critical' || m.priority === 1;
    var warn = m.status === 'overdue' || m.priority === 2;
    var col = urgent ? PALETTE.critical : warn ? PALETTE.warning : hexInt(m.color || '#1673F6');
    var g = new T.Group();
    var mat = new T.MeshLambertMaterial({ color: col });
    var head = new T.Mesh(new T.SphereGeometry(0.62, 16, 14), mat);
    head.position.y = 0.62; g.add(head);
    var tip = new T.Mesh(new T.ConeGeometry(0.42, 0.9, 16), mat);
    tip.position.y = -0.1; tip.rotation.x = Math.PI; g.add(tip);
    var band = new T.Mesh(new T.TorusGeometry(0.64, 0.09, 8, 20), new T.MeshLambertMaterial({ color: 0xFFFFFF }));
    band.position.y = 0.62; band.rotation.x = Math.PI / 2; g.add(band);
    g.userData.mats = [mat];
    g.traverse(function (o) { if (o.isMesh) o.userData.marker = m; });
    return g;
  }

  window.EstateEngine = function (canvas, data, cb) {
    var T = window.THREE;
    var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    var scene = new T.Scene();
    scene.background = new T.Color(0xE9EEF6);
    scene.fog = new T.Fog(0xE9EEF6, 260, 560);
    scene.add(new T.HemisphereLight(0xFFFFFF, 0xD8E3F1, 0.95));
    var sun = new T.DirectionalLight(0xFFFFFF, 0.55); sun.position.set(70, 120, 40); scene.add(sun);
    var camera = new T.PerspectiveCamera(45, 1, 0.1, 1200);
    var ground = new T.Mesh(new T.CircleGeometry(320, 64), new T.MeshLambertMaterial({ color: 0xDDE5F0 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    var grid = new T.GridHelper(420, 42, 0xDCE4EF, 0xE7EDF6); grid.position.y = 0.02; scene.add(grid);
    (function site() {
      // landscaping placed around the ACTUAL estate, not at the demo layout's hardcoded spots —
      // with real buildings those old positions landed anywhere, including inside plates
      var bMin = { x: Infinity, z: Infinity }, bMax = { x: -Infinity, z: -Infinity };
      data.buildings.forEach(function (b) {
        bMin.x = Math.min(bMin.x, b.x - b.w / 2); bMax.x = Math.max(bMax.x, b.x + b.w / 2);
        bMin.z = Math.min(bMin.z, b.z - b.d / 2); bMax.z = Math.max(bMax.z, b.z + b.d / 2);
      });
      if (!isFinite(bMin.x)) { bMin = { x: -40, z: -30 }; bMax = { x: 40, z: 30 }; }
      var srnd = mulberry32(7);
      var siteG = new T.Group(); scene.add(siteG); scene.userData.siteG = siteG;
      var trunkGeo = new T.CylinderGeometry(0.28, 0.34, 2.2, 7);
      var trunkMat = new T.MeshLambertMaterial({ color: 0xC3CBD8 });
      var leafMats = [new T.MeshLambertMaterial({ color: 0xAFC9B8 }), new T.MeshLambertMaterial({ color: 0x9FBFAD }), new T.MeshLambertMaterial({ color: 0xBCD4C4 })];
      var leafGeo = new T.ConeGeometry(2.1, 4.6, 9);
      function insideAnyBuilding(x, z, pad) {
        return data.buildings.some(function (b) {
          return Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad;
        });
      }
      function tree(x, z, sc) {
        var g = new T.Group();
        var tr = new T.Mesh(trunkGeo, trunkMat); tr.position.y = 1.1; g.add(tr);
        for (var k = 0; k < 3; k++) {
          var c = new T.Mesh(leafGeo, leafMats[k % 3]);
          c.position.y = 3.2 + k * 1.5; c.scale.setScalar(1 - k * 0.22); g.add(c);
        }
        g.position.set(x, 0, z); g.scale.setScalar(sc);
        g.traverse(function (o) { o.raycast = function () {}; });
        siteG.add(g);
      }
      // a loose ring just outside the estate bounds
      var cx = (bMin.x + bMax.x) / 2, cz = (bMin.z + bMax.z) / 2;
      var rx = (bMax.x - bMin.x) / 2 + 14, rz = (bMax.z - bMin.z) / 2 + 12;
      for (var ti = 0; ti < 16; ti++) {
        var ang = (ti / 16) * Math.PI * 2 + srnd() * 0.3;
        var x = cx + Math.cos(ang) * (rx + srnd() * 8);
        var z = cz + Math.sin(ang) * (rz + srnd() * 8);
        if (insideAnyBuilding(x, z, 6)) continue;
        tree(x, z, 0.75 + srnd() * 0.45);
      }
      // one plaza strip through the gap between site rows, when there is one
      if (bMax.z - bMin.z > 45) {
        var plazaMat = new T.MeshLambertMaterial({ color: 0xEDF2F9 });
        var road = new T.Mesh(new T.BoxGeometry(bMax.x - bMin.x + 44, 0.06, 8), plazaMat);
        road.position.set(cx, 0.04, cz); road.raycast = function () {}; siteG.add(road);
      }
    })();

    var cam = { theta: 0.7, phi: 1.02, radius: 150, target: new T.Vector3(0, 6, 0) };
    var goal = { theta: 0.7, phi: 1.02, radius: 150, target: new T.Vector3(0, 6, 0) };
    var lastTouch = Date.now(), level = 0, activeB = null, activeF = null;
    // PATCH (facilio-vision-3d): flyToFloor/flyToMarker sequence their hops with
    // setTimeout. Those handles were untracked, so they survived dispose() and fired
    // cb.onLevel into an unmounted component. Collect them and clear them on teardown.
    var flights = [];
    function later(fn, ms) { var h = setTimeout(fn, ms); flights.push(h); return h; }
    var selectedId = null, focusId = null, focusSpaceId = null, focusT = null, searchQ = '', layers = { assets: true, workorders: true, occupancy: false }, editMode = false;
    var scope = { canSeeFloor: function () { return true; }, canSeeMarker: function () { return true; }, showSpaces: true };

    function prism(ring, h, mat) {
      var shape = new T.Shape();
      ring.forEach(function (p, i) { if (i === 0) shape.moveTo(p[0], -p[1]); else shape.lineTo(p[0], -p[1]); });
      var geo = new T.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      return new T.Mesh(geo, mat);
    }
    /* ---- real CAD floor plans (see tools/extract-plan.mjs) ------------------------------ */
    function mergeGeos(list) {
      var total = 0;
      list.forEach(function (g) { total += g.attributes.position.count; });
      var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), o = 0;
      list.forEach(function (g) {
        pos.set(g.attributes.position.array, o * 3);
        if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
        o += g.attributes.position.count;
        g.dispose();
      });
      var out = new T.BufferGeometry();
      out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
      return out;
    }
    // a room recovered from a plan is a set of rectangles, not one ring — merge them into one
    // mesh so picking and status colouring keep working exactly as they do for a synthesised room
    function multiPrism(rects, h, mat) {
      var geos = [];
      rects.forEach(function (r) {
        var shape = new T.Shape();
        shape.moveTo(r[0], -r[1]); shape.lineTo(r[2], -r[1]);
        shape.lineTo(r[2], -r[3]); shape.lineTo(r[0], -r[3]);
        var g = new T.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        geos.push(g.index ? g.toNonIndexed() : g);   // ExtrudeGeometry is already non-indexed
      });
      return new T.Mesh(mergeGeos(geos), mat);
    }
    /* CAD floors follow the floorplan-manager reference: the drawing is line work, layered by
       role, with walls emphasised. Everything sits ABOVE the room pads (pad top = 0.29) so the
       plan is never buried, and every object carries userData.baseOp so the floor's fade-in
       animation scales — rather than overwrites — its opacity. A low translucent wall volume
       keeps the 3D read without turning the plan into a maze of grey boxes. */
    var PLAN_STYLE = {
      furniture: { color: 0x7E90AC, op: 0.5, y: 0.42 },
      stairs:    { color: 0x8FA2BE, op: 0.7, y: 0.44 },
      glazing:   { color: 0x63B0DC, op: 0.85, y: 0.46 },
      doors:     { color: 0xC98A4B, op: 0.8, y: 0.46 },
      walls:     { color: 0xE8F0FC, op: 0.95, y: 0.5 }
    };
    var PLAN_WALL_H = 0.85;
    function buildPlan(plan, parent) {
      var g = new T.Group();
      // soft wall volume
      var geos = [];
      (plan.layers.walls || []).forEach(function (poly) {
        for (var k = 1; k < poly.length; k++) {
          var x0 = poly[k - 1][0], z0 = poly[k - 1][1], x1 = poly[k][0], z1 = poly[k][1];
          var dx = x1 - x0, dz = z1 - z0, len = Math.sqrt(dx * dx + dz * dz);
          if (len < 0.02) continue;
          var bg = new T.BoxGeometry(len, PLAN_WALL_H, 0.09);
          bg.applyMatrix4(new T.Matrix4().makeRotationY(Math.atan2(-dz, dx)));
          bg.translate((x0 + x1) / 2, PLAN_WALL_H / 2 + 0.24, (z0 + z1) / 2);
          geos.push(bg.index ? bg.toNonIndexed() : bg);
        }
      });
      if (geos.length) {
        var wm = new T.Mesh(mergeGeos(geos),
          new T.MeshLambertMaterial({ color: 0xAdBcd6, transparent: true, opacity: 0.4, depthWrite: false }));
        wm.userData.baseOp = 0.4;
        wm.raycast = function () {};
        g.add(wm);
      }
      Object.keys(PLAN_STYLE).forEach(function (role) {
        var st = PLAN_STYLE[role], pts = [];
        (plan.layers[role] || []).forEach(function (poly) {
          for (var k = 1; k < poly.length; k++) {
            pts.push(poly[k - 1][0], st.y, poly[k - 1][1], poly[k][0], st.y, poly[k][1]);
          }
        });
        if (!pts.length) return;
        var lg = new T.BufferGeometry();
        lg.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(pts), 3));
        var ls = new T.LineSegments(lg,
          new T.LineBasicMaterial({ color: st.color, transparent: true, opacity: st.op }));
        ls.userData.baseOp = st.op;
        ls.raycast = function () {};
        g.add(ls);
      });
      parent.add(g);
      return g;
    }

    function labelSprite(text, scale) {
      var c = document.createElement('canvas'); c.width = 512; c.height = 128;
      var g = c.getContext('2d'); g.font = '600 58px Roboto, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#384A62'; g.fillText(text, 256, 68);
      var s = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), transparent: true }));
      s.scale.set(scale, scale / 4, 1); return s;
    }

    /* PATCH (facilio-vision-3d): the status ramp, in ONE place. These hexes were repeated
       across nine sites here and again in the 2D UI's own palette; api.setPalette() now
       feeds them from the app's CSS design tokens so the 3D scene and the panels around it
       cannot drift apart. Defaults are the original values, so the engine still stands alone. */
    var PALETTE = { critical: 0xB61919, warning: 0xE5A800, primary: 0x0059D6, closed: 0x9CAFCA, marker: 0x1673F6 };

    var pinTex = {};
    function pinMat(m) {
      var fill = m.color || (m.markerModuleName === 'workorder' ? '#1673F6' : '#607796');
      var urgent = m.status === 'critical' || m.priority === 1;
      var warn = m.status === 'overdue' || m.priority === 2;
      var ring = urgent ? '#B61919' : warn ? '#E5A800' : '#FFFFFF';
      var glyph = m.markerModuleName === 'workorder' ? (urgent || warn ? 'bang' : 'dot') : 'square';
      var key = fill + ring + glyph;
      if (!pinTex[key]) pinTex[key] = new T.CanvasTexture(pinCanvas(fill, ring, glyph));
      return new T.SpriteMaterial({ map: pinTex[key], transparent: true });
    }

    var B = {}, tintOf = window.ESTATE_BUILDING_TINT = Object.assign({
      towerA: { shellA: 0xE4EBFA, shellB: 0xD3E0F7, edge: 0x6E86C9, plinth: 0xCBD8F0, accent: '#4B6BD6' },
      towerB: { shellA: 0xE3EAF5, shellB: 0xD4DFEF, edge: 0x7D92B8, plinth: 0xCEDAEB, accent: '#5B7396' },
      annex: { shellA: 0xE0EAF3, shellB: 0xD0DEEC, edge: 0x6F8CAC, plinth: 0xCAD9E8, accent: '#4A7292' }
    }, window.ESTATE_BUILDING_TINT_EXTRA || {});
    var stemGeo = new T.CylinderGeometry(0.06, 0.06, 1.2, 6);
    var stemMat = new T.MeshBasicMaterial({ color: 0x9CAFCA, transparent: true });

    data.buildings.forEach(function (b) {
      var group = new T.Group(); group.position.set(b.x, 0, b.z); scene.add(group);
      var tint = tintOf[b.id] || tintOf.towerA;
      var plinth = new T.Mesh(new T.BoxGeometry(b.w + 5, 0.3, b.d + 5), new T.MeshLambertMaterial({ color: tint.plinth }));
      plinth.position.y = 0.15; group.add(plinth);
      var label = labelSprite(b.name, 16); label.position.y = b.nF * FLOOR_H + 5; group.add(label);
      var rb = { data: b, group: group, label: label, floors: [] };
      b.floors.forEach(function (f, i) {
        var fg = new T.Group(); fg.position.y = i * FLOOR_H; group.add(fg);
        var shellMat = new T.MeshLambertMaterial({ color: i % 2 ? tint.shellB : tint.shellA, transparent: true, opacity: 0.42, depthWrite: false });
        var shell = new T.Mesh(new T.BoxGeometry(b.w, FLOOR_H * 0.94, b.d), shellMat);
        shell.position.y = FLOOR_H * 0.47; shell.userData = { buildingId: b.id, floorId: f.recordId }; fg.add(shell);
        var edges = new T.LineSegments(new T.EdgesGeometry(shell.geometry), new T.LineBasicMaterial({ color: tint.edge, transparent: true, opacity: 0.85 }));
        edges.position.copy(shell.position); fg.add(edges);
        var slab = new T.Mesh(new T.BoxGeometry(b.w, 0.24, b.d), new T.MeshLambertMaterial({ color: 0x2B3648 }));
        slab.position.y = 0.12; slab.visible = false; fg.add(slab);
        // faint interior mass so stacked floors don't read as empty boxes
        var mass = new T.Group(); fg.add(mass);
        var massMat = new T.MeshLambertMaterial({ color: 0xC7D3E4, transparent: true, opacity: 0.45 });
        for (var mi = 0; mi < 5; mi++) {
          var blk = new T.Mesh(new T.BoxGeometry(b.w * 0.16, 1.1, b.d * 0.22), massMat);
          blk.position.set(-b.w / 2 + b.w * (0.16 + mi * 0.17), 0.75, (mi % 2 ? 1 : -1) * b.d * 0.2);
          blk.raycast = function () {}; mass.add(blk);
        }
        var spacesG = new T.Group(); spacesG.visible = false; fg.add(spacesG);
        f.spaces.forEach(function (sp) {
          var base = new T.Color(hexInt(sp.categoryColor)).lerp(new T.Color(0x3A4658), 0.55);
          var roomG = new T.Group(); spacesG.add(roomG);
          var pad = sp.rects && sp.rects.length
            ? multiPrism(sp.rects, 0.05, new T.MeshLambertMaterial({ color: base }))
            : prism(sp.polygon, 0.12, new T.MeshLambertMaterial({ color: base }));
          pad.position.y = 0.24; pad.userData.space = sp; roomG.add(pad);

          var xs = sp.polygon.map(function (p) { return p[0]; }), zs = sp.polygon.map(function (p) { return p[1]; });
          var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
          var z0 = Math.min.apply(null, zs), z1 = Math.max.apply(null, zs);
          var wsp = x1 - x0, dsp = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
          var WALL = 2.5, wallMat = new T.MeshLambertMaterial({ color: 0x55637A });
          // a real plan brings its own walls and furniture — don't draw the schematic ones over it
          (f.plan ? [] : [[cx, z0, wsp, 0.14], [cx, z1, wsp, 0.14], [x0, cz, 0.14, dsp], [x1, cz, 0.14, dsp]]).forEach(function (w) {
            var wall = new T.Mesh(new T.BoxGeometry(w[2], WALL, w[3]), wallMat);
            wall.position.set(w[0], 0.36 + WALL / 2, w[1]);
            wall.userData.space = sp; wall.userData.kind = 'wall'; wall.userData.baseOp = 1; roomG.add(wall);
            var we = new T.LineSegments(new T.EdgesGeometry(wall.geometry), new T.LineBasicMaterial({ color: 0x8FA2BE, transparent: true, opacity: 0.55 }));
            we.position.copy(wall.position); we.userData.kind = 'walledge'; we.userData.baseOp = 0.55; we.raycast = function () {}; roomG.add(we);
          });

          // furniture, chosen by space category
          var furnMat = new T.MeshLambertMaterial({ color: 0x77869E });
          var furnTop = new T.MeshLambertMaterial({ color: 0x93A3BB });
          function put(geo, mat, px, py, pz, ry) {
            var m2 = new T.Mesh(geo, mat); m2.position.set(px, py, pz);
            if (ry) m2.rotation.y = ry; m2.userData.space = sp; m2.userData.kind = 'furn'; m2.raycast = function () {}; roomG.add(m2);
          }
          var grp = f.plan ? '__plan__' : (sp.spaceGroup || '');
          if (grp === '__plan__') {
            // plan furniture is drawn from the CAD layers instead
          } else if (/Admin|Tenancy/.test(grp)) {
            var cols = Math.max(1, Math.floor(wsp / 2.6)), rws = Math.max(1, Math.floor(dsp / 2.6));
            for (var dx = 0; dx < cols; dx++) for (var dz = 0; dz < rws; dz++) {
              var px = x0 + 1.3 + dx * 2.6, pz = z0 + 1.3 + dz * 2.6;
              if (px > x1 - 0.6 || pz > z1 - 0.6) continue;
              put(new T.BoxGeometry(1.5, 0.1, 0.85), furnTop, px, 1.05, pz);
              put(new T.BoxGeometry(0.08, 0.7, 0.08), furnMat, px - 0.6, 0.7, pz);
              put(new T.BoxGeometry(0.08, 0.7, 0.08), furnMat, px + 0.6, 0.7, pz);
              put(new T.BoxGeometry(0.5, 0.5, 0.5), furnMat, px, 0.6, pz + 0.85);
            }
          } else if (/Shared/.test(grp)) {
            put(new T.BoxGeometry(Math.min(3.4, wsp * 0.55), 0.14, Math.min(1.6, dsp * 0.4)), furnTop, cx, 1.05, cz);
            for (var ci = 0; ci < 6; ci++) {
              var a2 = ci / 6 * 6.283;
              put(new T.BoxGeometry(0.45, 0.85, 0.45), furnMat, cx + Math.cos(a2) * Math.min(2.4, wsp * 0.34), 0.78, cz + Math.sin(a2) * Math.min(1.5, dsp * 0.3));
            }
          } else {
            put(new T.BoxGeometry(Math.min(2.4, wsp * 0.5), 0.9, 0.7), furnMat, cx, 0.8, z0 + 0.9);
            put(new T.BoxGeometry(0.8, 1.5, 0.7), furnMat, x1 - 0.9, 1.1, cz);
          }
          // a small potted plant in the corner, like the reference
          if (!f.plan && Math.min(wsp, dsp) > 3) {
            var potMat = new T.MeshLambertMaterial({ color: 0xC9B79A });
            var leafMat2 = new T.MeshLambertMaterial({ color: 0x8FB99A });
            put(new T.CylinderGeometry(0.16, 0.13, 0.26, 10), potMat, x1 - 0.6, 0.5, z1 - 0.6);
            put(new T.SphereGeometry(0.22, 8, 6), leafMat2, x1 - 0.6, 0.76, z1 - 0.6);
          }

          sp._mesh = pad; sp._base = base.clone(); sp._group = roomG; sp._wallMat = wallMat;
          sp._lift = 0; sp._liftGoal = 0;
          sp._center = { x: sp.centerX != null ? sp.centerX : cx, z: sp.centerZ != null ? sp.centerZ : cz };
        });

        if (f.plan) buildPlan(f.plan, spacesG);
        var markersG = new T.Group(); markersG.visible = false; fg.add(markersG);
        var rf = { data: f, group: fg, shell: shell, shellMat: shellMat, edges: edges, slab: slab, spacesG: spacesG, markersG: markersG, mass: mass, isPlan: !!f.plan, level: i, peel: 0, peelGoal: 0, peelStart: 0, op: 1, opGoal: 1, content: 0, contentGoal: 0, wantSpaces: false, pins: [] };
        f.markers.forEach(function (m) { addPin(rf, m, false); });
        rb.floors.push(rf);
      });
      B[b.id] = rb;
    });

    function haloMat(m) {
      var c = m.status === 'critical' ? PALETTE.critical : m.status === 'overdue' ? PALETTE.warning : hexInt(m.color);
      return new T.MeshBasicMaterial({ color: c, transparent: true, opacity: m.status === 'healthy' ? 0.32 : 0.6, side: T.DoubleSide });
    }
    var haloGeo = new T.RingGeometry(0.95, 1.35, 32);

    function addPin(rf, m, drop) {
      var obj, halo = null, y;
      if (m.markerModuleName === 'asset') {
        if (window.PlantRoomModels && m.taxonomyId && window.AssetTaxonomy && window.AssetTaxonomy.BY_ID[m.taxonomyId]) {
          obj = window.PlantRoomModels.build(T, window.AssetTaxonomy.BY_ID[m.taxonomyId]);
          obj.userData.modelHeight = obj.userData.height || 1.4;
          if (m.rotationY) obj.rotation.y = m.rotationY;
        } else {
          obj = buildAssetModel(T, m);
          obj.userData.modelHeight = 1.6;
        }
        y = 0.26;
        halo = new T.Mesh(haloGeo, haloMat(m));
        halo.rotation.x = -Math.PI / 2; halo.position.set(m.x, 0.3, m.z);
        var hr = Math.max(0.9, (obj.userData.radius || 0.9) + 0.4);
        halo.scale.setScalar(hr);
        rf.markersG.add(halo);
      } else {
        // work orders have no 3D marker of their own; they tint the asset they belong to
        rf.pins.push({ sprite: null, stem: null, m: m, rf: rf, isAsset: false, virtual: true });
        return;
      }
      obj.position.set(m.x, drop ? y + 9 : y, m.z);
      obj.userData.marker = m;
      obj.userData.baseY = y; obj.userData.phase = rnd() * 6.28; obj.userData.dropStart = drop ? Date.now() : 0;
      rf.markersG.add(obj);
      rf.pins.push({ sprite: obj, stem: halo, m: m, rf: rf, isAsset: m.markerModuleName === 'asset' });
      m._pin = obj; m._halo = halo;
    }
    function rootOf() { return null; }
    function markerOf(o) { while (o && !(o.userData && o.userData.marker)) o = o.parent; return o ? o.userData.marker : null; }

    var selRing = new T.Mesh(new T.RingGeometry(1.15, 1.5, 48), new T.MeshBasicMaterial({ color: 0x0059D6, transparent: true, opacity: 0.9, side: T.DoubleSide, depthTest: false }));
    selRing.rotation.x = -Math.PI / 2; selRing.visible = false; selRing.renderOrder = 4; scene.add(selRing);
    var selDisc = new T.Mesh(new T.CircleGeometry(1.5, 48), new T.MeshBasicMaterial({ color: 0x0059D6, transparent: true, opacity: 0.16, side: T.DoubleSide, depthTest: false }));
    selDisc.rotation.x = -Math.PI / 2; selDisc.visible = false; selDisc.renderOrder = 3; scene.add(selDisc);
    var selWave = new T.Mesh(new T.RingGeometry(1.3, 1.48, 48), new T.MeshBasicMaterial({ color: 0x0059D6, transparent: true, opacity: 0.5, side: T.DoubleSide, depthTest: false }));
    selWave.rotation.x = -Math.PI / 2; selWave.visible = false; selWave.renderOrder = 4; scene.add(selWave);
    var selBeam = new T.Mesh(new T.CylinderGeometry(0.9, 1.25, 5.2, 24, 1, true), new T.MeshBasicMaterial({ color: 0x0059D6, transparent: true, opacity: 0.1, side: T.DoubleSide, depthWrite: false, depthTest: false }));
    selBeam.visible = false; selBeam.renderOrder = 2; scene.add(selBeam);
    var selAt = 0, selPop = 0;

    function matches(m) {
      if (!searchQ) return true;
      var t = (m.subject || m.name || '') + ' ' + (m.category || '') + ' ' + m.trade;
      return t.toLowerCase().indexOf(searchQ) >= 0;
    }
    function applyState() {
      Object.keys(B).forEach(function (bid) {
        var rb = B[bid], isActive = bid === activeB, anyFloor = false;
        rb.floors.forEach(function (rf) {
          var seen = scope.canSeeFloor(rb.data, rf.data);
          var floorOpen = level === 2 && isActive && activeF === rf.data.recordId;
          rf.group.visible = seen && (level !== 2 || floorOpen);
          if (seen) anyFloor = true;
          var floorActive = isActive && activeF === rf.data.recordId;
          if (level === 0) rf.opGoal = 1;
          else if (!isActive) rf.opGoal = 0.05;
          else if (level === 1) rf.opGoal = 1;
          else rf.opGoal = floorActive ? 0.03 : 0.045;
          var wantSpaces = floorActive && scope.showSpaces !== false;
          rf.contentGoal = floorActive ? 1 : 0;
          if (floorActive) { rf.slab.visible = true; rf.spacesG.visible = wantSpaces; rf.markersG.visible = true; }
          rf.wantSpaces = wantSpaces;
          if (floorActive) {
            var focusMarker = focusId !== null ? rf.data.markers.find(function (m3) { return m3.recordId === focusId; }) : null;
            rf.pins.forEach(function (p) {
              if (!p.sprite) return;
              var vis = scope.canSeeMarker(p.m) && layers.assets && matches(p.m);
              p.sprite.visible = vis; if (p.stem) p.stem.visible = vis;
              if (focusSpaceId !== null && p.m.spaceId !== focusSpaceId) { p.sprite.visible = false; if (p.stem) p.stem.visible = false; }
              var dim = focusId !== null && p.m.recordId !== focusId &&
                !(focusSpaceId !== null && p.m.spaceId === focusSpaceId);
              p.sprite.traverse(function (o3) {
                if (!o3.material || !o3.isMesh) return;
                o3.material.transparent = true;
                o3.material.opacity = dim ? 0.26 : 1;
              });
              if (p.stem) p.stem.material.opacity = dim ? 0.2 : (p.m.status === 'healthy' ? 0.32 : 0.6);
            });
            rf._focusSpaceId = focusSpaceId !== null ? focusSpaceId : (focusMarker ? focusMarker.spaceId : null);
            rf.data.spaces.forEach(function (sp) {
              if (!sp._mesh) return;
              var crit = false, warn = false;
              rf.data.markers.forEach(function (mm) {
                if (mm.markerModuleName === 'asset' && mm.spaceId === sp.recordId && mm.status === 'critical') crit = true;
                if (mm.markerModuleName !== 'workorder') return;
                var owner = rf.data.markers.find(function (a4) { return a4.recordId === mm.assetId; });
                if (!owner || owner.spaceId !== sp.recordId) return;
                if (mm.priority === 1 || mm.status === 'overdue') crit = true; else warn = true;
              });
              sp._status = selectedId === sp.recordId ? 'selected' : crit ? 'critical' : warn ? 'warning' : 'clear';
              var wash = { critical: PALETTE.critical, warning: 0xFFD405, clear: 0x29A01E, selected: PALETTE.primary }[sp._status];
              sp._statusColor = new T.Color(0x46536A).lerp(new T.Color(wash), sp._status === 'selected' ? 0.5 : 0.3);
              if (layers.occupancy) {
                var u = sp.utilization, g = new T.Color(0x29A01E), a = new T.Color(0xF2C200), r = new T.Color(0xB61919);
                var c = u < 0.5 ? g.clone().lerp(a, u * 2) : a.clone().lerp(r, (u - 0.5) * 2);
                sp._mesh.material.color.copy(c.lerp(new T.Color(0xFFFFFF), 0.42));
              } else sp._mesh.material.color.copy(sp._statusColor);
              var spDim = focusId !== null && rf._focusSpaceId !== sp.recordId;
              sp._mesh.material.transparent = true;
              sp._mesh.material.opacity = spDim ? 0.45 : 1;
              sp._mesh.userData.baseOp = spDim ? 0.45 : 1;
              // v5 focus fix: fade room walls so they never occlude the focused asset/space
              var wFade = focusId !== null, wHome = rf._focusSpaceId === sp.recordId;
              sp._group.traverse(function (o9) {
                if (!o9.userData || !o9.userData.kind) return;
                if (o9.userData.kind === 'wall') o9.userData.baseOp = wFade ? (wHome ? 0.13 : 0.05) : 1;
                else if (o9.userData.kind === 'walledge') o9.userData.baseOp = wFade && !wHome ? 0.16 : 0.55;
                else if (o9.userData.kind === 'furn') o9.userData.baseOp = wFade && !wHome ? 0.18 : 1;
              });
              if (sp._wallMat) sp._wallMat.depthWrite = !wFade;
            });
          }
        });
        rb.group.visible = anyFloor && (level !== 2 || isActive);
        if (scene.userData.siteG) scene.userData.siteG.visible = level < 2;
        rb.label.material.opacity = level === 0 ? 1 : level === 2 ? 0 : isActive ? 0.95 : 0.08;
      });
      if (selectedId === null) selRing.visible = selDisc.visible = selWave.visible = selBeam.visible = false;
    }

    function setPeel(bid, open, now) {
      var rb = B[bid]; if (!rb) return;
      rb.floors.forEach(function (rf, i) { rf.peelGoal = open ? i * (GAP - FLOOR_H) : 0; rf.peelStart = now + i * 55; });
    }
    function camEstate() { goal.target.set(0, 8, 4); goal.radius = 150; goal.phi = 1.02; }
    function camBuilding(rb) {
      var peeled = rb.data.nF * GAP; // full height of the opened stack
      goal.target.set(rb.data.x, peeled * 0.5, rb.data.z);
      // frame the whole stack against the 45° vertical FOV, with margin
      var byH = (peeled / 2) / Math.tan((camera.fov / 2) * Math.PI / 180) * 1.35;
      goal.radius = Math.max(Math.max(rb.data.w, rb.data.d) * 1.35, byH);
      goal.phi = 1.08;
    }
    function camFloor(rb, rf) {
      goal.target.set(rb.data.x, rf.level * FLOOR_H + rf.peelGoal + 1.2, rb.data.z);
      // fit the plate to the viewport at the chosen tilt instead of a blind multiplier;
      // CAD floors read like a drawing, so view them closer to top-down
      var isPlan = !!(rf.data && rf.data.plan);
      var phi = isPlan ? 0.5 : 0.78;
      if (isPlan) {
        // a drawing wants to sit upright on screen — swing to the nearest axis-aligned yaw
        var q = Math.round((goal.theta + Math.PI / 2) / (Math.PI / 2)) * (Math.PI / 2) - Math.PI / 2;
        goal.theta = q;
      }
      var vfov = camera.fov * Math.PI / 180;
      var hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      var spanX = isPlan ? rb.data.w : Math.max(rb.data.w, rb.data.d);
      var spanZ = isPlan ? rb.data.d : Math.max(rb.data.w, rb.data.d);
      var m = 1.14;                                            // headroom for chips + bottom bar
      var R = Math.max(spanX * m / (2 * Math.tan(hfov / 2)),
                       spanZ * m * (Math.cos(phi) + 0.2) / (2 * Math.tan(vfov / 2)));
      goal.radius = Math.max(R, 14);
      goal.phi = phi;
    }
    function notify() { if (cb.onLevel) cb.onLevel({ level: level, buildingId: activeB, floorId: activeF }); }

    var api = {};
    api.enterBuilding = function (bid) {
      var now = Date.now();
      if (activeB && activeB !== bid) setPeel(activeB, false, now);
      activeB = bid; activeF = null; level = 1;
      setPeel(bid, true, now); camBuilding(B[bid]); api.select(null); applyState(); notify();
    };
    api.enterFloor = function (bid, fid) {
      if (activeB !== bid) return api.flyToFloor(bid, fid);
      var prev = activeF;
      activeF = fid; level = 2; focusId = null; focusSpaceId = null;
      selectedId = null; clearTimeout(focusT);
      selRing.visible = selDisc.visible = selWave.visible = selBeam.visible = false;
      if (cb.onSelect) cb.onSelect(null);
      // stagger a re-peel so the stack visibly re-settles around the new floor
      var rbP = B[bid], now2 = Date.now();
      var idx = rbP.floors.findIndex(function (r) { return r.data.recordId === fid; });
      rbP.floors.forEach(function (rf2, i2) {
        var d2 = i2 - idx;
        rf2.peelGoal = d2 * (GAP - FLOOR_H) + (d2 > 0 ? 5.5 : d2 < 0 ? -3.5 : 0);
        rf2.peelStart = now2 + Math.abs(d2) * 55;
      });
      if (prev && prev !== fid) {
        var old = rbP.floors.find(function (r) { return r.data.recordId === prev; });
        if (old) old.contentGoal = 0;
      }
      var rb = B[bid], rf = rb.floors.find(function (r) { return r.data.recordId === fid; });
      if (rf) camFloor(rb, rf);
      applyState(); notify();
    };
    api.flyToFloor = function (bid, fid) {
      if (activeB === bid && level >= 1) return api.enterFloor(bid, fid);
      api.enterBuilding(bid);
      later(function () { api.enterFloor(bid, fid); }, 850);
    };
    api.back = function () {
      if (focusId !== null && focusSpaceId === null) {
        var lf = api.locate(focusId);
        var owner = lf && lf.m.spaceId;
        api.select(null);
        if (owner) { api.select(owner, 'space'); return; }
        return;
      }
      if (focusSpaceId !== null) { api.select(null); return; }
      if (level === 2) { activeF = null; level = 1; api.select(null); camBuilding(B[activeB]); }
      else if (level === 1) { setPeel(activeB, false, Date.now()); activeB = null; level = 0; camEstate(); }
      applyState(); notify();
    };
    api.reset = function () {
      if (activeB) setPeel(activeB, false, Date.now());
      activeB = null; activeF = null; level = 0; api.select(null); camEstate(); applyState(); notify();
    };
    api.locate = function (recordId) {
      var out = null;
      data.buildings.forEach(function (b) {
        b.floors.forEach(function (f) { f.markers.forEach(function (m) { if (m.recordId === recordId) out = { b: b, f: f, m: m }; }); });
      });
      return out;
    };
    api.select = function (recordId, kind) {
      selectedId = recordId;
      if (recordId === null) {
        focusId = null; focusSpaceId = null; clearTimeout(focusT);
        var rbR = B[activeB];
        if (rbR) { var rfR = rbR.floors.find(function (r) { return r.data.recordId === activeF; }); if (rfR) rfR.data.spaces.forEach(function (sp3) { sp3._liftGoal = 0; }); }
      }
      if (recordId === null) { selRing.visible = selDisc.visible = selWave.visible = selBeam.visible = false; if (cb.onSelect) cb.onSelect(null); return; }
      if (kind === 'space') {
        var rbS = B[activeB], rfS = rbS.floors.find(function (r) { return r.data.recordId === activeF; });
        var sp = rfS.data.spaces.find(function (x) { return x.recordId === recordId; });
        // v5: the blue room fill is the selection — no pulse ring on spaces
        selRing.visible = selDisc.visible = selWave.visible = selBeam.visible = false;
        if (cb.onSelect) cb.onSelect({ kind: 'space', space: sp, b: rbS.data, f: rfS.data });
      if (cb.onFocus) cb.onFocus({ kind: 'space', id: recordId });
        return;
      }
      var loc = api.locate(recordId); if (!loc) return;
      var rb = B[loc.b.id], rf = rb.floors.find(function (r) { return r.data.recordId === loc.f.recordId; });
      selRing.visible = selDisc.visible = selWave.visible = selBeam.visible = true;
      var selCol = loc.m.status === 'critical' || loc.m.priority === 1 ? PALETTE.critical : loc.m.status === 'overdue' ? PALETTE.warning : PALETTE.primary;
      [selRing, selDisc, selWave, selBeam].forEach(function (o5) { o5.material.color.setHex(selCol); });
      selRing.userData = { rb: rb, rf: rf, m: loc.m };
      selAt = performance.now(); selPop = 0;
      if (cb.onSelect) cb.onSelect({ kind: loc.m.markerModuleName, m: loc.m, b: loc.b, f: loc.f });
      if (cb.onFocus) cb.onFocus({ kind: 'asset', id: recordId, spaceId: loc.m.spaceId || null });
    };
    api.focus = null;
    api.focusAsset = function (recordId) {
      var loc = api.locate(recordId); if (!loc) return;
      var rb = B[loc.b.id];
      var rf = rb.floors.find(function (r) { return r.data.recordId === loc.f.recordId; });
      if (!rf) return;
      var switching = focusId !== null;
      focusId = recordId; focusSpaceId = null;
      var h = (loc.m._pin && loc.m._pin.userData.modelHeight) || 1.6;
      var isPlanF = !!(rf.data && rf.data.plan);
      // staged flight: pull up and swing round, then settle onto the asset
      var fw = Math.max(rb.data.w, rb.data.d);
      var tx = rb.data.x + loc.m.x, tz = rb.data.z + loc.m.z;
      var ty = rf.group.position.y + h * 0.5 + 1.1;
      var swing = Math.atan2(loc.m.z, loc.m.x) + 0.9;
      clearTimeout(focusT);
      goal.target.set((cam.target.x + tx) / 2, ty + 2.2, (cam.target.z + tz) / 2);
      goal.radius = Math.max(fw * 0.7, 18);
      goal.phi = 0.66;
      goal.theta = swing;
      var homeSpace = loc.m.spaceId;
      rf.data.spaces.forEach(function (sp2) {
        // v5: no catapult — the camera flight is the only motion. Plan tints also never sink.
        sp2._liftGoal = sp2.recordId === homeSpace ? 0 : (isPlanF ? 0 : -2.4);
      });
      focusT = setTimeout(function () {
        if (focusId !== recordId) return;
        var settleR = isPlanF ? Math.max(fw * 0.55, 16) : Math.max(fw * 0.34, 9.5);
        var th = swing + 0.22;
        // shift the look-at toward the camera so the asset clears the bottom detail sheet
        var k = settleR * 0.3;
        goal.target.set(tx + Math.cos(th) * k, ty, tz + Math.sin(th) * k);
        goal.radius = settleR;
        goal.phi = isPlanF ? 0.6 : 0.86;
        goal.theta = th;
      }, 420);
      applyState();
    };
    api.focusSpace = function (spaceId) {
      var rb = B[activeB]; if (!rb) return;
      var rf = rb.floors.find(function (r) { return r.data.recordId === activeF; }); if (!rf) return;
      var sp = rf.data.spaces.find(function (x) { return x.recordId === spaceId; }); if (!sp) return;
      var switchingS = focusId !== null;
      var isPlanS = !!(rf.data && rf.data.plan);
      focusId = spaceId; focusSpaceId = spaceId;
      var xs = sp.polygon.map(function (p) { return p[0]; }), zs = sp.polygon.map(function (p) { return p[1]; });
      var w2 = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      var d3 = Math.max.apply(null, zs) - Math.min.apply(null, zs);
      var tx = rb.data.x + sp._center.x, tz = rb.data.z + sp._center.z;
      var ty = rf.group.position.y + 1.6;
      var swing = Math.atan2(sp._center.z, sp._center.x) + 0.9;
      clearTimeout(focusT);
      rf.data.spaces.forEach(function (sp2) {
        sp2._liftGoal = sp2.recordId === spaceId ? 0 : (isPlanS ? 0 : -2.4);
      });
      var settleS = function () {
        if (focusId !== spaceId) return;
        var thS = switchingS ? goal.theta : swing + 0.22;
        var rS = Math.max(Math.max(w2, d3) * (isPlanS ? 1.15 : 1.5), isPlanS ? 15 : 11);
        var kS = rS * (isPlanS ? 0.24 : 0);
        goal.target.set(tx + Math.cos(thS) * kS, ty, tz + Math.sin(thS) * kS);
        goal.radius = rS;
        goal.phi = isPlanS ? 0.58 : 0.84; goal.theta = thS;
      };
      if (switchingS) { settleS(); }
      else {
        goal.target.set((cam.target.x + tx) / 2, ty + 2.4, (cam.target.z + tz) / 2);
        goal.radius = Math.max(Math.max(rb.data.w, rb.data.d) * 0.7, 18);
        goal.phi = 0.66; goal.theta = swing;
        focusT = setTimeout(settleS, 420);
      }
      applyState();
    };
    api.clearFocus = function () {
      if (cb.onFocus) cb.onFocus(null);
      if (focusId === null) return;
      focusId = null; focusSpaceId = null; clearTimeout(focusT);
      var rb = B[activeB];
      if (rb) {
        var rf = rb.floors.find(function (r) { return r.data.recordId === activeF; });
        if (rf) { rf.data.spaces.forEach(function (sp2) { sp2._liftGoal = 0; }); camFloor(rb, rf); }
      }
      applyState();
    };
    api.selectMarker = api.select;
    api.flyToMarker = function (recordId) {
      var loc = api.locate(recordId); if (!loc) return;
      var wait = 0;
      if (activeB !== loc.b.id || level === 0) { api.enterBuilding(loc.b.id); wait = 900; }
      later(function () {
        api.enterFloor(loc.b.id, loc.f.recordId);
        later(function () { api.select(recordId); }, 500);
      }, wait);
    };
    api.addMarker = function (bid, fid, m) {
      var rb = B[bid]; if (!rb) return;
      var rf = rb.floors.find(function (r) { return r.data.recordId === fid; }); if (!rf) return;
      rf.data.markers.push(m); addPin(rf, m, true); applyState();
    };
    api.updateMarker = function (recordId, patch) {
      var loc = api.locate(recordId); if (!loc) return null;
      Object.keys(patch).forEach(function (k) { loc.m[k] = patch[k]; });
      if (loc.m.markerModuleName === 'asset') { if (loc.m._halo) loc.m._halo.material = haloMat(loc.m); }
      else if (loc.m._pin && loc.m._pin.userData.mats) {
        var urg = loc.m.status === 'critical' || loc.m.priority === 1;
        var wn = loc.m.status === 'overdue' || loc.m.priority === 2;
        var cl = loc.m.status === 'closed' ? PALETTE.closed : urg ? PALETTE.critical : wn ? PALETTE.warning : hexInt(loc.m.color || '#1673F6');
        loc.m._pin.userData.mats.forEach(function (mt) { mt.color.setHex(cl); });
      }
      applyState();
      if (selectedId === recordId) api.select(recordId);
      return loc.m;
    };
    api.setScope = function (s) {
      scope = s;
      if (selectedId !== null) { var loc = api.locate(selectedId); if (!loc || !s.canSeeMarker(loc.m)) api.select(null); }
      applyState();
    };
    api.zoom = function (dir) {
      goal.radius = Math.max(14, Math.min(280, goal.radius * (dir > 0 ? 1.25 : 0.8)));
      lastTouch = Date.now();
    };
    api.setLayers = function (l) { layers = l; applyState(); };
    api.setSearch = function (q) { searchQ = (q || '').toLowerCase(); applyState(); };
    api.setEditMode = function (v) { editMode = !!v; canvas.style.cursor = v ? 'crosshair' : 'grab'; };
    api.getState = function () { return { level: level, buildingId: activeB, floorId: activeF }; };

    // ---------- input ----------
    var ray = new T.Raycaster(), ndc = new T.Vector2();
    ray.params.Line.threshold = 0.05;
    var dragPin = null, dragPlane = new T.Plane(), hitPt = new T.Vector3();
    var down = null, moved = 0;

    function toNdc(e) {
      var r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
    }
    function activeFloor() {
      if (level !== 2 || !activeB) return null;
      return B[activeB].floors.find(function (x) { return x.data.recordId === activeF; });
    }

    // PATCH (facilio-vision-3d): every canvas listener below was registered with an
    // anonymous function, so none of them could ever be removed — dispose() left five
    // handlers holding the whole engine closure alive. `on()` records its own remover.
    var offs = [];
    function on(el, ev, fn, opt) {
      el.addEventListener(ev, fn, opt);
      offs.push(function () { el.removeEventListener(ev, fn, opt); });
    }

    on(canvas, 'pointerdown', function (e) {
      down = { x: e.clientX, y: e.clientY, t: Date.now() }; moved = 0; lastTouch = Date.now();
      canvas.setPointerCapture(e.pointerId);
      if (!editMode) return;
      var rf = activeFloor(); if (!rf) return;
      toNdc(e);
      var vis = rf.pins.filter(function (p) { return p.sprite.visible; });
      var hit = ray.intersectObjects(vis.map(function (p) { return p.sprite; }), true)[0];
      if (hit) {
        var mk = markerOf(hit.object);
        if (!mk) return;
        dragPin = vis.find(function (p) { return p.m === mk; });
        if (!dragPin) return;
        dragPlane.setFromNormalAndCoplanarPoint(new T.Vector3(0, 1, 0), dragPin.sprite.getWorldPosition(new T.Vector3()));
        canvas.style.cursor = 'grabbing';
        api.select(dragPin.m.recordId);
      }
    });
    on(canvas, 'pointermove', function (e) {
      lastTouch = Date.now();
      if (dragPin) {
        toNdc(e);
        if (ray.ray.intersectPlane(dragPlane, hitPt)) {
          var rb = B[activeB];
          var lx = Math.max(-rb.data.w / 2 + 1, Math.min(rb.data.w / 2 - 1, hitPt.x - rb.data.x));
          var lz = Math.max(-rb.data.d / 2 + 1, Math.min(rb.data.d / 2 - 1, hitPt.z - rb.data.z));
          dragPin.m.x = lx; dragPin.m.z = lz;
          dragPin.sprite.position.x = lx; dragPin.sprite.position.z = lz;
          dragPin.stem.position.x = lx; dragPin.stem.position.z = lz;
        }
        return;
      }
      if (!down) return;
      var dx = e.movementX || 0, dy = e.movementY || 0;
      moved += Math.abs(dx) + Math.abs(dy);
      goal.theta -= dx * 0.0052;
      goal.phi = Math.max(0.18, Math.min(1.42, goal.phi - dy * 0.004));
    });
    on(canvas, 'pointerup', function (e) {
      lastTouch = Date.now();
      if (dragPin) {
        var m = dragPin.m; dragPin = null; canvas.style.cursor = editMode ? 'crosshair' : 'grab';
        // re-home the marker onto whichever space now contains it
        var rf = activeFloor();
        if (rf) {
          var inside = rf.data.spaces.find(function (sp) {
            var xs = sp.polygon.map(function (p) { return p[0]; }), zs = sp.polygon.map(function (p) { return p[1]; });
            return m.x >= Math.min.apply(null, xs) && m.x <= Math.max.apply(null, xs) && m.z >= Math.min.apply(null, zs) && m.z <= Math.max.apply(null, zs);
          });
          if (inside && m.markerModuleName === 'asset') { m.spaceId = inside.recordId; m.spaceName = inside.name; }
        }
        if (cb.onMove) cb.onMove(m);
        return;
      }
      var quick = down && Date.now() - down.t < 450 && moved < 6;
      down = null;
      if (quick) handleClick(e);
    });
    on(canvas, 'wheel', function (e) {
      e.preventDefault();
      goal.radius = Math.max(14, Math.min(280, goal.radius * Math.pow(1.0015, e.deltaY)));
      lastTouch = Date.now();
    }, { passive: false });

    function handleClick(e) {
      toNdc(e);
      var rf = activeFloor();
      if (rf) {
        var vis = rf.pins.filter(function (p) { return p.sprite.visible; }).map(function (p) { return p.sprite; });
        var hit = ray.intersectObjects(vis, true)[0];
        if (hit) { var mm = markerOf(hit.object); if (mm) { api.select(mm.recordId); return; } }
        var spaceMeshes = rf.data.spaces.map(function (sp) { return sp._mesh; }).filter(function (x) { return x && x.visible !== false; });
        var hs = rf.spacesG.visible ? ray.intersectObjects(spaceMeshes, false)[0] : null;
        if (hs) { api.select(hs.object.userData.space.recordId, 'space'); return; }
        if (selectedId !== null) { api.select(null); return; }
        api.back(); return;
      }
      var shells = [];
      Object.keys(B).forEach(function (bid) { B[bid].floors.forEach(function (r) { if (r.group.visible) shells.push(r.shell); }); });
      var hit2 = ray.intersectObjects(shells, false)[0];
      if (!hit2) { if (level > 0) api.back(); return; }
      var ud = hit2.object.userData;
      if (level === 0 || ud.buildingId !== activeB) api.enterBuilding(ud.buildingId);
      else api.enterFloor(ud.buildingId, ud.floorId);
    }

    var last = performance.now(), disposed = false, paused = false, lastTagSig = '';
    function tick(now) {
      if (disposed) return;
      requestAnimationFrame(tick);
      // PATCH (facilio-vision-3d): the canvas is kept alive and parked off-screen
      // between tab switches, so a hidden estate would otherwise burn a full 60fps
      // GPU loop behind the live AR camera — the worst place to spend a phone's
      // thermal budget. Keep `last` fresh so resuming does not hand the clamp
      // below a multi-minute delta.
      if (paused) { last = now; return; }
      // clamp BOTH bounds: rAF can hand a timestamp behind performance.now() (begin-frame
      // clocks in headless, tab visibility switches) — a negative dt turns every damp/lerp
      // into extrapolation AWAY from its goal and the camera flies off by e^(4·|dt|)
      var dt = Math.max(0, Math.min((now - last) / 1000, 0.05)); last = now;
      if (Date.now() - lastTouch > 4000 && !editMode && level < 2) goal.theta += dt * 0.055;
      cam.theta = damp(cam.theta, goal.theta, dt, 5);
      cam.phi = damp(cam.phi, goal.phi, dt, 5);
      cam.radius = damp(cam.radius, goal.radius, dt, 4);
      cam.target.lerp(goal.target, 1 - Math.exp(-dt * 4));
      camera.position.set(
        cam.target.x + cam.radius * Math.sin(cam.phi) * Math.cos(cam.theta),
        cam.target.y + cam.radius * Math.cos(cam.phi),
        cam.target.z + cam.radius * Math.sin(cam.phi) * Math.sin(cam.theta));
      camera.lookAt(cam.target);
      var tNow = Date.now();
      Object.keys(B).forEach(function (bid) {
        B[bid].floors.forEach(function (rf) {
          if (tNow > rf.peelStart) rf.peel = damp(rf.peel, rf.peelGoal, dt, 4.2);
          rf.group.position.y = rf.level * FLOOR_H + rf.peel;
          rf.op = damp(rf.op, rf.opGoal, dt, 5);
          rf.shellMat.opacity = rf.op * 0.44;
          rf.content = damp(rf.content, rf.contentGoal, dt, 6.5);
          if (rf.content > 0.003 || rf.contentGoal > 0) {
            var cv = rf.content, rise = (1 - cv) * 0.7;
            rf.slab.visible = true; rf.markersG.visible = true;
            rf.spacesG.visible = rf.wantSpaces;
            rf.spacesG.position.y = rise; rf.markersG.position.y = rise;
            rf.data.spaces.forEach(function (sp4) {
              if (!sp4._group) return;
              sp4._lift = damp(sp4._lift, sp4._liftGoal || 0, dt, 4.5);
              sp4._group.position.y = sp4._lift;
              sp4._group.visible = sp4._lift > -2.2;
            });
            rf.spacesG.traverse(function (o) {
              if (!o.material || o.material === stemMat) return;
              o.material.transparent = true;
              o.material.opacity = cv * (o.userData && o.userData.baseOp != null ? o.userData.baseOp : 1);
            });
            rf.slab.material.transparent = true; rf.slab.material.opacity = cv;
            if (rf.isPlan && rf.mass) rf.mass.visible = cv < 0.05;
          } else if (rf.slab.visible) {
            rf.slab.visible = false; rf.spacesG.visible = false; rf.markersG.visible = false;
            if (rf.isPlan && rf.mass) rf.mass.visible = true;
          }
          rf.edges.material.opacity = Math.min(0.85, rf.op + 0.12);
          if (rf.markersG.visible) rf.pins.forEach(function (p) {
            if (!p.sprite) return;
            var ud = p.sprite.userData;
            var urgent = p.m.status === 'critical' || p.m.status === 'overdue' || p.m.priority === 1;
            var w = Math.sin(now / 260 + ud.phase);
            var selected = selectedId === p.m.recordId;
            if (p.isAsset) {
              p.sprite.rotation.y = 0;
              if (p.stem) {
                var hs = (urgent ? 1 + 0.22 * w : 1) * (selected ? 1.35 : 1);
                p.stem.scale.set(hs, hs, 1);
                p.stem.material.opacity = selected ? 0.85 : urgent ? 0.55 + 0.25 * w : 0.3;
              }
              if (ud.dropStart) {
                var pg = Math.min(1, (tNow - ud.dropStart) / 650), e2 = 1 - Math.pow(1 - pg, 3);
                p.sprite.position.y = ud.baseY + (1 - e2) * 9;
                if (pg >= 1) ud.dropStart = 0;
              }
              return;
            }
            var s = 1;
            if (urgent) { s = 1 + 0.14 * w; }
            if (selected) {
              var pe = 1 - Math.pow(1 - Math.min(1, (now - selAt) / 420), 3);
              s *= 1 + 0.16 * pe;
              p.sprite.position.y = damp(p.sprite.position.y, ud.baseY + 0.34 * pe + Math.sin(now / 430) * 0.05, dt, 9);
              if (!p._lit) {
                p._lit = true;
                p.sprite.traverse(function (o6) {
                  if (!o6.isMesh || !o6.material) return;
                  if (!o6.userData._c0) o6.userData._c0 = o6.material.color.clone();
                  o6.material.color.copy(o6.userData._c0).lerp(new T.Color(0xFFFFFF), 0.2);
                });
              }
            } else if (p._lit) {
              p._lit = false;
              p.sprite.traverse(function (o6) { if (o6.isMesh && o6.userData._c0) o6.material.color.copy(o6.userData._c0); });
              p.sprite.position.y = damp(p.sprite.position.y, ud.baseY, dt, 9);
            }
            p.sprite.scale.set(s, s, s);
            p.sprite.rotation.y += selected ? 0.0022 : 0.006;
            if (ud.dropStart) {
              var pgr = Math.min(1, (tNow - ud.dropStart) / 650), ease = 1 - Math.pow(1 - pgr, 3);
              p.sprite.position.y = ud.baseY + (1 - ease) * 9;
              if (pgr >= 1) ud.dropStart = 0;
            }
          });
        });
      });
      if (cb.onTags) {
        var tags = [];
        var rfA = level === 2 && activeB ? B[activeB].floors.find(function (x) { return x.data.recordId === activeF; }) : null;
        if (rfA) {
          var rect = canvas.getBoundingClientRect();
          rfA.pins.forEach(function (p) {
            if (!p.isAsset || !p.sprite || !p.sprite.visible) return;
            var wp = p.sprite.getWorldPosition(new T.Vector3());
            wp.y += (p.sprite.userData.modelHeight || 1.5) + 0.5;
            var v = wp.project(camera);
            if (v.z > 1) return;
            var open = 0;
            rfA.data.markers.forEach(function (mm) {
              if (mm.markerModuleName === 'workorder' && mm.assetId === p.m.recordId && mm.status !== 'closed') open++;
            });
            tags.push({
              recordId: p.m.recordId, code: p.m.code || p.m.name, category: p.m.taxonomyName || p.m.category,
              status: p.m.status, color: p.m.color, woCount: open,
              selected: selectedId === p.m.recordId,
              x: Math.round((v.x * 0.5 + 0.5) * rect.width),
              y: Math.round((-v.y * 0.5 + 0.5) * rect.height),
              depth: v.z
            });
          });
          tags.sort(function (a2, b2) { return b2.depth - a2.depth; });
        }
        var spaceTags = [];
        if (rfA && rfA.spacesG.visible) {
          var rect2 = canvas.getBoundingClientRect();
          var bb = B[activeB].data;
          var focusOwner = focusId !== null && focusSpaceId === null
            ? (rfA.data.markers.find(function (m5) { return m5.recordId === focusId; }) || {}).spaceId : null;
          rfA.data.spaces.forEach(function (sp) {
            if (!sp._center) return;
            if (focusSpaceId !== null && sp.recordId !== focusSpaceId) return;
            if (focusOwner !== null && sp.recordId !== focusOwner) return;
            var v2 = new T.Vector3(bb.x + sp._center.x, rfA.group.position.y + 3.4, bb.z + sp._center.z).project(camera);
            if (v2.z > 1) return;
            var open = 0, prog = 0;
            rfA.data.markers.forEach(function (mm) {
              if (mm.markerModuleName !== 'workorder') return;
              var owner = rfA.data.markers.find(function (a2) { return a2.recordId === mm.assetId; });
              if (!owner || owner.spaceId !== sp.recordId) return;
              if (mm.priority === 1 || mm.status === 'overdue') open++; else prog++;
            });
            spaceTags.push({
              recordId: sp.recordId, name: sp.name, category: sp.spaceCategory,
              open: open, progress: prog,
              status: sp._status === 'critical' ? 'open' : sp._status === 'warning' ? 'progress' : sp._status === 'selected' ? 'selected' : 'clear',
              selected: selectedId === sp.recordId,
              x: Math.round((v2.x * 0.5 + 0.5) * rect2.width),
              y: Math.round((-v2.y * 0.5 + 0.5) * rect2.height),
              depth: v2.z
            });
          });
          spaceTags.sort(function (a3, b3) { return b3.depth - a3.depth; });
        }
        var sig = tags.map(function (t2) { return t2.recordId + ':' + t2.x + ':' + t2.y + ':' + t2.woCount + ':' + (t2.selected ? 1 : 0); }).join('|') +
          '#' + spaceTags.map(function (t3) { return t3.recordId + ':' + t3.x + ':' + t3.y + ':' + (t3.selected ? 1 : 0); }).join('|');
        if (sig !== lastTagSig) { lastTagSig = sig; cb.onTags(tags, spaceTags); }
      }
      if (selRing.visible && selRing.userData.rb) {
        var u = selRing.userData;
        var bx = u.rb.data.x + u.m.x, by = u.rf.group.position.y + 0.3, bz = u.rb.data.z + u.m.z;
        var mr = Math.max(0.85, (u.m._pin && u.m._pin.userData.radius) || 0.9) + 0.35;
        var mh = (u.m._pin && u.m._pin.userData.modelHeight) || 1.6;
        // 420ms overshoot-free settle on pick
        selPop = Math.min(1, (now - selAt) / 420);
        var ease = 1 - Math.pow(1 - selPop, 3);
        var breathe = 1 + 0.045 * Math.sin(now / 420);
        var base = mr * (0.55 + 0.45 * ease) * breathe;
        selRing.position.set(bx, by, bz); selRing.scale.set(base, base, 1);
        selRing.material.opacity = 0.35 + 0.55 * ease;
        selDisc.position.set(bx, by - 0.02, bz); selDisc.scale.set(base, base, 1);
        selDisc.material.opacity = (0.1 + 0.06 * Math.sin(now / 420)) * ease;
        // shockwave pings outward every 1.6s
        var wv = ((now - selAt) % 1600) / 1600;
        var ws = mr * (1 + wv * 1.5);
        selWave.position.set(bx, by + 0.01, bz); selWave.scale.set(ws, ws, 1);
        selWave.material.opacity = 0.45 * (1 - wv) * ease;
        selBeam.position.set(bx, by + mh * 1.35, bz);
        selBeam.scale.set(mr * 0.8, (mh * 2.7) / 5.2, mr * 0.8);
        selBeam.material.opacity = 0.09 * ease;
      }
      renderer.render(scene, camera);
    }

    function resize() {
      var p = canvas.parentElement; if (!p) return;
      var w = p.clientWidth, h = p.clientHeight;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    var ro = new ResizeObserver(resize); ro.observe(canvas.parentElement);
    resize(); applyState(); requestAnimationFrame(tick);
    window.__estate = api;
    api._debug = function () {
      return { level: level, camR: cam.radius, goalR: goal.radius, camPhi: cam.phi, goalPhi: goal.phi,
        target: [Math.round(cam.target.x), Math.round(cam.target.y), Math.round(cam.target.z)],
        goalT: [Math.round(goal.target.x), Math.round(goal.target.y), Math.round(goal.target.z)],
        aspect: Math.round(camera.aspect * 100) / 100 };
    };
    /* PATCH (facilio-vision-3d): a dispose() that actually disposes.
     *
     * The original was `disposed = true; ro.disconnect(); renderer.dispose();`.
     * renderer.dispose() frees the RENDERER's own caches and nothing else — every
     * geometry, material and canvas texture stayed resident, the five canvas
     * listeners stayed attached, and the WebGL context was never released. Chrome
     * keeps ~16 live contexts and force-loses the OLDEST when a 17th is created, so
     * a canvas still on screen would go black after enough tab switches.
     */
    api.dispose = function () {
      disposed = true;
      ro.disconnect();
      offs.forEach(function (off) { off(); }); offs.length = 0;
      clearTimeout(focusT);
      flights.forEach(clearTimeout); flights.length = 0;

      // 1. every GPU resource reachable from the graph. Sprites matter as much as
      //    meshes — the per-building name labels are CanvasTextures on sprite materials.
      var seen = new Set();
      var TEX_KEYS = ['map', 'alphaMap', 'lightMap', 'aoMap', 'emissiveMap',
                      'bumpMap', 'normalMap', 'specularMap', 'envMap'];
      scene.traverse(function (o) {
        if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
        var mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        mats.forEach(function (m) {
          if (seen.has(m)) return;
          seen.add(m);
          TEX_KEYS.forEach(function (k) {
            if (m[k] && m[k].isTexture && !seen.has(m[k])) { seen.add(m[k]); m[k].dispose(); }
          });
          m.dispose();
        });
      });

      // 2. the closure-scoped caches a scene traversal cannot reach
      Object.keys(pinTex).forEach(function (k) { pinTex[k].dispose(); delete pinTex[k]; });
      haloGeo.dispose(); stemGeo.dispose(); stemMat.dispose();

      // 3. addPin writes three.js objects back onto the CALLER's data (m._pin/_halo).
      //    React holds that object, so skipping this keeps the entire scene graph
      //    reachable no matter how thoroughly the rest was disposed. This is the step
      //    that actually frees the memory.
      data.buildings.forEach(function (b) {
        b.floors.forEach(function (f) {
          f.markers.forEach(function (m) { m._pin = null; m._halo = null; });
          f.spaces.forEach(function (sp) {
            sp._mesh = null; sp._group = null; sp._base = null;
            sp._wallMat = null; sp._center = null; sp._statusColor = null;
          });
        });
      });

      while (scene.children.length) scene.remove(scene.children[0]);
      B = {};
      renderer.dispose();
      // The only call that hands the context back. Guarded: a missing method
      // degrades to the old behaviour rather than throwing mid-teardown.
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      if (window.__estate === api) window.__estate = null;
    };

    /* PATCH (facilio-vision-3d): stop rendering while the canvas is parked off-screen. */
    api.setPaused = function (v) {
      paused = !!v;
      if (!paused) { last = performance.now(); lastTagSig = ''; }
    };

    /* PATCH (facilio-vision-3d): the status ramp was hardcoded here AND in the 2D UI.
     * The screen now passes the resolved CSS design tokens in, so one token change
     * repaints both. Unknown keys are ignored; omitted keys keep their defaults. */
    api.setPalette = function (p) {
      if (!p) return;
      if (typeof p.critical === 'number') PALETTE.critical = p.critical;
      if (typeof p.warning === 'number') PALETTE.warning = p.warning;
      if (typeof p.primary === 'number') PALETTE.primary = p.primary;
      if (typeof p.closed === 'number') PALETTE.closed = p.closed;
      if (typeof p.marker === 'number') PALETTE.marker = p.marker;
      applyState();
    };
    return api;
  };
})();
