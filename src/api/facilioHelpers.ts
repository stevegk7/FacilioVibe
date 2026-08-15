// Lifted from ppm-asset-tagging/src/api/facilioActions.ts — each helper here
// encodes a verified CMMS quirk. Change with care.
import { vibe } from './vibe';

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export interface ActionResult<T> {
  success?: boolean;
  data?: T;
  count?: number;
  error?: { message?: string; code?: string };
  pagination?: { page?: number; pageSize?: number };
}

/**
 * When a gateway hiccups it answers an API call with an HTML PAGE — seen live
 * on 2026-08-15: execute-button-for-a-record got a 502 whose body was the
 * Facilio web client's index.html, and the SDK's error message carried all of
 * it, doctype, source comments and font links, straight into the AR panel a
 * technician was reading. An error surface is for what happened and what to do;
 * keep the status, drop the page.
 */
export function humanError(err: unknown, actionSlug: string): Error {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!/<!doctype\s|<html[\s>]/i.test(message)) {
    return err instanceof Error ? err : new Error(message || `${actionSlug} failed`);
  }
  const status = message.match(/failed:\s*(\d{3})/)?.[1];
  return new Error(
    `${actionSlug}: the server answered with an error page${
      status ? ` (HTTP ${status})` : ''
    } instead of data — usually a moment of platform maintenance. Try again shortly.`,
  );
}

/** The sentence `humanError` writes when it swallows a gateway HTML page. */
const GATEWAY_SENTENCE = 'answered with an error page';

/**
 * True when a call died in the gateway rather than being refused by Facilio.
 * Callers use it to decide whether a fallback is legitimate: a server that
 * REFUSED something (permission, criteria) must never be worked around, while
 * a server that never answered may be.
 *
 * Matches the humanised sentence, because `execute` converts the page before
 * any caller sees it — and the raw markers too, for anything that skips it.
 */
export function isGatewayFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes(GATEWAY_SENTENCE) || /<!doctype\s|<html[\s>]/i.test(message)
  );
}

/**
 * One connections action. The SDK sometimes wraps the payload in `{response}`,
 * and the CMMS layer reports failures in-band as `{success:false, error}` rather
 * than by HTTP status — unwrap both so callers only deal with data or a throw.
 */
export async function execute<T>(
  connection: string,
  actionSlug: string,
  payload: Record<string, unknown>,
): Promise<ActionResult<T>> {
  let result: ({ response?: ActionResult<T> } & ActionResult<T>) | undefined;
  try {
    result = (await vibe.executeAction(connection, actionSlug, payload)) as typeof result;
  } catch (err) {
    throw humanError(err, actionSlug);
  }
  const res = (result?.response ?? result ?? {}) as ActionResult<T>;
  if (res?.success === false) throw new Error(res.error?.message ?? `${actionSlug} failed`);
  return res;
}

export function cmms<T>(actionSlug: string, payload: Record<string, unknown>) {
  return execute<T>('facilio-cmms', actionSlug, payload);
}

/**
 * A bare `field=value` filter that matches exactly one row collapses the
 * response to a single object instead of a list — normalise before anyone
 * iterates it.
 */
export function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') return [data as T];
  return [];
}

/** Pages a list action until a short page arrives. */
export async function fetchAllPages<T>(
  actionSlug: string,
  payload: Record<string, unknown>,
  { connection = 'facilio-cmms', maxPages = MAX_PAGES, pageSize = PAGE_SIZE } = {},
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await execute<T[]>(connection, actionSlug, {
      ...payload,
      page,
      page_size: pageSize,
    });
    const rows = rowsOf<T>(res.data);
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  return all;
}

/**
 * Multi-value IN. Must use the `field(is)=a,b` operator form: a bare
 * `id=a,b` is rejected outright by the assets endpoint (it answers with an
 * HTML error page, not JSON), and `id(in)=` is "Unsupported operator".
 */
export function inFilter(field: string, ids: Array<number | string>): string {
  return `${field}(is)=${ids.join(',')}`;
}

/** Filters ride in a URL parameter — keep each IN list short (≤50 ids). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
