/**
 * Round-run export. A finished walk is the evidence a client asks for, so it
 * leaves the app as a plain CSV anyone can open — RFC 4180 quoting, one row
 * per stop, in walking order.
 */
import type { Survey } from '../api/types';
import type { RoundRun } from './roundsStore';

export const CSV_HEADER = 'Round,Order,Survey,Via,At,Note';

/** Quote only when required; escape embedded quotes by doubling them. */
function q(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function roundRunToCsv(run: RoundRun, surveysById: Record<string, Survey>): string {
  const rows = run.stops.map((stop, i) =>
    [
      q(run.roundName),
      String(i + 1),
      q(surveysById[stop.surveyId]?.name ?? stop.surveyId),
      q(stop.via ?? 'skipped'),
      q(stop.at ?? ''),
      q(stop.note ?? ''),
    ].join(','),
  );
  return [CSV_HEADER, ...rows].join('\r\n');
}

/** Hand the text to the browser as a download. No-op outside a document. */
export function exportCsv(filename: string, text: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a tick to start before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
