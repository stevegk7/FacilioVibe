/**
 * The script lane (2.4).
 *
 * `facilio-cmms.create-work-order` is PROVABLY broken (verified 2026-08-13):
 * its JSON Schema REQUIRES `siteId` and demands an object, while the backend
 * deserializer (V3WorkOrderContext.siteId: Long) rejects objects. No payload
 * satisfies both validators. So creates go through a Facilio scriptengine
 * function instead: `Module(modName).v3Add(data)` runs the full V3 create
 * pipeline and accepts plain numeric lookup ids.
 *
 * Functions are provisioned on first use so the app works in any org.
 * (Mechanism lifted from ppm-asset-tagging/src/api/scriptFns.ts.)
 */
import { execute } from './facilioHelpers';

export const FN_NAMESPACE = 'facilio_vision';
const RETURN_MAP = 4;

const SCRIPTS: Record<string, { returnType: number; source: string }> = {
  createRecord: {
    returnType: RETURN_MAP,
    source: `Map createRecord(String modName, Map data) {
    mod = Module(modName);
    mod.v3Add(data);
    return data;
}`,
  },
};

/**
 * execute-function responses nest the script result as
 * `…workflow.returnValue`, at a depth that differs between the raw-HTTP proxy
 * shape and the unwrapped one — walk for it instead of hardcoding a path.
 */
function findReturnValue(obj: unknown, depth = 0): unknown {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if ('returnValue' in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>).returnValue;
  }
  for (const value of Object.values(obj as Record<string, unknown>)) {
    let candidate = value;
    if (typeof candidate === 'string' && candidate.startsWith('{')) {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    const found = findReturnValue(candidate, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function namespaceId(): Promise<number | undefined> {
  const res = await execute<unknown>('facilio-platform', 'list-function-namespaces', {});
  const hit = JSON.stringify(res).match(
    new RegExp(`\\{[^{}]*"name"\\s*:\\s*"${FN_NAMESPACE}"[^{}]*\\}`),
  );
  if (!hit) return undefined;
  const id = (JSON.parse(hit[0]) as { id?: number }).id;
  return typeof id === 'number' ? id : undefined;
}

/** Idempotent: safe to call on every failure path. */
async function provision(): Promise<void> {
  let nsId = await namespaceId();
  if (!nsId) {
    await execute('facilio-platform', 'add-function-namespace', { name: FN_NAMESPACE }).catch(
      () => undefined,
    );
    nsId = await namespaceId();
  }
  if (!nsId) throw new Error('Could not create the facilio_vision script namespace');
  await Promise.all(
    Object.entries(SCRIPTS).map(([name, { returnType, source }]) =>
      execute('facilio-platform', 'add-function', {
        name,
        nameSpaceId: nsId,
        returnType,
        facilioScript: source,
      }).catch(() => undefined),
    ),
  );
}

let provisioning: Promise<void> | undefined;

export function ensureScripts(): Promise<void> {
  provisioning ??= provision();
  return provisioning;
}

async function invoke(functionName: string, paramList: unknown[]): Promise<unknown> {
  const res = await execute<unknown>('facilio-platform', 'execute-function', {
    nameSpace: FN_NAMESPACE,
    functionName,
    paramList,
  });
  return findReturnValue(res);
}

/**
 * Calls a provisioned function, self-provisioning once if the org has never
 * run this app. A freshly added function returns null for a few seconds while
 * it propagates, so the retry after provisioning is deliberate, not defensive.
 * A null returnValue stays ambiguous (aborted script / oversized response /
 * genuinely empty) — callers must fail loudly rather than read it as data.
 */
export async function callFn(functionName: string, paramList: unknown[]): Promise<unknown> {
  try {
    const out = await invoke(functionName, paramList);
    if (out !== undefined && out !== null) return out;
  } catch {
    /* fall through to provisioning */
  }
  await ensureScripts();
  await new Promise((r) => setTimeout(r, 2500));
  return await invoke(functionName, paramList);
}
