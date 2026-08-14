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
 * One connections action. The SDK sometimes wraps the payload in `{response}`,
 * and the CMMS layer reports failures in-band as `{success:false, error}` rather
 * than by HTTP status — unwrap both so callers only deal with data or a throw.
 */
export async function execute<T>(
  connection: string,
  actionSlug: string,
  payload: Record<string, unknown>,
): Promise<ActionResult<T>> {
  const result = (await vibe.executeAction(connection, actionSlug, payload)) as
    | ({ response?: ActionResult<T> } & ActionResult<T>)
    | undefined;
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
