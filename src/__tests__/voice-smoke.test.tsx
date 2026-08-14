// voice-smoke (WS-C): the local intent ladder, the client-side tool loop
// (including its two refusals), the report-a-fault pipeline, and the sheet.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { matchIntent, type VoiceAction, type VoiceUiVerb } from '../voice/intents';
import { MAX_HOPS, parseTool, runToolLoop } from '../voice/toolLoop';
import { runReportFault, type FaultStage } from '../voice/reportFault';
import VoiceSheet from '../screens/VoiceSheet';
import { LocationProvider } from '../state/LocationContext';
import { fakeDeps, scriptedTurns } from './wsC-fakes';

const STATUSES = [
  { label: 'Open', value: 'Open' },
  { label: 'In Progress', value: 'In Progress' },
  { label: 'On Hold', value: 'On Hold' },
  { label: 'Closed', value: 'Closed' },
];

describe('matchIntent — the zero-latency ladder', () => {
  const withWo = { statuses: STATUSES, workOrderInView: 900 };

  it('(a) a spoken status name transitions the work order in view', () => {
    expect(matchIntent('mark it closed', withWo)).toEqual<VoiceAction>({
      type: 'change_status',
      workOrderId: 900,
      status: 'Closed',
      label: 'Closed',
    });
    expect(matchIntent('set it to in progress', withWo)).toMatchObject({ status: 'In Progress' });
  });

  it('(a) needs a work order in view — otherwise it falls through', () => {
    expect(matchIntent('mark it closed', { statuses: STATUSES })).toBeNull();
  });

  it('(b) phrase aliases map to the progress / hold statuses', () => {
    expect(matchIntent('start work', withWo)).toMatchObject({ status: 'In Progress' });
    expect(matchIntent('begin work on this', withWo)).toMatchObject({ status: 'In Progress' });
    expect(matchIntent('pause that', withWo)).toMatchObject({ status: 'On Hold' });
    expect(matchIntent('put it on hold', withWo)).toMatchObject({ status: 'On Hold' });
  });

  it('(b) with no matching status in the catalogue, falls through', () => {
    const thin = { statuses: [{ label: 'Open', value: 'Open' }], workOrderInView: 900 };
    expect(matchIntent('start work', thin)).toBeNull();
  });

  it('(c) UI verbs need no record', () => {
    const bare = { statuses: STATUSES };
    const table: Array<[string, VoiceUiVerb]> = [
      ['rescan', 'rescan'],
      ['scan again', 'rescan'],
      ['next', 'rescan'],
      ['minimize', 'minimize'],
      ['minimise the panel', 'minimize'],
      ['expand', 'expand'],
      ['maximise', 'expand'],
      ['pin the card', 'pin'],
      ['pin work order', 'pin'],
      ['place here', 'pin'],
      ['show tasks', 'tasks'],
      ['checklist', 'tasks'],
      ['clear board', 'clear'],
      ['clear all', 'clear'],
    ];
    for (const [said, verb] of table) {
      expect(matchIntent(said, bare)).toEqual<VoiceAction>({ type: 'ui', verb });
    }
  });

  it('(d) misses return null so the agent loop gets them', () => {
    const bare = { statuses: STATUSES };
    expect(matchIntent('what work orders are open on the chiller', bare)).toBeNull();
    expect(matchIntent('how old is this pump', bare)).toBeNull();
    expect(matchIntent('', bare)).toBeNull();
    expect(matchIntent('   ', bare)).toBeNull();
  });
});

describe('parseTool — null IS the final-answer signal', () => {
  it('accepts plain and fenced tool objects', () => {
    expect(parseTool('{"tool":"find_asset","args":{"name":"AHU"}}')).toEqual({
      tool: 'find_asset',
      args: { name: 'AHU' },
    });
    expect(parseTool('```json\n{"tool":"find_asset"}\n```')).toEqual({
      tool: 'find_asset',
      args: {},
    });
  });

  it('returns null for sentences, non-objects and missing/!string tool', () => {
    expect(parseTool('The chiller has two open work orders.')).toBeNull();
    expect(parseTool('[1,2]')).toBeNull();
    expect(parseTool('{"args":{}}')).toBeNull();
    expect(parseTool('{"tool":42}')).toBeNull();
    expect(parseTool('{ broken')).toBeNull();
  });
});

