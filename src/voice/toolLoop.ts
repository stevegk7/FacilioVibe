/**
 * Client-side agent tool loop.
 * Lifted from "/Users/rajkumars/Documents/Fun projects/asset-lens/src/ar/voiceAgent.ts"
 * and kept protocol-identical — only the tool set and the id-validation are new.
 *
 * The protocol, exactly:
 *  - the agent replies EITHER a tool call `{"tool":"…","args":{…}}` (optionally
 *    fenced) OR a sentence for the user. parseTool() returning null IS the
 *    "final answer" signal — there is no separate done marker;
 *  - tools run in the CLIENT, against the provider seam. The agent has no
 *    server-side tools and no org credentials of its own;
 *  - tool failures come back as `Error: …` STRINGS inside the transcript rather
 *    than exceptions, so the model reads what went wrong and self-corrects on
 *    the next hop (an unknown status is answered with the valid list);
 *  - a CONTEXT: line carries siteId / assetInView / workOrderInView so the user
 *    can say "this one"; ids in args win, context is the fallback;
 *  - MAX_HOPS caps the loop — still calling tools after that is a stuck model,
 *    answered with a plain apology rather than another round trip.
 *
 * Fabrication guard (new here, same spirit as agents.ts): create_work_order is
 * refused if it names an assetId the app never showed it. Models invent ids;
 * writes must not carry an invented one.
 */
import type { VoiceDeps } from './deps';

export const MAX_HOPS = 4;

export interface VoiceCtx {
  siteId?: number;
  assetInView?: number;
  workOrderInView?: number;
}

export interface ToolLogEntry {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface ToolLoopResult {
  answer: string;
  tools: ToolLogEntry[];
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Strict: fenced-or-plain `{...}` with a string `.tool`. Anything else → null. */
export function parseTool(reply: string): ToolCall | null {
  let text = reply.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(text) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool !== 'string') return null;
    const args =
      parsed.args && typeof parsed.args === 'object'
        ? (parsed.args as Record<string, unknown>)
        : {};
    return { tool: parsed.tool, args };
  } catch {
    return null;
  }
}

/** Models emit ids as both numbers and numeric strings. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function contextLine(ctx: VoiceCtx): string {
  return (
    `CONTEXT: siteId=${ctx.siteId ?? 'unknown'}` +
    (ctx.assetInView ? ` assetInView=${ctx.assetInView}` : '') +
    (ctx.workOrderInView ? ` workOrderInView=#${ctx.workOrderInView}` : '')
  );
}

interface Seen {
  /** Asset ids this loop has actually surfaced — the write whitelist. */
  assets: Set<number>;
  /** Work-order ids surfaced — the add_tasks whitelist. */
  workOrders: Set<number>;
  /** Location hits surfaced — direction_to's whitelist, keyed kind:id. */
  places: Set<string>;
}

