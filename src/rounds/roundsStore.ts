/**
 * Rounds: definitions, the in-flight round, and finished runs.
 *
 * Definitions and runs live in the app's own KV ('settings' collection) so a
 * round survives a device swap. The *active* round is deliberately local —
 * it is a walk in progress on this handset, not org state, and it must be
 * readable synchronously by the chip that floats over every screen.
 */
import { appStore } from '../api/appStore';
import type { Round, RoundStop, Survey } from '../api/types';

export const ROUND_PREFIX = 'round.';
export const RUN_PREFIX = 'roundrun.';
export const SURVEY_PREFIX = 'survey.';
export const ACTIVE_KEY = 'fv.activeRound';

/** A completed walk — stops carry the evidence that was captured at each one. */
export interface RoundRun {
  id: string;
  roundId: string;
  roundName: string;
  startedAt: string;
  finishedAt: string;
  stops: RoundStop[];
}

/** The walk in progress: a snapshot of the definition plus evidence so far. */
export interface ActiveRound {
  roundId: string;
  roundName: string;
  startedAt: string;
  stops: RoundStop[];
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ---- definitions ----

export async function listRounds(): Promise<Round[]> {
  const rows = await appStore.kvList<Round>('settings', ROUND_PREFIX, 200);
  return rows.map((r) => r.value).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveRound(round: Round): Promise<void> {
  await appStore.kvPut('settings', `${ROUND_PREFIX}${round.id}`, round);
}

export async function deleteRound(id: string): Promise<void> {
  await appStore.kvDelete('settings', `${ROUND_PREFIX}${id}`);
}

// ---- finished runs ----

export async function listRuns(): Promise<RoundRun[]> {
  const rows = await appStore.kvList<RoundRun>('settings', RUN_PREFIX, 200);
  return rows.map((r) => r.value).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

export async function listSurveys(): Promise<Survey[]> {
  const rows = await appStore.kvList<Survey>('surveys', SURVEY_PREFIX, 500);
  return rows.map((r) => r.value);
}

// ---- the active round (localStorage + in-page pub/sub) ----

const activeListeners = new Set<(a: ActiveRound | null) => void>();

export function getActiveRound(): ActiveRound | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? (JSON.parse(raw) as ActiveRound) : null;
  } catch {
    return null;
  }
}

function setActiveRound(active: ActiveRound | null): void {
  try {
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* private mode — the walk still works, it just won't survive a reload */
  }
  for (const l of activeListeners) l(active);
}

/** Subscribe to the active round (fires immediately). Returns an unsubscribe. */
export function onActiveRoundChange(listener: (a: ActiveRound | null) => void): () => void {
  activeListeners.add(listener);
  listener(getActiveRound());
  return () => {
    activeListeners.delete(listener);
  };
}

export function startRound(round: Round): ActiveRound {
  const active: ActiveRound = {
    roundId: round.id,
    roundName: round.name,
    startedAt: new Date().toISOString(),
    // strip any evidence the definition happened to carry
    stops: round.stops.map((s) => ({ surveyId: s.surveyId })),
  };
  setActiveRound(active);
  return active;
}

export function cancelRound(): void {
  setActiveRound(null);
}

/** Index of the stop the technician is standing at — the first unstamped one. */
export function currentStopIndex(active: ActiveRound | null): number {
  if (!active) return -1;
  return active.stops.findIndex((s) => !s.via);
}

/** Stamp one stop with proof of presence. No-op if it is already stamped. */
export function stampStop(
  index: number,
  via: NonNullable<RoundStop['via']>,
  note?: string,
): ActiveRound | null {
  const active = getActiveRound();
  if (!active) return null;
  const stop = active.stops[index];
  if (!stop || stop.via) return active;
  const next: ActiveRound = {
    ...active,
    stops: active.stops.map((s, i) =>
      i === index
        ? { ...s, via, at: new Date().toISOString(), ...(note ? { note } : {}) }
        : s,
    ),
  };
  setActiveRound(next);
  return next;
}

/**
 * Stamp by standpoint QR value — the AR scan lane's entry point. Finds the
 * first unstamped stop whose survey carries that code. Returns true if a stop
 * was stamped.
 */
export async function stampStopByCode(code: string): Promise<boolean> {
  const active = getActiveRound();
  if (!active || !code) return false;
  const surveys = await listSurveys();
  const byId = new Map(surveys.map((s) => [s.id, s]));
  const index = active.stops.findIndex(
    (s) => !s.via && byId.get(s.surveyId)?.qrCode === code,
  );
  if (index < 0) return false;
  stampStop(index, 'qr');
  return true;
}

/** Close the walk: write the run record and clear the active pointer. */
export async function finishRound(): Promise<RoundRun | null> {
  const active = getActiveRound();
  if (!active) return null;
  const run: RoundRun = {
    id: newId('run_'),
    roundId: active.roundId,
    roundName: active.roundName,
    startedAt: active.startedAt,
    finishedAt: new Date().toISOString(),
    stops: active.stops,
  };
  await appStore.kvPut('settings', `${RUN_PREFIX}${run.id}`, run);
  setActiveRound(null);
  return run;
}