describe('runToolLoop', () => {
  it('runs change_status against a validated status and speaks the final answer', async () => {
    const deps = fakeDeps({
      voiceTurn: scriptedTurns([
        '{"tool":"change_status","args":{"workOrderId":900,"status":"on hold"}}',
        'Work order 900 is on hold.',
      ]),
    });
    const result = await runToolLoop('put 900 on hold', { siteId: 5 }, deps);

    expect(deps.changeStatus).toHaveBeenCalledTimes(1);
    // the internal VALUE from the catalogue, not the words the model used
    expect(deps.changeStatus).toHaveBeenCalledWith(900, 'On Hold');
    expect(result.answer).toBe('Work order 900 is on hold.');
    expect(deps.speak).toHaveBeenCalledWith('Work order 900 is on hold.');
    expect(result.tools).toHaveLength(1);
  });

  it('feeds a tool error back so the next reply can answer', async () => {
    const turns = scriptedTurns([
      '{"tool":"change_status","args":{"workOrderId":900,"status":"Frobnicated"}}',
      'That status does not exist — the valid ones are Open, In Progress, On Hold and Closed.',
    ]);
    const deps = fakeDeps({ voiceTurn: turns });
    const result = await runToolLoop('frobnicate it', {}, deps);

    expect(deps.changeStatus).not.toHaveBeenCalled();
    expect(result.tools[0].result).toContain('unknown status');
    expect(result.tools[0].result).toContain('On Hold'); // the available list
    // the error string went back into the transcript verbatim
    expect(String(turns.mock.calls[1][0])).toContain('TOOL RESULT (change_status)');
    expect(String(turns.mock.calls[1][0])).toContain('unknown status');
    expect(result.answer).toContain('valid ones');
  });

  it('injects the CONTEXT: line and falls back to it when args omit the id', async () => {
    const turns = scriptedTurns([
      '{"tool":"list_work_orders","args":{}}',
      'One open work order.',
    ]);
    const deps = fakeDeps({
      voiceTurn: turns,
      listWorkOrdersForAssets: vi.fn(async () => [{ id: 1, subject: 'Belt', status: 'Open' }]),
    });
    await runToolLoop('any work orders on this', { siteId: 5, assetInView: 33, workOrderInView: 900 }, deps);

    const prompt = String(turns.mock.calls[0][0]);
    expect(prompt).toContain('CONTEXT: siteId=5');
    expect(prompt).toContain('assetInView=33');
    expect(prompt).toContain('workOrderInView=#900');
    expect(deps.listWorkOrdersForAssets).toHaveBeenCalledWith([33]);
  });

  it('stops at MAX_HOPS when the model will not stop calling tools', async () => {
    const turns = scriptedTurns(['{"tool":"find_asset","args":{"name":"AHU"}}']);
    const deps = fakeDeps({ voiceTurn: turns });
    const result = await runToolLoop('find things forever', {}, deps);

    expect(result.tools).toHaveLength(MAX_HOPS);
    expect(turns).toHaveBeenCalledTimes(MAX_HOPS + 1);
    expect(result.answer).toBe('I could not finish that — try rephrasing.');
  });

  it('refuses create_work_order with an assetId it was never shown', async () => {
    const turns = scriptedTurns([
      '{"tool":"create_work_order","args":{"subject":"Leak","assetId":8888}}',
      'I need to look that asset up first.',
    ]);
    const deps = fakeDeps({ voiceTurn: turns });
    const result = await runToolLoop('raise a WO on asset 8888', { siteId: 5 }, deps);

    expect(deps.createWorkOrder).not.toHaveBeenCalled();
    expect(result.tools[0].result).toMatch(/never shown/);
  });

  it('allows an assetId that find_asset returned in this loop', async () => {
    const turns = scriptedTurns([
      '{"tool":"find_asset","args":{"name":"AHU"}}',
      '{"tool":"create_work_order","args":{"subject":"Leak","assetId":501}}',
      'Created it.',
    ]);
    const deps = fakeDeps({
      voiceTurn: turns,
      searchAssets: vi.fn(async () => [{ id: 501, name: 'AHU-1', spaceName: 'Roof' }]),
    });
    const result = await runToolLoop('raise a leak WO on the AHU', { siteId: 5 }, deps);

    expect(deps.createWorkOrder).toHaveBeenCalledWith({
      subject: 'Leak',
      description: undefined,
      resourceId: 501,
      siteId: 5,
    });
    expect(result.answer).toBe('Created it.');
  });
});