async function runTool(
  call: ToolCall,
  ctx: VoiceCtx,
  deps: VoiceDeps,
  seen: Seen,
): Promise<string> {
  const seenAssetIds = seen.assets;
  try {
    switch (call.tool) {
      case 'find_asset': {
        const name = String(call.args.name ?? '').trim();
        if (!name) return 'Error: find_asset needs a name.';
        const rows = (await deps.searchAssets({ text: name })).slice(0, 3);
        rows.forEach((a) => seenAssetIds.add(a.id));
        if (rows.length === 0) return `No assets match "${name}".`;
        return rows
          .map((a) => `id=${a.id} "${a.name}"${a.spaceName ? ` in ${a.spaceName}` : ''}`)
          .join('\n');
      }

      case 'list_work_orders': {
        const assetId = num(call.args.assetId) ?? ctx.assetInView;
        if (!assetId) return 'Error: no asset in view — call find_asset first.';
        const rows = (await deps.listWorkOrdersForAssets([assetId])).slice(0, 6);
        if (rows.length === 0) return `No work orders on asset ${assetId}.`;
        return rows.map((w) => `#${w.id} "${w.subject}" · ${w.status ?? '—'}`).join('\n');
      }

      case 'find_work_order': {
        const text = String(call.args.text ?? '').trim().toLowerCase();
        // a bare number (or #number) is an ID, not a phrase — fetch directly,
        // whatever its status
        const idAsked = num(text.replace(/^#/, ''));
        if (idAsked !== undefined) {
          const wo = await deps.getWorkOrder(idAsked);
          if (!wo) return `No work order #${idAsked}.`;
          seen.workOrders.add(wo.id);
          if (wo.resourceId) seenAssetIds.add(wo.resourceId);
          return `#${wo.id} "${wo.subject}" · ${wo.status ?? '—'} · asset ${wo.resourceId ?? '—'} ${wo.resourceName ?? ''}`.trim();
        }
        const rows = await deps.listOpenWorkOrders();
        const hits = (text
          ? rows.filter(
              (w) =>
                w.subject.toLowerCase().includes(text) ||
                (w.resourceName ?? '').toLowerCase().includes(text),
            )
          : rows
        ).slice(0, 6);
        if (hits.length === 0) return 'No open work orders match that.';
        // Ids surfaced here become navigable — same whitelist the create guard uses.
        for (const w of hits) {
          seen.workOrders.add(w.id);
          if (w.resourceId) seenAssetIds.add(w.resourceId);
        }
        return hits
          .map(
            (w) =>
              `#${w.id} "${w.subject}" · asset ${w.resourceId ?? '—'} ${w.resourceName ?? ''}`.trim(),
          )
          .join('\n');
      }

      case 'get_work_order': {
        const id = num(call.args.workOrderId) ?? ctx.workOrderInView;
        if (!id) return 'Error: get_work_order needs a workOrderId.';
        const wo = await deps.getWorkOrder(id);
        if (!wo) return `No work order #${id}.`;
        seen.workOrders.add(wo.id);
        if (wo.resourceId) seenAssetIds.add(wo.resourceId);
        const tasks = await deps.listWorkOrderTasks(id).catch(() => []);
        const taskLine = tasks.length
          ? tasks.map((t) => `${t.closed ? '[x]' : '[ ]'} ${t.id} ${t.subject}`).join('; ')
          : 'none';
        return [
          `#${wo.id} "${wo.subject}" · ${wo.status ?? '—'}`,
          wo.priority ? `priority ${wo.priority}` : '',
          wo.assignedTo ? `assigned ${wo.assignedTo}` : '',
          `tasks: ${taskLine}`,
        ]
          .filter(Boolean)
          .join(' · ');
      }

      case 'find_location': {
        const text = String(call.args.text ?? '').trim();
        if (!text) return 'Error: find_location needs a name or id.';
        const hits = await deps.findLocations(text);
        if (hits.length === 0) return `No sites, buildings, floors or spaces match "${text}".`;
        for (const h of hits) seen.places.add(`${h.kind}:${h.id}`);
        return hits
          .map((h) => `${h.kind} id=${h.id} "${h.name}"${h.parent ? ` in ${h.parent}` : ''}`)
          .join('\n');
      }

      case 'direction_to': {
        const kind = String(call.args.kind ?? '').trim().toLowerCase();
        const id = num(call.args.id);
        if (kind === 'asset') {
          // assets keep their own richer lane
          return runTool({ tool: 'navigate_to', args: { assetId: call.args.id } }, ctx, deps, seen);
        }
        if (!['site', 'building', 'floor', 'space'].includes(kind) || id === undefined) {
          return 'Error: direction_to needs kind (site|building|floor|space|asset) and id.';
        }
        if (!seen.places.has(`${kind}:${id}`)) {
          return `Error: ${kind} ${id} was never shown to you — call find_location first and use an id from its result.`;
        }
        const route = await deps.routeToPlace({ kind: kind as 'site' | 'building' | 'floor' | 'space', id });
        if (!route) {
          return `No survey standpoint is mapped in that ${kind} yet, so there is no indoor route — the Wayfinder tab handles outdoor directions.`;
        }
        if (route.steps.length === 0) {
          return `${route.destination} is the destination, but no mapped path leads there yet — connect it in the Wayfinder graph.`;
        }
        return `Route to ${route.destination}: ${route.steps.join(' then ')}`;
      }

      case 'add_tasks': {
        const workOrderId = num(call.args.workOrderId) ?? ctx.workOrderInView;
        if (!workOrderId) return 'Error: no work order in view — call find_work_order first.';
        if (workOrderId !== ctx.workOrderInView && !seen.workOrders.has(workOrderId)) {
          return `Error: work order ${workOrderId} was never shown to you — call find_work_order or get_work_order first.`;
        }
        const raw = call.args.tasks;
        const subjects = (Array.isArray(raw) ? raw : [raw])
          .map((t) => String(t ?? '').trim())
          .filter(Boolean)
          .slice(0, 10);
        if (subjects.length === 0) return 'Error: add_tasks needs a tasks array of subjects.';
        const ids: number[] = [];
        for (const subject of subjects) ids.push(await deps.addWorkOrderTask(workOrderId, subject));
        return `Added ${ids.length} task${ids.length === 1 ? '' : 's'} to #${workOrderId}: ${subjects.join('; ')}.`;
      }

      case 'navigate_to': {
        const asked = num(call.args.assetId);
        if (asked === undefined) return 'Error: navigate_to needs an assetId.';
        if (asked !== ctx.assetInView && !seenAssetIds.has(asked)) {
          return `Error: asset ${asked} was never shown to you — call find_asset or find_work_order first and use an id from its result.`;
        }
        const route = await deps.routeToAsset(asked);
        if (!route) {
          return `Asset ${asked} is not pinned in any survey, so there is no route to it yet.`;
        }
        if (route.steps.length === 0) {
          return `${route.destination} is the destination, but no mapped path leads there yet — connect it in the Wayfinder graph.`;
        }
        return `Route to ${route.destination}: ${route.steps.join(' then ')}`;
      }

      case 'create_work_order': {
        const subject = String(call.args.subject ?? '').trim();
        if (!subject) return 'Error: create_work_order needs a subject.';
        const asked = num(call.args.assetId);
        if (asked !== undefined && asked !== ctx.assetInView && !seenAssetIds.has(asked)) {
          return `Error: asset ${asked} was never shown to you — call find_asset and use an id from its result, or omit assetId to use the asset in view.`;
        }
        const resourceId = asked ?? ctx.assetInView;
        const id = await deps.createWorkOrder({
          subject,
          description: call.args.description ? String(call.args.description) : undefined,
          resourceId,
          siteId: ctx.siteId,
        });
        return `Created work order #${id}.`;
      }

      case 'complete_task':
      case 'reopen_task': {
        const workOrderId = num(call.args.workOrderId) ?? ctx.workOrderInView;
        if (!workOrderId) return 'Error: no work order in view.';
        const tasks = await deps.listWorkOrderTasks(workOrderId);
        const taskId = num(call.args.taskId);
        const hit =
          tasks.find((t) => t.id === taskId) ?? (tasks.length === 1 ? tasks[0] : undefined);
        if (!hit) {
          return `Error: no task ${call.args.taskId ?? ''} on #${workOrderId}. Tasks: ${
            tasks.map((t) => `${t.id} "${t.subject}"`).join('; ') || 'none'
          }`;
        }
        const closed = call.tool === 'complete_task';
        await deps.setTaskStatus(workOrderId, hit.id, closed);
        return `Task "${hit.subject}" ${closed ? 'completed' : 'reopened'}.`;
      }

      case 'change_status': {
        const workOrderId = num(call.args.workOrderId) ?? ctx.workOrderInView;
        if (!workOrderId) return 'Error: no work order in view.';
        const wanted = String(call.args.status ?? '').trim().toLowerCase();
        const statuses = await deps.getStatuses();
        const hit = statuses.find(
          (s) => s.value.toLowerCase() === wanted || s.label.toLowerCase() === wanted,
        );
        if (!hit) {
          return `Error: unknown status "${call.args.status ?? ''}". Available: ${statuses
            .map((s) => s.label)
            .join(', ')}`;
        }
        await deps.changeStatus(workOrderId, hit.value);
        return `#${workOrderId} is now ${hit.label}.`;
      }

      /* ---- the two view-driving tools ----
         Everything above resolves or writes; these MOVE THE APP. That is why
         show_on_site is not folded into direction_to: direction_to is read-only
         and safe to call speculatively, so merging them would let a question
         ("how do I get to the chiller?") yank a technician out of the camera.
         Both navigate BEFORE returning, so the sentence the model speaks
         describes what is already on screen. */
      case 'show_in_3d': {
        const kind = String(call.args.kind ?? 'asset').trim().toLowerCase();
        const id = num(call.args.id);
        if (id === undefined || !['asset', 'space', 'floor', 'building'].includes(kind)) {
          return 'Error: show_in_3d needs kind (asset|space|floor|building) and id.';
        }
        const known =
          kind === 'asset'
            ? id === ctx.assetInView || seenAssetIds.has(id)
            : seen.places.has(`${kind}:${id}`);
        if (!known) {
          return `Error: ${kind} ${id} was never shown to you — call find_asset or find_location first and use an id from its result.`;
        }
        return deps.showInEstate({ kind: kind as 'asset' | 'space' | 'floor' | 'building', id });
      }

      case 'show_on_site': {
        const asked = num(call.args.assetId) ?? ctx.assetInView;
        if (asked === undefined) return 'Error: show_on_site needs an assetId.';
        if (asked !== ctx.assetInView && !seenAssetIds.has(asked)) {
          return `Error: asset ${asked} was never shown to you — call find_asset first and use an id from its result.`;
        }
        return deps.showOnSite(asked);
      }

      case 'where_am_i': {
        const place = await deps.currentPlace();
        const label = [place.floorName, place.buildingName, place.siteName].filter(Boolean).join(', ');
        if (!label) return 'No location scope set yet.';
        return `Scope: ${label}.${place.localizedAt ? ` Standing at ${place.localizedAt}.` : ' Not localized in AR.'}`;
      }

      default:
        return `Error: unknown tool ${call.tool}. Available: find_asset, find_work_order, get_work_order, find_location, direction_to, navigate_to, list_work_orders, create_work_order, add_tasks, complete_task, reopen_task, change_status, show_in_3d, show_on_site, where_am_i.`;
    }
  } catch (err) {
    // Failures re-enter the transcript as text; the model gets to try again.
    return `Error: ${err instanceof Error ? err.message : 'tool failed'}`;
  }
}

export async function runToolLoop(
  text: string,
  ctx: VoiceCtx,
  deps: VoiceDeps,
  onTool?: (entry: ToolLogEntry) => void,
): Promise<ToolLoopResult> {
  const line = contextLine(ctx);
  const tools: ToolLogEntry[] = [];
  const seen: Seen = { assets: new Set(), workOrders: new Set(), places: new Set() };
  if (ctx.assetInView) seen.assets.add(ctx.assetInView);
  if (ctx.workOrderInView) seen.workOrders.add(ctx.workOrderInView);

  try {
    let reply = await deps.voiceTurn(`${line}\nCOMMAND: ${text}`);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const call = parseTool(reply);
      if (!call) break;
      const result = await runTool(call, ctx, deps, seen);
      const entry: ToolLogEntry = { tool: call.tool, args: call.args, result };
      tools.push(entry);
      onTool?.(entry);
      reply = await deps.voiceTurn(
        `${line}\nCOMMAND: ${text}\nTOOL RESULT (${call.tool}):\n${result}\nAnswer or call another tool.`,
      );
    }
    const answer = parseTool(reply) ? 'I could not finish that — try rephrasing.' : reply.trim();
    deps.speak(answer);
    return { answer, tools };
  } catch (err) {
    // The agent seam itself failed (no content, network, bad JSON upstream).
    // Voice must never throw into the UI — it answers, badly, and moves on.
    const answer = `Sorry — the assistant is unavailable (${
      err instanceof Error ? err.message : 'unknown error'
    }).`;
    return { answer, tools };
  }
}
