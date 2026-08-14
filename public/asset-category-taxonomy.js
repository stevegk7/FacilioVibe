/* asset-category-taxonomy.js — runtime mirror of src/data/assetCategoryTaxonomy.ts.
   Same colour/icon-slug logic, same names and hierarchy. Colour + shape assignment lives
   here and in the .ts twin only; nothing else in the app should hard-code a category colour. */
(function () {
  'use strict';

  var TYPE_COLORS = { ENERGY: '#C08A16', HVAC: '#276591', CONTROLLER: '#3C229D', DEVICE: '#0F8A7E', REFRIGERANT: '#912727' };
  var TYPE_SHAPES = { ENERGY: 'box', HVAC: 'cone', CONTROLLER: 'octahedron', DEVICE: 'sphere', REFRIGERANT: 'cylinder' };
  var DEPTH_LIGHTEN = { 0: 0, 1: 0.22, 2: 0.4 };

  function slugify(n) { return n.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function lighten(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    function mix(c) { return Math.round(c + (255 - c) * a); }
    return '#' + [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
      .map(function (c) { return c.toString(16).padStart(2, '0'); }).join('');
  }
  function colorFor(type, depth) { return lighten(TYPE_COLORS[type], DEPTH_LIGHTEN[depth]); }

  var RAW = {
    ENERGY: ['Energy Meter', 'Utility Meter', 'Water Meter', 'FCU'],
    HVAC: [{ name: 'HVAC', children: [
      { name: 'Chiller', children: ['Chiller Plant Manager', 'Primary Pump', 'Secondary Pump', 'Condenser Pump'] },
      'AHU', 'FAHU', 'Cooling Tower', 'Heat Pump'] }],
    CONTROLLER: ['Controller', 'System Controller', 'Misc Controller', 'Custom Controller',
      'Rest Controller', 'BACnet IP Controller', 'Niagara Controller', 'Lon Works Controller',
      'Modbus Rtu Controller', 'Modbus Tcp Controller', 'Opc XML DA Controller', 'Opc UA Controller',
      'RDM Controller', 'E2 Controller', 'iLon Controller', 'Danfoss Controller'],
    DEVICE: ['Devices'],
    REFRIGERANT: ['Refrigeration']
  };

  function build(raw, type, depth, parentId) {
    var name = typeof raw === 'string' ? raw : raw.name;
    var id = slugify(name);
    var kids = typeof raw === 'string' ? [] : raw.children;
    return {
      id: id, name: name, type: type, depth: depth, parentId: parentId,
      color: colorFor(type, depth), iconSlug: id,
      children: kids.map(function (k) { return build(k, type, depth + 1, id); })
    };
  }

  var TREE = Object.keys(RAW).map(function (type) {
    return { type: type, color: TYPE_COLORS[type], nodes: RAW[type].map(function (r) { return build(r, type, 0, null); }) };
  });

  var BY_ID = {};
  (function walkAll() {
    function walk(n) { BY_ID[n.id] = n; n.children.forEach(walk); }
    TREE.forEach(function (g) { g.nodes.forEach(walk); });
  })();

  function hierarchyPath(id) {
    var parts = [], n = BY_ID[id];
    while (n) { parts.unshift(n.name); n = n.parentId ? BY_ID[n.parentId] : null; }
    return parts.join(' > ');
  }
  function flatten() {
    var out = [];
    function walk(n) { out.push(n); n.children.forEach(walk); }
    TREE.forEach(function (g) { g.nodes.forEach(walk); });
    return out;
  }

  window.AssetTaxonomy = {
    TYPE_COLORS: TYPE_COLORS, TYPE_SHAPES: TYPE_SHAPES, TREE: TREE, BY_ID: BY_ID,
    slugify: slugify, colorFor: colorFor, hierarchyPath: hierarchyPath, flatten: flatten,
    shapeFor: function (id) { var n = BY_ID[id]; return n ? TYPE_SHAPES[n.type] : 'sphere'; }
  };
})();