describe('runReportFault', () => {
  const photo = new Blob(['jpeg'], { type: 'image/jpeg' });

  it('walks the stages in order and creates the WO against the identified asset', async () => {
    const stages: FaultStage[] = [];
    const deps = fakeDeps({
      searchAssets: vi.fn(async () => [
        { id: 601, name: 'Pump A' },
        { id: 602, name: 'Pump B' },
      ]),
      identifyAsset: vi.fn(async () => ({ assetId: 602, confidence: 0.9, reason: 'label' })),
    });
    const result = await runReportFault(
      photo,
      { scope: { siteId: 5 }, names: { site: 'HQ', space: 'Plant Room' } },
      deps,
      (stage) => stages.push(stage),
    );

    expect(stages).toEqual(['uploading', 'drafting', 'identifying', 'creating', 'done']);
    expect(deps.uploadPhoto).toHaveBeenCalled();
    // the draft prompt carries names, not bare ids
    expect(String((deps.draftWorkOrder as ReturnType<typeof vi.fn>).mock.calls[0][1])).toContain('HQ');
    expect(deps.identifyAsset).toHaveBeenCalledWith([77], [
      { id: 601, name: 'Pump A' },
      { id: 602, name: 'Pump B' },
    ]);
    expect(deps.createWorkOrder).toHaveBeenCalledWith({
      subject: 'Leaking flange',
      description: 'Water pooling under the unit.',
      resourceId: 602,
      siteId: 5,
    });
    expect(result.workOrderId).toBe(4242);
    expect(deps.speak).toHaveBeenCalled();
  });

  it('uses the asset in view as the sole candidate', async () => {
    const deps = fakeDeps({
      identifyAsset: vi.fn(async () => ({ assetId: 700, confidence: 0.8, reason: 'match' })),
    });
    const result = await runReportFault(
      photo,
      { scope: { siteId: 5 }, assetInView: { id: 700, name: 'Chiller 1' } },
      deps,
    );
    expect(deps.searchAssets).not.toHaveBeenCalled();
    expect(result.assetId).toBe(700);
  });

  it('returns needsConfirm and creates NOTHING when identification is ambiguous', async () => {
    const stages: FaultStage[] = [];
    const deps = fakeDeps({
      searchAssets: vi.fn(async () => [
        { id: 601, name: 'Pump A' },
        { id: 602, name: 'Pump B' },
      ]),
      identifyAsset: vi.fn(async () => ({ assetId: null, confidence: 0.2, reason: 'two similar' })),
    });
    const result = await runReportFault(photo, { scope: { siteId: 5 } }, deps, (s) => stages.push(s));

    expect(result.needsConfirm?.map((a) => a.id)).toEqual([601, 602]);
    expect(result.workOrderId).toBeUndefined();
    expect(deps.createWorkOrder).not.toHaveBeenCalled();
    expect(stages).toEqual(['uploading', 'drafting', 'identifying', 'confirm']);
  });
});

describe('VoiceSheet (mock mode)', () => {
  const renderSheet = (props: Partial<React.ComponentProps<typeof VoiceSheet>> = {}) => {
    window.history.replaceState({}, '', '/?mock=1');
    const deps = props.deps ?? fakeDeps();
    render(
      <LocationProvider>
        <VoiceSheet {...props} deps={deps} />
      </LocationProvider>,
    );
    return deps;
  };

  it('falls back to a styled text input when speech recognition is unsupported', async () => {
    renderSheet();
    // jsdom has no SpeechRecognition — the fallback must carry the whole flow
    expect(await screen.findByLabelText('Voice command')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report a fault' })).toBeInTheDocument();
    // never a native select or a raw file button on the surface
    expect(document.querySelector('select')).toBeNull();
  });

  it('surfaces the ui action for a typed "rescan" without touching the agent', async () => {
    const onUiAction = vi.fn();
    const deps = renderSheet({ onUiAction });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Voice command'), 'rescan');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onUiAction).toHaveBeenCalledWith('rescan'));
    expect(screen.getByText('Rescanning.')).toBeInTheDocument();
    expect(deps.voiceTurn).not.toHaveBeenCalled();
  });

  it('runs a local status change when a work order is in view', async () => {
    const deps = renderSheet({ workOrderInView: 900 });
    const user = userEvent.setup();
    // wait for the status catalogue — the fast path needs it
    await waitFor(() => expect(deps.getStatuses).toHaveBeenCalled());

    await user.type(await screen.findByLabelText('Voice command'), 'start work');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(deps.changeStatus).toHaveBeenCalledWith(900, 'In Progress'));
    expect(deps.voiceTurn).not.toHaveBeenCalled();
  });

  it('falls through to the agent loop on a miss', async () => {
    renderSheet({ deps: fakeDeps({ voiceTurn: scriptedTurns(['Two are open.']) }) });
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Voice command'), 'how many are open');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Two are open.')).toBeInTheDocument();
  });

  it('offers a candidate picker when the fault flow is ambiguous, and creates only on pick', async () => {
    const deps = fakeDeps({
      searchAssets: vi.fn(async () => [
        { id: 601, name: 'Pump A' },
        { id: 602, name: 'Pump B' },
      ]),
      identifyAsset: vi.fn(async () => ({ assetId: null, confidence: 0.1, reason: 'ambiguous' })),
    });
    renderSheet({
      deps,
      captureFrame: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Report a fault' }));

    const pick = await screen.findByRole('button', { name: /Pump B/ });
    expect(deps.createWorkOrder).not.toHaveBeenCalled();

    await user.click(pick);
    await waitFor(() =>
      expect(deps.createWorkOrder).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: 602, subject: 'Leaking flange' }),
      ),
    );
  });
});
