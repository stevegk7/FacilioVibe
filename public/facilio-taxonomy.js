/* facilio-taxonomy.js — extracted verbatim from the org's assetcategory / spacecategory modules
   (facilio-category-schema/v1, AU region, 22279 assets / 41685 spaces scanned).
   Colors are the schema's own renderHint values.

   NOTE (vibe port): FACILIO_TRADES, FACILIO_SPACE_GROUPS and FACILIO_ASSET_CATEGORIES are the
   design's lists unchanged. FACILIO_SPACE_CATEGORIES keeps the design's generic categories but
   drops its ~130 site-specific "Level NN" / "Sky Tower - Floor NN" rows, which belong to a
   different org and never match a record here. The five categories this org actually uses are
   Room / Utility / Common Area / Office / Hallway — "Utility" and "Hallway" were absent from the
   design's list and are appended at the end, flagged, so real spaces still resolve a group+colour
   (spaceGroup drives which furniture the engine puts in a room). Unresolved names fall back in
   buildEstate(). */
window.FACILIO_TRADES = {
  "HVAC": "#276591",
  "Fire Safety": "#912727",
  "Electrical": "#917627",
  "Plumbing & Hydraulic": "#277f91",
  "Security & Communications": "#532791",
  "Vertical Transport": "#91276e",
  "Metering & Energy": "#4a9127",
  "Controls & Devices": "#272791",
  "Appliances & White Goods": "#915327",
  "Furniture & Fixtures": "#279153",
  "Plant & Equipment": "#762791"
};
window.FACILIO_SPACE_GROUPS = {
  "Residential Unit": "#b38665",
  "Floor Level": "#658cb3",
  "Common & Public": "#65b386",
  "Administration": "#b3a065",
  "Bed & Room": "#b36599",
  "Tenancy": "#8665b3"
};
window.FACILIO_ASSET_CATEGORIES = [{"id":"2745","name":"bbq","trade":"Appliances & White Goods","color":"#915327","icon":"bbq"},{"id":"3661","name":"cooktophood","trade":"Appliances & White Goods","color":"#a25d2b","icon":"cooktophood"},{"id":"3662","name":"electricbarbecuecooktop","trade":"Appliances & White Goods","color":"#b46730","icon":"electricbarbecuecooktop"},{"id":"3664","name":"fridge","trade":"Appliances & White Goods","color":"#c57134","icon":"fridge","count":1},{"id":"3663","name":"inductioncooker","trade":"Appliances & White Goods","color":"#cd7c42","icon":"inductioncooker","count":2},{"id":"3665","name":"microwave","trade":"Appliances & White Goods","color":"#d18853","icon":"microwave","count":8},{"id":"3660","name":"rangehood","trade":"Appliances & White Goods","color":"#d69465","icon":"rangehood"},{"id":"2760","name":"whitegoods","trade":"Appliances & White Goods","color":"#dba076","icon":"whitegoods","count":5234},{"id":"2701","name":"Devices","trade":"Controls & Devices","color":"#272791","icon":"devices","count":22},{"id":"3762","name":"devices","trade":"Controls & Devices","color":"#7676db","icon":"devices","count":10},{"id":"2746","name":"electricalwaterheater","trade":"Electrical","color":"#917627","icon":"electricalwaterheater","count":21},{"id":"3645","name":"generalpower","trade":"Electrical","color":"#a98a2d","icon":"generalpower","count":1},{"id":"3644","name":"generalpowerlightswitches","trade":"Electrical","color":"#c19e33","icon":"generalpowerlightswitches","count":2},{"id":"3651","name":"lightingcontrol","trade":"Electrical","color":"#ceac46","icon":"lightingcontrol","count":5},{"id":"3643","name":"lvelectrical","trade":"Electrical","color":"#d4b75e","icon":"lvelectrical","count":69},{"id":"3673","name":"mainswitchboard","trade":"Electrical","color":"#dbc176","icon":"mainswitchboard"},{"id":"3654","name":"dieselpump","trade":"Fire Safety","color":"#912727","icon":"dieselpump","count":1},{"id":"3655","name":"electricpump","trade":"Fire Safety","color":"#a02b2b","icon":"electricpump","count":1},{"id":"3667","name":"essentialsafetymeasures","trade":"Fire Safety","color":"#af2f2f","icon":"essentialsafetymeasures"},{"id":"3668","name":"essentialsafetymeasures","trade":"Fire Safety","color":"#be3333","icon":"essentialsafetymeasures"},{"id":"3653","name":"ewispanel","trade":"Fire Safety","color":"#cb3a3a","icon":"ewispanel","count":1},{"id":"3656","name":"extinguishers","trade":"Fire Safety","color":"#cf4949","icon":"extinguishers","count":1},{"id":"2761","name":"fireequipments","trade":"Fire Safety","color":"#d35858","icon":"fireequipments","count":3093},{"id":"3652","name":"fireindicatorpanel","trade":"Fire Safety","color":"#d76767","icon":"fireindicatorpanel","count":1},{"id":"3669","name":"firesafetyequipment","trade":"Fire Safety","color":"#db7676","icon":"firesafetyequipment"},{"id":"3674","name":"fixeditems","trade":"Furniture & Fixtures","color":"#279153","icon":"fixeditems"},{"id":"3887","name":"furniture","trade":"Furniture & Fixtures","color":"#76dba0","icon":"furniture","count":3013},{"id":"2703","name":"AHU","trade":"HVAC","color":"#276591","icon":"ahu","count":1139},{"id":"2702","name":"Chiller","trade":"HVAC","color":"#296a99","icon":"chiller","count":243},{"id":"2707","name":"Chiller Plant Manager","trade":"HVAC","color":"#2b70a1","icon":"chiller-plant-manager","count":5671},{"id":"2710","name":"Condenser Pump","trade":"HVAC","color":"#2d75a9","icon":"condenser-pump","count":1},{"id":"2705","name":"Cooling Tower","trade":"HVAC","color":"#2f7bb1","icon":"cooling-tower","count":901},{"id":"2704","name":"FAHU","trade":"HVAC","color":"#3181b9","icon":"fahu","count":2},{"id":"2700","name":"FCU","trade":"HVAC","color":"#3386c1","icon":"fcu","count":1602},{"id":"3658","name":"filters","trade":"HVAC","color":"#368cc9","icon":"filters","count":25},{"id":"3659","name":"grilles","trade":"HVAC","color":"#3e90cc","icon":"grilles","count":287},{"id":"2706","name":"Heat Pump","trade":"HVAC","color":"#4695ce","icon":"heat-pump","count":263},{"id":"2683","name":"HVAC","trade":"HVAC","color":"#4e9ad0","icon":"hvac","count":2},{"id":"3671","name":"hvac","trade":"HVAC","color":"#569ed2","icon":"hvac","count":3},{"id":"2708","name":"Primary Pump","trade":"HVAC","color":"#5ea3d4","icon":"primary-pump","count":166},{"id":"20212","name":"refrigeration","trade":"HVAC","color":"#66a7d6","icon":"refrigeration"},{"id":"2709","name":"Secondary Pump","trade":"HVAC","color":"#6eacd8","icon":"secondary-pump"},{"id":"3657","name":"ventilationfans","trade":"HVAC","color":"#76b1db","icon":"ventilationfans","count":67},{"id":"2682","name":"Energy Meter","trade":"Metering & Energy","color":"#4a9127","icon":"energy-meter","count":3},{"id":"2698","name":"Utility Meter","trade":"Metering & Energy","color":"#6acb3a","icon":"utility-meter","count":5},{"id":"2699","name":"Water Meter","trade":"Metering & Energy","color":"#98db76","icon":"water-meter","count":12},{"id":"2755","name":"pe","trade":"Plant & Equipment","color":"#762791","icon":"pe","count":3},{"id":"3672","name":"fixtures","trade":"Plumbing & Hydraulic","color":"#277f91","icon":"fixtures"},{"id":"3670","name":"gas","trade":"Plumbing & Hydraulic","color":"#2f9aaf","icon":"gas"},{"id":"2749","name":"hotwater","trade":"Plumbing & Hydraulic","color":"#3ab2cb","icon":"hotwater","count":118},{"id":"2743","name":"hydraulic","trade":"Plumbing & Hydraulic","color":"#58bed3","icon":"hydraulic","count":237},{"id":"2757","name":"pump","trade":"Plumbing & Hydraulic","color":"#76cadb","icon":"pump","count":9},{"id":"3648","name":"accesscontrol","trade":"Security & Communications","color":"#532791","icon":"accesscontrol","count":5},{"id":"3647","name":"cctv","trade":"Security & Communications","color":"#642faf","icon":"cctv","count":1},{"id":"3646","name":"communications","trade":"Security & Communications","color":"#763acb","icon":"communications","count":23},{"id":"3650","name":"electricalcommunications","trade":"Security & Communications","color":"#8b58d3","icon":"electricalcommunications","count":2},{"id":"3649","name":"intercom","trade":"Security & Communications","color":"#a076db","icon":"intercom","count":3},{"id":"3666","name":"lifts","trade":"Vertical Transport","color":"#91276e","icon":"lifts"}];
window.FACILIO_SPACE_CATEGORIES = [
  {"id":"1108","name":"Bed","group":"Bed & Room","color":"#b36599","count":25782,"common":["Chiller Plant Manager","FCU","whitegoods","AHU","fireequipments","Heat Pump"]},
  {"id":"1109","name":"Shared","group":"Common & Public","color":"#c1e1ce","count":2830,"common":["whitegoods","Chiller Plant Manager","fireequipments","Heat Pump","Chiller","FCU"]},
  {"id":"1111","name":"Public","group":"Common & Public","color":"#93caaa","count":2152,"common":["Chiller Plant Manager","whitegoods","Heat Pump","Chiller","Cooling Tower"]},
  {"id":"1112","name":"Admin","group":"Administration","color":"#b3a065","count":838,"common":["Chiller Plant Manager","whitegoods","hotwater","Energy Meter","hydraulic"]},
  {"id":"1110","name":"BedClosed","group":"Bed & Room","color":"#ca93b8","count":350,"common":["Chiller Plant Manager","whitegoods","fireequipments"]},
  {"id":"729","name":"NIR_Admin","group":"Administration","color":"#d5cbaa","count":118,"common":[]},
  {"id":"725","name":"HWK_Admin","group":"Administration","color":"#cabc93","count":46,"common":["fireequipments","whitegoods","hotwater","hydraulic","Cooling Tower","Water Meter"]},
  {"id":"703","name":"CBL_Admin","group":"Administration","color":"#bfae7c","count":39,"common":["fireequipments","hotwater","Chiller","whitegoods","Cooling Tower","AHU"]},
  {"id":"695","name":"Office","group":"Administration","color":"#e1d9c1","common":[]},
  {"id":"702","name":"Room","group":"Bed & Room","color":"#e1c1d6","common":[]},
  {"id":"693","name":"Common Area","group":"Common & Public","color":"#65b386","common":[]},
  {"id":"698","name":"Tenant Unit","group":"Tenancy","color":"#8665b3","count":2,"common":[]},
  {"id":"707","name":"Apartments","group":"Residential Unit","color":"#b38665","common":[]},
  {"id":"708","name":"Lodges","group":"Residential Unit","color":"#c9a891","common":[]},
  {"id":"710","name":"Studios","group":"Residential Unit","color":"#dac3b3","common":[]},
  {"id":"711","name":"Townhouse","group":"Residential Unit","color":"#dcc7b8","common":[]},
  {"id":"712","name":"Townhouses","group":"Residential Unit","color":"#decbbd","common":[]},
  {"id":"713","name":"Villas","group":"Residential Unit","color":"#e1cec1","common":[]},
  {"id":"1227","name":"Residential","group":"Residential Unit","color":"#d7bfae","count":135,"common":[]},
  /* appended for this org — not present in the design's extract */
  {"id":"_utility","name":"Utility","group":"Plant & Utility","color":"#9fb0c4","common":[],"_added":true},
  {"id":"_hallway","name":"Hallway","group":"Circulation","color":"#c3cdda","common":[],"_added":true}
];
