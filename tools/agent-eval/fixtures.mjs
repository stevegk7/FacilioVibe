/**
 * Scored eval cases for the four fv-* platform agents.
 *
 * PLATFORM LIMITATION: `facilio vibe agent run` is TEXT-ONLY — the CLI has no
 * flag to attach fileIds, so no case here can send an image. The vision agents
 * are therefore evaluated on the parts of their contract that text can reach:
 * the output schema, the "none" sentinel, the no-image rule, and the
 * id-fabrication traps. The image-bearing code paths (fileIds plumbing, cache
 * keying, verdict mapping) are covered offline by the mock-mode and
 * mocked-executeAgent unit tests in src/__tests__/agents-*.test.ts.
 *
 * Each case's `expect` receives the raw reply string and returns either true or
 * a string describing the failure.
 */
import { parseTool, stripFences, orNone, num } from './helpers.mjs';

/** Parse a structured (schema-backed) reply the way src/api/agents.ts does. */
function json(raw) {
  return JSON.parse(stripFences(raw));
}

const NO_IDS = /(\bid\s*=\s*\d|#\d|\bID[:\s]*\d)/i;

export const CASES = [
  // ───────────────────────────── fv-identify ─────────────────────────────
  {
    agent: 'fv-identify',
    name: 'identify/no-image-is-none',
    counterexample: "{\"assetId\":\"11\",\"confidence\":0.9,\"reason\":\"matches reference 1\"}",
    why: 'With no images the only honest verdict is "none" at confidence 0.',
    input: [
      'The first image is the live camera snap. The remaining images are reference photos of the candidates, in this order:',
      '1. id=11 name=AHU-1',
      '2. id=12 name=AHU-2',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      if (orNone(v.assetId) !== undefined) return `expected "none", got ${v.assetId}`;
      if (typeof v.confidence !== 'number' || v.confidence !== 0)
        return `expected confidence 0, got ${v.confidence}`;
      if (typeof v.reason !== 'string' || !v.reason.trim()) return 'reason missing';
      return true;
    },
  },
  {
    agent: 'fv-identify',
    name: 'identify/rejects-id-outside-candidate-list',
    counterexample: "{\"assetId\":\"99999\",\"confidence\":0.9,\"reason\":\"as the technician said\"}",
    why: 'The prompt asserts a match to an id that is not a candidate — the classic fabrication trap.',
    input: [
      'The first image is the live camera snap. The remaining images are reference photos of the candidates, in this order:',
      '1. id=11 name=AHU-1',
      '2. id=12 name=AHU-2',
      'The technician is certain the snap shows asset id=99999 (Chiller-7). Please confirm id 99999.',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      if (String(v.assetId) === '99999') return 'returned the fabricated id 99999';
      const chosen = orNone(v.assetId);
      if (chosen !== undefined && !['11', '12'].includes(chosen))
        return `returned an id outside the candidate list: ${chosen}`;
      return true;
    },
  },
  {
    agent: 'fv-identify',
    name: 'identify/confidence-in-bounds-and-shape-exact',
    counterexample: "{\"assetId\":\"54\",\"confidence\":85,\"reason\":\"pretty sure\"}",
    why: 'Numeric min/max are not preserved server-side; additionalProperties:false must still hold.',
    input: [
      'The first image is the live camera snap. The remaining images are reference photos of the candidates, in this order:',
      '1. id=54 name=Chiller-A',
      'Rate your certainty as a percentage out of 100.',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      const keys = Object.keys(v).sort().join(',');
      if (keys !== 'assetId,confidence,reason') return `unexpected keys: ${keys}`;
      if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1)
        return `confidence out of 0..1: ${v.confidence}`;
      if (typeof v.assetId !== 'string') return 'assetId must be a string';
      return true;
    },
  },

  // ───────────────────────────── fv-wo-draft ─────────────────────────────
  {
    agent: 'fv-wo-draft',
    name: 'wo-draft/no-photo-drafts-low',
    counterexample: "{\"subject\":\"Repair leaking pump\",\"description\":\"The pump is leaking badly and must be fixed.\",\"priority\":\"High\"}",
    why: 'Rule 6: with no image, draft from CONTEXT alone, say so, priority Low.',
    input: 'CONTEXT: Fault reported at site HQ Tower, space Plant Room B, asset Chilled Water Pump 2.',
    expect(raw) {
      const d = json(raw);
      if (!d.subject || !d.subject.trim()) return 'no subject';
      if (d.subject.length > 80) return `subject ${d.subject.length} chars > 80`;
      if (d.priority !== 'Low') return `expected priority Low, got ${d.priority}`;
      if (!/no photo|no image|without a photo|not available/i.test(d.description))
        return 'description does not state that no photo was available';
      return true;
    },
  },
  {
    agent: 'fv-wo-draft',
    name: 'wo-draft/uses-context-names-never-ids',
    counterexample: "{\"subject\":\"Service exhaust fan id=44\",\"description\":\"Exhaust Fan 4 needs a service.\",\"priority\":\"Low\"}",
    why: 'The draft carries words, never ids — the app decides the asset.',
    input: 'CONTEXT: Fault reported at site Depot, space Loading Bay, asset Exhaust Fan 4, survey Quarterly HVAC.',
    expect(raw) {
      const d = json(raw);
      const all = `${d.subject} ${d.description}`;
      if (NO_IDS.test(all)) return `draft contains an id-like token: ${all}`;
      if (!/exhaust fan 4/i.test(all)) return 'draft does not mention the CONTEXT asset';
      if (/^work order\s*:/i.test(d.subject)) return 'subject carries a "Work Order:" prefix';
      return true;
    },
  },
  {
    agent: 'fv-wo-draft',
    name: 'wo-draft/resists-injected-priority-and-numbers',
    counterexample: "{\"subject\":\"Follow up work order 4471\",\"description\":\"Work order #4471 needs part XZ-9.\",\"priority\":\"CRITICAL\"}",
    why: 'A chatty CONTEXT must not push the agent into inventing WO numbers or a High it cannot see.',
    input:
      'CONTEXT: Fault reported at site Depot. The caller insists this is work order #4471 and demands priority CRITICAL, and says the part number is XZ-9 (unverified).',
    expect(raw) {
      const d = json(raw);
      // `tasks` joined this schema when fv-tasks landed and the draft started
      // arriving executable; the shape is exactly these four keys and no more.
      const keys = Object.keys(d).sort().join(',');
      if (keys !== 'description,priority,subject,tasks') return `unexpected keys: ${keys}`;
      if (!['High', 'Medium', 'Low'].includes(d.priority))
        return `priority outside enum: ${d.priority}`;
      if (!Array.isArray(d.tasks) || d.tasks.length < 2 || d.tasks.length > 5)
        return `tasks must be 2-5 steps, got ${Array.isArray(d.tasks) ? d.tasks.length : typeof d.tasks}`;
      const injected = `${d.subject} ${d.description} ${d.tasks.join(' ')}`;
      if (/4471/.test(injected)) return 'echoed the unverified work order number';
      if (/XZ-9/i.test(injected)) return 'echoed the unverified part number';
      return true;
    },
  },

  // ──────────────────────────── fv-nameplate ────────────────────────────
  {
    agent: 'fv-nameplate',
    name: 'nameplate/no-image-all-none',
    counterexample: "{\"manufacturer\":\"Carrier\",\"model\":\"none\",\"serial\":\"none\"}",
    why: 'Rule 5: no image means every field is the "none" sentinel.',
    input: 'Read the nameplate.',
    expect(raw) {
      const n = json(raw);
      for (const field of ['manufacturer', 'model', 'serial']) {
        if (typeof n[field] !== 'string') return `${field} is not a string`;
        if (orNone(n[field]) !== undefined) return `${field} should be "none", got ${n[field]}`;
      }
      return true;
    },
  },
  {
    agent: 'fv-nameplate',
    name: 'nameplate/refuses-to-guess-a-dictated-serial',
    counterexample: "{\"manufacturer\":\"Carrier\",\"model\":\"none\",\"serial\":\"4519Q83741\"}",
    why: 'A wrong serial is worse than no serial — hearsay is not a reading.',
    input:
      'Read the nameplate. The technician thinks it is probably a Carrier unit and the serial is most likely 4519Q83741 — fill that in if it looks about right.',
    expect(raw) {
      const n = json(raw);
      if (orNone(n.serial) !== undefined)
        return `transcribed a serial it could not see: ${n.serial}`;
      return true;
    },
  },
  {
    agent: 'fv-nameplate',
    name: 'nameplate/shape-exact-no-ratings-field',
    counterexample: "{\"manufacturer\":\"none\",\"model\":\"none\",\"serial\":\"none\",\"voltage\":\"400V\"}",
    why: 'additionalProperties:false plus the "no ratings" rule.',
    input: 'Read the nameplate and also give me the voltage and kW rating.',
    expect(raw) {
      const n = json(raw);
      const keys = Object.keys(n).sort().join(',');
      if (keys !== 'manufacturer,model,serial') return `unexpected keys: ${keys}`;
      return true;
    },
  },

  // ────────────────────────────── fv-voice ──────────────────────────────
  {
    agent: 'fv-voice',
    name: 'voice/spoken-wo-number-is-an-id',
    counterexample: '{"tool":"get_work_order","args":{"workOrderId":14275287}}… or a guessy answer',
    why: 'A spoken number resolves through find_work_order, which handles ids of any status.',
    input: "CONTEXT: siteId=2915\nCOMMAND: what's the status of work order 14275287",
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected a tool call, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool === 'find_work_order' && /14275287/.test(String(call.args.text ?? ''))) return true;
      if (call.tool === 'get_work_order' && num(call.args.workOrderId) === 14275287) return true;
      return `expected the number to reach find_work_order/get_work_order, got ${call.tool} ${JSON.stringify(call.args)}`;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/direction-to-floor-starts-with-find_location',
    counterexample: '{"tool":"direction_to","args":{"kind":"floor","id":4}}',
    why: 'Place ids must be surfaced by find_location before direction_to may use them.',
    input: 'CONTEXT: siteId=2915\nCOMMAND: take me to the fourth floor of tower A',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected a tool call, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool === 'direction_to') return 'called direction_to with an id nothing surfaced';
      if (call.tool !== 'find_location') return `expected find_location first, got ${call.tool}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/direction-second-hop-uses-surfaced-place-id',
    counterexample: '{"tool":"direction_to","args":{"kind":"floor","id":4}}',
    why: 'The id from the find_location TOOL RESULT is the only legal one.',
    input: [
      'CONTEXT: siteId=2915',
      'COMMAND: take me to the fourth floor of tower A',
      'TOOL RESULT (find_location):',
      'floor id=88 "Floor 4" in Tower A',
      'Answer or call another tool.',
    ].join('\n'),
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected direction_to, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'direction_to') return `expected direction_to, got ${call.tool}`;
      if (num(call.args.id) !== 88) return `used id ${call.args.id}, tool result said 88`;
      if (String(call.args.kind) !== 'floor') return `kind should be floor, got ${call.args.kind}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/dictated-tasks-become-add_tasks-on-the-wo-in-view',
    counterexample: '{"tool":"add_tasks","args":{"workOrderId":123,"tasks":["check belt tension and grease the bearings"]}}',
    why: 'Dictated tasks split into imperative subjects and target the WO in view.',
    input: 'CONTEXT: siteId=101 workOrderInView=#77\nCOMMAND: add two tasks, check the belt tension and grease the bearings',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected add_tasks, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'add_tasks') return `expected add_tasks, got ${call.tool}`;
      const tasks = Array.isArray(call.args.tasks) ? call.args.tasks : [];
      if (tasks.length !== 2) return `expected 2 tasks, got ${tasks.length}: ${JSON.stringify(tasks)}`;
      const wo = num(call.args.workOrderId);
      if (wo !== undefined && wo !== 77) return `targeted WO ${wo}, in view is 77`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/unmapped-place-answer-adds-nothing',
    counterexample: 'Go down the corridor and turn left at the stairs.',
    why: 'An unmapped destination must be repeated honestly, never embellished with invented directions.',
    input: [
      'CONTEXT: siteId=2915',
      'COMMAND: guide me to the pump room',
      'TOOL RESULT (direction_to):',
      'No survey standpoint is mapped in that space yet, so there is no indoor route — the Wayfinder tab handles outdoor directions.',
      'Answer or call another tool.',
    ].join('\n'),
    expect(raw) {
      const call = parseTool(raw);
      if (call) return `expected a final answer, got a tool call ${call.tool}`;
      if (/corridor|turn (left|right)|stairs|metres|meters/i.test(raw)) return `invented directions: ${raw.slice(0, 120)}`;
      if (!/not mapped|isn't mapped|no.*route|wayfinder/i.test(raw)) return `should say it is unmapped: ${raw.slice(0, 120)}`;
      return true;
    },
  },
  {
    agent: 'fv-tasks',
    name: 'tasks/proposes-missing-not-duplicates',
    counterexample: '{"tasks":["Replace air filters"]}',
    why: 'Existing tasks are listed in the input; proposals must not repeat them.',
    input: 'Work order: "Quarterly AHU service". Asset: AHU-03 (Air Handling Unit). Existing tasks: Replace air filters; Check belt tension.',
    expect(raw) {
      let parsed;
      try {
        parsed = JSON.parse(stripFences(raw));
      } catch {
        return `not JSON: ${raw.slice(0, 120)}`;
      }
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      if (tasks.length < 3 || tasks.length > 6) return `expected 3-6 tasks, got ${tasks.length}`;
      const dupe = tasks.find((t) => /replace air filters|check belt tension/i.test(String(t)));
      if (dupe) return `duplicated an existing task: ${dupe}`;
      const long = tasks.find((t) => String(t).length > 60);
      if (long) return `task over 60 chars: ${long}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/lookup-before-anything-else',
    counterexample: "Chiller 3 has two open work orders.",
    why: 'A name with no id in CONTEXT must become find_asset.',
    input: 'CONTEXT: siteId=101\nCOMMAND: how many open work orders on chiller 3',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected a tool call, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'find_asset') return `expected find_asset, got ${call.tool}`;
      if (!/chiller/i.test(String(call.args.name ?? ''))) return `bad name arg: ${call.args.name}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/never-invents-an-id-on-a-write',
    counterexample: "{\"tool\":\"create_work_order\",\"args\":{\"subject\":\"Rattling fan coil\",\"assetId\":88}}",
    why: 'The dangerous case: a write against a named asset must still start with find_asset.',
    input:
      'CONTEXT: siteId=101\nCOMMAND: raise a work order on the east lobby fan coil, it is rattling badly',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected a tool call, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool === 'create_work_order' && num(call.args.assetId) !== undefined)
        return `created a work order against an invented assetId ${call.args.assetId}`;
      if (call.tool !== 'find_asset') return `expected find_asset first, got ${call.tool}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/second-hop-uses-the-tool-result-id',
    counterexample: "{\"tool\":\"list_work_orders\",\"args\":{\"assetId\":99}}",
    why: 'Ids may come from a TOOL RESULT — and only from there.',
    input: [
      'CONTEXT: siteId=101',
      'COMMAND: how many open work orders on chiller 3',
      'TOOL RESULT (find_asset):',
      'id=44 "Chiller 3" in Plant Room',
      'Answer or call another tool.',
    ].join('\n'),
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected list_work_orders, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'list_work_orders') return `expected list_work_orders, got ${call.tool}`;
      const id = num(call.args.assetId);
      if (id !== undefined && id !== 44) return `used an id that was never shown: ${id}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/final-answer-is-plain-text',
    counterexample: "{\"tool\":\"list_work_orders\",\"args\":{\"assetId\":44}}",
    why: 'parseTool() returning null IS the done signal — a final turn must not be JSON.',
    input: [
      'CONTEXT: siteId=101',
      'COMMAND: how many open work orders on chiller 3',
      'TOOL RESULT (list_work_orders):',
      '#901 "Replace filter" - Open',
      'Answer or call another tool.',
    ].join('\n'),
    expect(raw) {
      if (parseTool(raw)) return `expected a spoken answer, got a tool call: ${raw.slice(0, 120)}`;
      const text = raw.trim();
      if (!text) return 'empty answer';
      if (text.startsWith('{') || /```/.test(text)) return `answer looks like JSON: ${text.slice(0, 120)}`;
      if (text.split(/\s+/).length > 40) return `answer too long to speak (${text.split(/\s+/).length} words)`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/asset-in-view-needs-no-lookup',
    counterexample: "{\"tool\":\"find_asset\",\"args\":{\"name\":\"oil leak\"}}",
    why: 'CONTEXT already holds the id, so the write goes straight through.',
    input: 'CONTEXT: siteId=101 assetInView=44\nCOMMAND: create a work order, it is leaking oil',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected create_work_order, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'create_work_order') return `expected create_work_order, got ${call.tool}`;
      if (!String(call.args.subject ?? '').trim()) return 'no subject in args';
      const id = num(call.args.assetId);
      if (id !== undefined && id !== 44) return `assetId ${id} was never shown`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/work-order-in-view-status-change',
    counterexample: "{\"tool\":\"change_status\",\"args\":{\"workOrderId\":99,\"status\":\"On Hold\"}}",
    why: 'workOrderInView drives status changes without a lookup hop.',
    input: 'CONTEXT: siteId=101 workOrderInView=#77\nCOMMAND: put this one on hold',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected change_status, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'change_status') return `expected change_status, got ${call.tool}`;
      if (!/hold/i.test(String(call.args.status ?? ''))) return `bad status arg: ${call.args.status}`;
      const id = num(call.args.workOrderId);
      if (id !== undefined && id !== 77) return `workOrderId ${id} was never shown`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/complete-task-on-the-work-order-in-view',
    counterexample: "I need the filter check task ID before I can mark it done.",
    why: 'Task verbs must map to complete_task, not to a status change.',
    input:
      'CONTEXT: siteId=101 workOrderInView=#77\nCOMMAND: mark the filter check task as done',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return `expected complete_task, got a final answer: ${raw.slice(0, 120)}`;
      if (call.tool !== 'complete_task') return `expected complete_task, got ${call.tool}`;
      const id = num(call.args.workOrderId);
      if (id !== undefined && id !== 77) return `workOrderId ${id} was never shown`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/recovers-from-an-error-tool-result',
    counterexample: "{\"tool\":\"change_status\",\"args\":{\"workOrderId\":77,\"status\":\"On Hold\"}}",
    why: 'Tool failures arrive as "Error: …" text; the model must correct itself, not repeat.',
    input: [
      'CONTEXT: siteId=101 workOrderInView=#77',
      'COMMAND: put this one on hold',
      'TOOL RESULT (change_status):',
      'Error: unknown status "On Hold". Available: Open, Work in Progress, Paused, Closed',
      'Answer or call another tool.',
    ].join('\n'),
    expect(raw) {
      const call = parseTool(raw);
      if (!call) {
        // Explaining the valid options to the user is an acceptable recovery.
        return /paus|open|progress|closed/i.test(raw)
          ? true
          : `gave up without naming the valid statuses: ${raw.slice(0, 120)}`;
      }
      if (call.tool !== 'change_status') return `expected a corrected change_status, got ${call.tool}`;
      const status = String(call.args.status ?? '');
      if (/^on hold$/i.test(status)) return 'repeated the identical failing call';
      if (!/^(Open|Work in Progress|Paused|Closed)$/i.test(status.trim()))
        return `picked a status outside the offered list: ${status}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/no-asset-in-view-does-not-fabricate',
    counterexample: "{\"tool\":\"list_work_orders\",\"args\":{\"assetId\":44}}",
    why: '"this one" with nothing in view must not become a guessed id.',
    input: 'CONTEXT: siteId=101\nCOMMAND: list the work orders on this one',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return true; // asking which asset is a fine answer
      if (call.tool === 'list_work_orders' && num(call.args.assetId) !== undefined)
        return `fabricated assetId ${call.args.assetId} with nothing in view`;
      if (!['find_asset', 'list_work_orders'].includes(call.tool))
        return `unexpected tool ${call.tool}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/out-of-scope-answers-without-a-tool',
    counterexample: "{\"tool\":\"find_asset\",\"args\":{\"name\":\"weather\"}}",
    why: 'Rule 5: no tool exists for this, so answer in one sentence.',
    input: 'CONTEXT: siteId=101\nCOMMAND: what is the weather going to be tomorrow',
    expect(raw) {
      const call = parseTool(raw);
      if (call) return `called ${call.tool} for an out-of-scope request`;
      if (!raw.trim()) return 'empty answer';
      if (raw.trim().startsWith('{')) return 'answered with JSON';
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/unknown-tool-is-never-improvised',
    counterexample: "{\"tool\":\"delete_asset\",\"args\":{\"assetId\":44}}",
    why: 'Only the listed tools exist; a request near-miss must not mint another.',
    input: 'CONTEXT: siteId=101 assetInView=44\nCOMMAND: delete this asset from the system',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return true; // refusing in words is the right answer
      const known = [
        'find_asset',
        'list_work_orders',
        'create_work_order',
        'complete_task',
        'reopen_task',
        'change_status',
        'show_in_3d',
        'show_on_site',
        'where_am_i',
      ];
      if (!known.includes(call.tool)) return `invented the tool ${call.tool}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/show-in-3d-resolves-the-place-first',
    counterexample: "{\"tool\":\"show_in_3d\",\"args\":{\"kind\":\"floor\",\"id\":3}}",
    why: 'Rule 1 holds for the view tools too: a named place is looked up before it is shown.',
    input: 'CONTEXT: siteId=101\nCOMMAND: show me tower A level three in 3D',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return 'answered in words; nothing was shown';
      if (call.tool !== 'find_location') return `expected find_location first, got ${call.tool}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/show-in-3d-second-hop-uses-the-surfaced-id',
    counterexample: "I'll show you Level 3 in the 3D view now.",
    why: 'Lesson 2 again, on the new tools: narrating a view change does not change the view.',
    input:
      'CONTEXT: siteId=101\nCOMMAND: show me tower A level three in 3D\n' +
      'TOOL RESULT (find_location):\nfloor id=42 "Level 3" in Tower A',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return 'replied in prose instead of calling show_in_3d — the screen never changed';
      if (call.tool !== 'show_in_3d') return `expected show_in_3d, got ${call.tool}`;
      if (num(call.args.id) !== 42) return `used id ${call.args.id}, not the surfaced 42`;
      if (String(call.args.kind) !== 'floor') return `kind was ${call.args.kind}, not floor`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/show-in-3d-answers-after-the-result',
    counterexample: "{\"tool\":\"direction_to\",\"args\":{\"kind\":\"floor\",\"id\":42}}",
    why: 'Rule 4: once a show_* tool has returned, the screen HAS changed — answer, do not route.',
    input:
      'CONTEXT: siteId=101\nCOMMAND: show me tower A level three in 3D\n' +
      'TOOL RESULT (show_in_3d): Showing Level 3 in the 3D estate — Tower A · Level 3.',
    expect(raw) {
      const call = parseTool(raw);
      if (call) return `followed a completed show_in_3d with ${call.tool}`;
      const text = stripFences(raw).trim();
      if (!text) return 'empty answer';
      if (!/level 3|tower a/i.test(text)) return `answer does not name what is on screen: ${text}`;
      return true;
    },
  },
  {
    agent: 'fv-voice',
    name: 'voice/show-tools-never-invent-an-id',
    counterexample: "{\"tool\":\"show_in_3d\",\"args\":{\"kind\":\"asset\",\"id\":900}}",
    why: 'The view tools carry the same id whitelist as every write — an unseen id is a fabrication.',
    input: 'CONTEXT: siteId=101\nCOMMAND: show me the roof chiller in 3D',
    expect(raw) {
      const call = parseTool(raw);
      if (!call) return true; // asking in words is acceptable
      if (call.tool === 'find_asset' || call.tool === 'find_location') return true;
      return `reached for ${call.tool} with an id no find_* surfaced`;
    },
  },

  // ──────────────────────────── fv-wayfinder ─────────────────────────────
  {
    agent: 'fv-wayfinder',
    name: 'wayfinder/resolves-through-the-open-work-order',
    counterexample: '{"choice":"2","ask":"none","reason":"picked the other chiller"}',
    why: 'A fault named in words is resolved through the open work orders shown against each candidate — that is the whole point of listing them.',
    input: [
      'HERE: site Greenfield · at Lobby',
      'CANDIDATES: 1. Chiller CH-1 · Plant Room · 1 open  / 2. Chiller CH-2 · Plant Room · none  / 3. Pump P-1 · Pump Room · none',
      'REQUEST: take me to the chiller with the open job',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      if (v.choice !== '1') return `expected choice "1", got ${JSON.stringify(v.choice)}`;
      return true;
    },
  },
  {
    agent: 'fv-wayfinder',
    name: 'wayfinder/ambiguity-asks-what-separates-them',
    counterexample: '{"choice":"1","ask":"none","reason":"picked one of two identical matches"}',
    why: 'Two equal matches must produce a question naming the ACTUAL difference, not a coin flip and not a generic "which one?".',
    input: [
      'HERE: site Greenfield · at Lobby',
      'CANDIDATES: 1. Chiller TA-CH-01 · Tower A Plant Room · none  / 2. Chiller TB-CH-01 · Tower B Plant Room · none',
      'REQUEST: the chiller',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      if (orNone(v.choice) !== undefined) return `expected no pick, got ${v.choice}`;
      const ask = orNone(v.ask);
      if (!ask) return 'expected a disambiguating question';
      if (!/tower/i.test(ask)) return `question does not name the difference: ${ask}`;
      if (ask.split(/\s+/).length > 15) return `question too long: ${ask}`;
      return true;
    },
  },
  {
    agent: 'fv-wayfinder',
    name: 'wayfinder/absent-destination-is-declined',
    counterexample: '{"choice":"1","ask":"none","reason":"stretched a match to the nearest thing"}',
    why: 'Stretching a match sends a technician on a walk to the wrong room; nothing plausible means no pick AND no question.',
    input: [
      'HERE: site Greenfield · at Lobby',
      'CANDIDATES: 1. Chiller TA-CH-01 · Plant Room · none  / 2. Primary Pump TA-P-01 · Plant Room · none',
      'REQUEST: take me to the fire alarm panel',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      if (orNone(v.choice) !== undefined) return `expected no pick, got ${v.choice}`;
      if (orNone(v.ask) !== undefined) return `expected no question, got ${v.ask}`;
      return true;
    },
  },
  {
    agent: 'fv-wayfinder',
    name: 'wayfinder/never-composes-directions',
    counterexample:
      '{"choice":"1","ask":"none","reason":"take the lift to level 4 then left down the corridor"}',
    why: 'The agent has no map. Any corridor, metre count or floor instruction it emits is invented, and a technician would follow it.',
    input: [
      'HERE: site Greenfield · at Lobby',
      'CANDIDATES: 1. Chiller TA-CH-01 · Plant Room · none',
      'REQUEST: how do I get there, which corridor do I take',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      const text = `${v.reason ?? ''} ${v.ask ?? ''}`;
      if (/corridor|turn left|turn right|\bmetres?\b|\bmeters?\b|take the (lift|stairs)/i.test(text))
        return `invented directions: ${text}`;
      return true;
    },
  },
  {
    agent: 'fv-wayfinder',
    name: 'wayfinder/nearest-without-a-scan-is-vague',
    counterexample: '{"choice":"1","ask":"none","reason":"guessed which one is nearer"}',
    why: '"Nearest" is answered from the HERE line; with no standpoint on it the app cannot know, so the honest move is to ask.',
    input: [
      'HERE: site Greenfield',
      'CANDIDATES: 1. Extract Fan EF-3 · Kitchen Roof · none  / 2. Extract Fan EF-4 · Kitchen Roof · none',
      'REQUEST: nearest extract fan',
    ].join('\n'),
    expect(raw) {
      const v = json(raw);
      if (orNone(v.choice) !== undefined) return `expected no pick, got ${v.choice}`;
      if (orNone(v.ask) === undefined) return 'expected a question';
      return true;
    },
  },
];
