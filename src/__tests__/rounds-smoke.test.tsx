// rounds-smoke (WS-E): define a walking order, walk it, prove presence, export.
//  - the whole loop runs through the screen against the mock KV
//  - a QR stamp and a manual stamp are recorded distinguishably, in order
//  - the CSV carries the header plus one RFC-4180 row per stop
//  - the active-round chip appears while walking and clears when the run closes
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../api/appStore';
import type { Survey } from '../api/types';
import RoundsScreen from '../screens/RoundsScreen';
import { CSV_HEADER, roundRunToCsv } from '../rounds/csv';
import {
  finishRound,
  getActiveRound,
  listRuns,
  startRound,
  stampStopByCode,
} from '../rounds/roundsStore';
import type { RoundRun } from '../rounds/roundsStore';

const survey = (id: string, name: string, qrCode?: string): Survey => ({
  id,
  name,
  siteId: 1001,
  geo: null,
  qrCode,
  sweep: [],
  markers: [],
  modelId: 'stub-test',
  createdAt: '2026-08-12T10:00:00Z',
});

async function seedSurveys() {
  window.history.replaceState({}, '', '/?mock=1');
  await appStore.kvPut('surveys', 'survey.s1', survey('s1', 'Boiler Room', 'FV-QR-001'));
  await appStore.kvPut('surveys', 'survey.s2', survey('s2', 'Roof Plant'));
}

beforeEach(async () => {
  localStorage.clear();
  await seedSurveys();
});

describe('RoundsScreen (mock mode)', () => {
  it('defines a round, walks it with mixed evidence, and records the run', async () => {
    const user = userEvent.setup();
    render(<RoundsScreen />);

    // ---- define ----
    await user.click(await screen.findByRole('button', { name: 'New round' }));
    await user.type(screen.getByLabelText('Round name'), 'Morning Walk');
    await user.click(await screen.findByRole('button', { name: 'Add Boiler Room' }));
    await user.click(screen.getByRole('button', { name: 'Add Roof Plant' }));
    await user.click(screen.getByRole('button', { name: 'Save round' }));

    const start = await screen.findByRole('button', { name: 'Start Morning Walk' });
    expect(screen.getByText(/2 stops/)).toBeInTheDocument();

    // ---- walk ----
    await user.click(start);
    const chip = await screen.findByRole('status', { name: 'Active round' });
    expect(within(chip).getByText('Morning Walk')).toBeInTheDocument();
    expect(within(chip).getByText('0/2')).toBeInTheDocument();

    // stop 1 by scanning the standpoint code
    await user.type(screen.getByLabelText('Standpoint code'), 'FV-QR-001');
    await user.click(screen.getByRole('button', { name: 'Prove presence' }));
    await waitFor(() => expect(within(chip).getByText('1/2')).toBeInTheDocument());

    // stop 2 has no code — manual mark with a note
    await user.type(screen.getByLabelText('Visit note'), 'Hatch jammed, forced open');
    await user.click(screen.getByRole('button', { name: 'Mark visited' }));
    await waitFor(() => expect(within(chip).getByText('2/2')).toBeInTheDocument());

    // ---- finish ----
    await user.click(screen.getByRole('button', { name: 'Finish round' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Active round' })).toBeNull());
    expect(getActiveRound()).toBeNull();

    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.roundName).toBe('Morning Walk');
    expect(run.stops.map((s) => s.surveyId)).toEqual(['s1', 's2']);
    expect(run.stops[0].via).toBe('qr');
    expect(run.stops[1].via).toBe('manual');
    expect(run.stops[1].note).toBe('Hatch jammed, forced open');
    expect(run.stops.every((s) => typeof s.at === 'string')).toBe(true);
  });

  it('rejects a code that does not belong to the current stop', async () => {
    const user = userEvent.setup();
    render(<RoundsScreen />);
    await user.click(await screen.findByRole('button', { name: 'New round' }));
    await user.type(screen.getByLabelText('Round name'), 'Code Check');
    await user.click(await screen.findByRole('button', { name: 'Add Boiler Room' }));
    await user.click(screen.getByRole('button', { name: 'Save round' }));
    await user.click(await screen.findByRole('button', { name: 'Start Code Check' }));

    await user.type(screen.getByLabelText('Standpoint code'), 'FV-QR-999');
    await user.click(screen.getByRole('button', { name: 'Prove presence' }));

    expect(screen.getByText(/does not match/)).toBeInTheDocument();
    expect(getActiveRound()?.stops[0].via).toBeUndefined();
  });
});

describe('stampStopByCode', () => {
  it('stamps the first unstamped stop whose survey carries the code', async () => {
    startRound({ id: 'r1', name: 'AR Lane', stops: [{ surveyId: 's2' }, { surveyId: 's1' }] });

    expect(await stampStopByCode('nope')).toBe(false);
    expect(await stampStopByCode('FV-QR-001')).toBe(true);

    const active = getActiveRound();
    expect(active?.stops[1].via).toBe('qr');
    expect(active?.stops[0].via).toBeUndefined();

    // already stamped — a second scan of the same code finds nothing to do
    expect(await stampStopByCode('FV-QR-001')).toBe(false);
    await finishRound();
    expect(getActiveRound()).toBeNull();
  });
});

describe('roundRunToCsv', () => {
  it('emits a header plus one RFC-4180 row per stop', () => {
    const run: RoundRun = {
      id: 'run_1',
      roundId: 'r1',
      roundName: 'Morning Walk',
      startedAt: '2026-08-13T06:00:00.000Z',
      finishedAt: '2026-08-13T06:30:00.000Z',
      stops: [
        { surveyId: 's1', via: 'qr', at: '2026-08-13T06:05:00.000Z' },
        {
          surveyId: 's2',
          via: 'manual',
          at: '2026-08-13T06:20:00.000Z',
          note: 'Hatch jammed, forced open',
        },
      ],
    };
    const surveys = {
      s1: survey('s1', 'Boiler Room', 'FV-QR-001'),
      s2: survey('s2', 'Roof "North" Plant'),
    };

    const lines = roundRunToCsv(run, surveys).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines[1]).toBe('Morning Walk,1,Boiler Room,qr,2026-08-13T06:05:00.000Z,');
    // a quote is doubled, a comma forces quoting
    expect(lines[2]).toBe(
      'Morning Walk,2,"Roof ""North"" Plant",manual,2026-08-13T06:20:00.000Z,"Hatch jammed, forced open"',
    );
  });
});
