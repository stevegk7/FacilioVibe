import { useCallback, useEffect, useState } from 'react';
import DsSelect from '../components/DsSelect';
import { provider } from '../api/provider';
import type { Round, RoundStop, Site, Survey } from '../api/types';
import ActiveRoundChip from '../rounds/ActiveRoundChip';
import { exportCsv, roundRunToCsv } from '../rounds/csv';
import {
  cancelRound,
  currentStopIndex,
  deleteRound,
  finishRound,
  listRounds,
  listRuns,
  listSurveys,
  newId,
  onActiveRoundChange,
  saveRound,
  stampStop,
  startRound,
} from '../rounds/roundsStore';
import type { ActiveRound, RoundRun } from '../rounds/roundsStore';
import '../rounds/rounds.css';

export { default as ActiveRoundChip } from '../rounds/ActiveRoundChip';
export { stampStopByCode } from '../rounds/roundsStore';

function byId(surveys: Survey[]): Record<string, Survey> {
  return Object.fromEntries(surveys.map((s) => [s.id, s]));
}

function shortTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Rounds: define a walking order once, then walk it with proof of presence at
 * each stop. Evidence is a scanned standpoint code where one exists and an
 * explicit manual mark where it doesn't — the export tells the two apart, so
 * "we were there" never quietly means "someone tapped a button".
 */
