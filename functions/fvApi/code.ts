import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

/**
 * facilio-vision's app-store API (roadmap 2.5).
 *
 * A tiny KV layer over the app's own Postgres schema. Three allowlisted
 * tables — surveys, codes, settings — each (key, value, updated_at), all TEXT.
 * Values are JSON strings; the browser parses them. The schema and DB login
 * arrive in the run's env map (vibe-server FunctionRunUtil.buildEnv: SCHEMA /
 * DB_USER / DB_PASSWORD) — never hardcoded.
 *
 * Platform constraints discovered the hard way (2026-08-13):
 *  - The DB role has NO DDL permission ("permission denied for schema"), so
 *    tables come from `facilio vibe db import` seeds and can carry no primary
 *    key — which also rules out `on conflict` upserts. kvPut is therefore
 *    update-then-insert; without a unique index a concurrent double-insert is
 *    possible, and kvGet tolerates that by taking the newest row.
 *  - updated_at is text (CSV import inferred it); now()::text sorts
 *    chronologically for a fixed timezone, which is all we need.
 */
const server = new StudioFunctions({ name: 'fvApi' });

const TABLES: Record<string, string> = {
  surveys: 'fv_surveys',
  codes: 'fv_codes',
  settings: 'fv_settings',
};

function db(): StudioDatabase {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

function tableOf(collection: string): string {
  const table = TABLES[collection];
  if (!table) throw new Error(`unknown collection "${collection}" — use surveys|codes|settings`);
  return table;
}

server.addHandler({
  name: 'health',
  description: 'Row counts for each KV table — proves DB reachability',
  parameters: {},
  execute: async () => {
    const database = db();
    const counts: Record<string, number> = {};
    for (const [collection, table] of Object.entries(TABLES)) {
      const { rows } = database.query(`select count(*)::int as n from ${table}`);
      counts[collection] = rows[0]?.n ?? 0;
    }
    return { ok: true, counts };
  },
});

server.addHandler({
  name: 'kvPut',
  description: 'Upsert one value (a JSON string) under a key',
  parameters: {
    collection: { description: 'surveys | codes | settings', type: 'string' },
    key: { description: 'Record key', type: 'string' },
    value: { description: 'JSON-encoded value', type: 'string' },
  },
  execute: async (args) => {
    const table = tableOf(String(args.collection));
    if (!args.key) throw new Error('key is required');
    const database = db();
    // No unique constraint available (see header) — update first, insert if new.
    const updated = database.query(
      `update ${table} set value = $2, updated_at = now()::text where key = $1`,
      [args.key, args.value ?? ''],
    );
    if (updated.rowCount === 0) {
      database.query(
        `insert into ${table} (key, value, updated_at) values ($1, $2, now()::text)`,
        [args.key, args.value ?? ''],
      );
    }
    return { ok: true, key: args.key };
  },
});

server.addHandler({
  name: 'kvGet',
  description: 'Read one value by key; null when absent',
  parameters: {
    collection: { description: 'surveys | codes | settings', type: 'string' },
    key: { description: 'Record key', type: 'string' },
  },
  execute: async (args) => {
    const table = tableOf(String(args.collection));
    const { rows } = db().query(
      `select key, value from ${table} where key = $1 order by updated_at desc limit 1`,
      [args.key],
    );
    return rows[0] ?? null;
  },
});

server.addHandler({
  name: 'kvList',
  description: 'List entries, optionally by key prefix, newest first',
  parameters: {
    collection: { description: 'surveys | codes | settings', type: 'string' },
    prefix: { description: 'Optional key prefix filter', type: 'string' },
    limit: { description: 'Max rows (default 100, cap 500)', type: 'number' },
  },
  execute: async (args) => {
    const table = tableOf(String(args.collection));
    const limit = Math.min(Number(args.limit) || 100, 500);
    const prefix = args.prefix ? String(args.prefix) : '';
    const { rows, truncated } = db().query(
      `select key, value from ${table} where key like $1 order by updated_at desc limit $2`,
      [`${prefix}%`, limit],
    );
    return { rows, truncated };
  },
});

server.addHandler({
  name: 'kvDelete',
  description: 'Delete one key; reports whether it existed',
  parameters: {
    collection: { description: 'surveys | codes | settings', type: 'string' },
    key: { description: 'Record key', type: 'string' },
  },
  execute: async (args) => {
    const table = tableOf(String(args.collection));
    const { rowCount } = db().query(`delete from ${table} where key = $1`, [args.key]);
    return { ok: true, existed: rowCount > 0 };
  },
});

server.execute();