export default function RoundsScreen() {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [runs, setRuns] = useState<RoundRun[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [active, setActive] = useState<ActiveRound | null>(null);
  const [draft, setDraft] = useState<Round | null>(null);
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [s, r, h] = await Promise.all([listSurveys(), listRounds(), listRuns()]);
    setSurveys(s);
    setRounds(r);
    setRuns(h);
  }, []);

  useEffect(() => {
    void reload().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  useEffect(() => onActiveRoundChange(setActive), []);

  useEffect(() => {
    let cancelled = false;
    provider
      .listSites({ pageSize: 200 })
      .then((page) => {
        if (!cancelled) setSites(page.data);
      })
      // Sites are a convenience on the editor; a failure must not block rounds.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const surveyMap = byId(surveys);
  const surveyName = (id: string) => surveyMap[id]?.name ?? id;
  const activeIndex = currentStopIndex(active);

  // ---- editor ----

  const newRound = () =>
    setDraft({ id: newId('round_'), name: '', stops: [] });

  const patchDraft = (patch: Partial<Round>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const moveStop = (index: number, delta: number) =>
    setDraft((d) => {
      if (!d) return d;
      const to = index + delta;
      if (to < 0 || to >= d.stops.length) return d;
      const stops = [...d.stops];
      const [moved] = stops.splice(index, 1);
      stops.splice(to, 0, moved);
      return { ...d, stops };
    });

  const commitDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim() || draft.stops.length === 0) {
      setError('A round needs a name and at least one stop.');
      return;
    }
    setError(null);
    await saveRound({ ...draft, name: draft.name.trim() });
    setDraft(null);
    await reload();
  };

  // ---- the walk ----

  const proveByCode = () => {
    if (!active || activeIndex < 0) return;
    const expected = surveyMap[active.stops[activeIndex].surveyId]?.qrCode;
    if (!expected || expected !== code.trim()) {
      setError('That code does not match this stop.');
      return;
    }
    setError(null);
    setCode('');
    stampStop(activeIndex, 'qr');
  };

  const proveManually = () => {
    if (!active || activeIndex < 0) return;
    setError(null);
    stampStop(activeIndex, 'manual', note.trim() || undefined);
    setNote('');
  };

  const finish = async () => {
    await finishRound();
    setCode('');
    setNote('');
    await reload();
  };

  const lastRunOf = (roundId: string) => runs.find((r) => r.roundId === roundId);

  return (
    <section className="screen">
      <header className="round-row">
        <h2 style={{ flex: 1 }}>Rounds</h2>
        {active && <ActiveRoundChip />}
      </header>

      {error && <p className="error round-error">{error}</p>}

      {active && (
        <div className="kit-card">
          <div className="kit-card-hd">
            <h3>Walking: {active.roundName}</h3>
            <button type="button" className="btn btn-secondary" onClick={() => void finish()}>
              Finish round
            </button>
          </div>
          <div className="kit-card-bd">
            <ol className="round-order">
              {active.stops.map((stop, i) => (
                <li
                  key={`${stop.surveyId}-${i}`}
                  className={stop.via ? 'done' : i === activeIndex ? 'current' : ''}
                >
                  <span className="round-stop-ord">{i + 1}</span>
                  <span className="round-stop-name">{surveyName(stop.surveyId)}</span>
                  {stop.via ? (
                    <span className="round-stop-evidence">
                      {stop.via} · {shortTime(stop.at)}
                      {stop.note ? ` · ${stop.note}` : ''}
                    </span>
                  ) : i === activeIndex ? (
                    <span className="pill">current</span>
                  ) : null}
                </li>
              ))}
            </ol>

            {activeIndex >= 0 && (
              <div className="round-prove">
                <input
                  aria-label="Standpoint code"
                  value={code}
                  placeholder="Scan or type the code"
                  onChange={(e) => setCode(e.target.value)}
                />
                <button type="button" className="btn btn-primary" onClick={proveByCode}>
                  Prove presence
                </button>
                <input
                  aria-label="Visit note"
                  value={note}
                  placeholder="Note (optional)"
                  onChange={(e) => setNote(e.target.value)}
                />
                <button type="button" className="btn btn-secondary" onClick={proveManually}>
                  Mark visited
                </button>
              </div>
            )}
            {activeIndex < 0 && <p className="muted">All stops stamped — finish the round.</p>}
            <p>
              <button type="button" className="btn btn-secondary" onClick={() => cancelRound()}>
                Abandon round
              </button>
            </p>
          </div>
        </div>
      )}

      {draft ? (
        <div className="kit-card">
          <div className="kit-card-hd">
            <h3>{rounds.some((r) => r.id === draft.id) ? 'Edit round' : 'New round'}</h3>
          </div>
          <div className="kit-card-bd">
            <label className="field">
              <span>Name</span>
              <input
                aria-label="Round name"
                value={draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
              />
            </label>
            <DsSelect
              label="Site"
              value={draft.siteId ? String(draft.siteId) : ''}
              options={sites.map((s) => ({ value: String(s.id), label: s.name }))}
              onChange={(v) => patchDraft({ siteId: v ? Number(v) : undefined })}
            />

            <div className="round-editor-cols">
              <div>
                <strong>Standpoints</strong>
                <ul className="round-pick">
                  {surveys.length === 0 && <li className="muted">No standpoints captured yet.</li>}
                  {surveys.map((s) => (
                    <li key={s.id}>
                      <span>{s.name}</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Add ${s.name}`}
                        onClick={() =>
                          patchDraft({
                            stops: [...draft.stops, { surveyId: s.id } as RoundStop],
                          })
                        }
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Walking order</strong>
                <ol className="round-order">
                  {draft.stops.length === 0 && <li className="muted">No stops yet.</li>}
                  {draft.stops.map((stop, i) => (
                    <li key={`${stop.surveyId}-${i}`}>
                      <span className="round-stop-ord">{i + 1}</span>
                      <span className="round-stop-name">{surveyName(stop.surveyId)}</span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Move ${surveyName(stop.surveyId)} up`}
                        onClick={() => moveStop(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Move ${surveyName(stop.surveyId)} down`}
                        onClick={() => moveStop(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Remove ${surveyName(stop.surveyId)}`}
                        onClick={() =>
                          patchDraft({ stops: draft.stops.filter((_, j) => j !== i) })
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="round-actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary" onClick={() => void commitDraft()}>
                Save round
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p>
          <button type="button" className="btn btn-primary" onClick={newRound}>
            New round
          </button>
        </p>
      )}

      <ul className="card-list">
        {rounds.length === 0 && <li className="muted">No rounds defined yet.</li>}
        {rounds.map((round) => {
          const last = lastRunOf(round.id);
          return (
            <li key={round.id} className="kit-card">
              <div className="kit-card-bd round-row">
                <div className="round-row-main">
                  <strong>{round.name}</strong>
                  <span className="muted">
                    {round.stops.length} stop{round.stops.length === 1 ? '' : 's'}
                    {last ? ` · last run ${shortTime(last.finishedAt)}` : ' · never run'}
                  </span>
                </div>
                <div className="round-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!!active}
                    aria-label={`Start ${round.name}`}
                    onClick={() => startRound(round)}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`Edit ${round.name}`}
                    onClick={() => setDraft(round)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`Delete ${round.name}`}
                    onClick={() => void deleteRound(round.id).then(reload)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="kit-card">
        <div className="kit-card-hd">
          <h3>Run history</h3>
        </div>
        <div className="kit-card-bd">
          {runs.length === 0 && <p className="muted">No completed runs yet.</p>}
          <ul className="card-list">
            {runs.map((run) => (
              <li key={run.id} className="round-row">
                <div className="round-row-main">
                  <strong>{run.roundName}</strong>
                  <span className="muted">
                    {shortTime(run.finishedAt)} · {run.stops.filter((s) => s.via).length}/
                    {run.stops.length} stamped
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={`Export ${run.roundName} CSV`}
                  onClick={() =>
                    exportCsv(`${run.roundName || 'round'}-${run.id}.csv`, roundRunToCsv(run, surveyMap))
                  }
                >
                  Export CSV
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
