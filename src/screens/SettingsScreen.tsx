import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { provider, isMockMode } from '../api/provider';
import DsSelect from '../components/DsSelect';
import { appStore } from '../api/appStore';
import {
  DEFAULT_PLACE_ASSET_POLICY,
  loadPlaceAssetPolicy,
  savePlaceAssetPolicy,
  type PlaceAssetPolicy,
} from '../api/permissions';
import { EMPTY_LINKS, loadLinks, saveLinks, type LinkTemplates } from '../api/links';
import { useSites } from '../api/hooks';
import { detectEmbed } from '../shell/embed';
import {
  IDENTIFY_AGENT,
  NAMEPLATE_AGENT,
  VOICE_AGENT,
  WO_DRAFT_AGENT,
} from '../api/agents';
import type { CurrentUser, SiteGeo } from '../api/types';
import { kvKey } from './DashboardScreen';
import '../layout/layout.css';

/**
 * Settings / admin. Everything an operator needs to answer "is this install
 * healthy and configured?" without a console: session, app-store round-trip,
 * per-site coordinates, what the recognition index actually holds, which
 * agents the app talks to, and a way to throw away local caches.
 */

export const SITE_GEO_PREFIX = 'sitegeo.';
export const siteGeoKey = (siteId: number) => `${SITE_GEO_PREFIX}${siteId}`;

const AGENTS: Array<[string, string]> = [
  [IDENTIFY_AGENT, 'Vision confirm — live snap plus candidate reference photos in, one verdict out.'],
  [WO_DRAFT_AGENT, 'Photo plus context in, a work-order subject/description/priority draft out.'],
  [NAMEPLATE_AGENT, 'Nameplate OCR — manufacturer, model and serial read off an equipment plate.'],
  [VOICE_AGENT, 'Free-form utterance in, either a final answer or a {tool, args} step for the client loop.'],
];

/** Vector keys are `emb.<siteId>.<captureId>.<idx>` — the site is segment 2. */
function siteIdOfEmbKey(key: string): string {
  return key.split('.')[1] ?? '0';
}

function SessionCard() {
  const [me, setMe] = useState<CurrentUser | null | 'loading'>('loading');
  const embed = detectEmbed();

  useEffect(() => {
    let cancelled = false;
    provider
      .getCurrentUser()
      .then((user) => !cancelled && setMe(user))
      .catch(() => !cancelled && setMe(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const rows: Array<[string, string]> = [
    ['Mode', isMockMode() ? 'mock (?mock=1)' : 'real (facilio-cmms)'],
    ['User', me === 'loading' ? '…' : me ? `${me.user.name} <${me.user.email}>` : 'signed out'],
    ['Org', me === 'loading' || !me ? '—' : String(me.org.orgId)],
    ['Embedded', embed.embedded ? `yes (capp_id ${embed.cappId ?? '—'})` : 'no'],
  ];

  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>Session</h3>
      </div>
      <div className="kit-card-bd">
        <table className="diag-table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AppStoreHealthCard() {
  const [result, setResult] = useState<string | null>(null);

  // put → get → delete → get under a throwaway key: the whole KV contract in
  // one click, and the only check that proves deletes actually delete.
  const run = async () => {
    setResult('running…');
    const key = `diag.${Date.now()}`;
    try {
      await appStore.kvPut('settings', key, { ping: true });
      const read = await appStore.kvGet<{ ping: boolean }>('settings', key);
      await appStore.kvDelete('settings', key);
      const gone = await appStore.kvGet('settings', key);
      setResult(
        read?.ping === true && gone === null
          ? 'OK — put, get, delete all round-tripped'
          : `FAILED — read ${JSON.stringify(read)}, after delete ${JSON.stringify(gone)}`,
      );
    } catch (err) {
      setResult(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>App store health</h3>
      </div>
      <div className="kit-card-bd row" style={{ alignItems: 'center', gap: 12 }}>
        <button className="btn btn-secondary" onClick={run}>
          Run KV round-trip
        </button>
        {result && (
          <span className={result.startsWith('FAILED') ? 'error small' : 'muted small'}>
            {result}
          </span>
        )}
      </div>
    </div>
  );
}

function SiteGeoCard() {
  const sites = useSites();
  const queryClient = useQueryClient();
  const stored = useQuery({
    queryKey: kvKey('settings', SITE_GEO_PREFIX),
    queryFn: () => appStore.kvList<SiteGeo>('settings', SITE_GEO_PREFIX, 500),
  });

  // Local edits, keyed by site. Undefined = "not touched", so a fetch landing
  // late never stomps something the admin is halfway through typing.
  const [edits, setEdits] = useState<Record<number, { lat: string; lng: string }>>({});
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existing = (siteId: number) => stored.data?.find((e) => e.value?.siteId === siteId)?.value;

  const fieldValue = (siteId: number, axis: 'lat' | 'lng') => {
    const edit = edits[siteId];
    if (edit) return edit[axis];
    const row = existing(siteId);
    return row ? String(row[axis]) : '';
  };

  const setField = (siteId: number, axis: 'lat' | 'lng', value: string) =>
    setEdits((prev) => ({
      ...prev,
      [siteId]: {
        lat: axis === 'lat' ? value : fieldValue(siteId, 'lat'),
        lng: axis === 'lng' ? value : fieldValue(siteId, 'lng'),
      },
    }));

  const save = async (siteId: number) => {
    const lat = Number(fieldValue(siteId, 'lat'));
    const lng = Number(fieldValue(siteId, 'lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError('Latitude and longitude must both be numbers.');
      return;
    }
    setError(null);
    try {
      await appStore.kvPut('settings', siteGeoKey(siteId), { siteId, lat, lng } satisfies SiteGeo);
      setSaved(siteId);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[siteId];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: kvKey('settings', SITE_GEO_PREFIX) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>Site coordinates</h3>
      </div>
      <div className="kit-card-bd">
        <p className="muted small">
          Outdoor wayfinding legs start from these. Stored as{' '}
          <code>settings/{SITE_GEO_PREFIX}&lt;siteId&gt;</code>.
        </p>
        {sites.isLoading && <p className="muted small">Loading sites…</p>}
        {sites.isError && <p className="error small">{(sites.error as Error).message}</p>}
        {error && <p className="error small">{error}</p>}
        {sites.data?.map((site) => (
          <div className="geo-row" key={site.id}>
            <span className="geo-site">{site.name}</span>
            <label className="field geo-field">
              <span>Latitude</span>
              <input
                type="number"
                step="any"
                aria-label={`Latitude for ${site.name}`}
                value={fieldValue(site.id, 'lat')}
                onChange={(e) => setField(site.id, 'lat', e.target.value)}
              />
            </label>
            <label className="field geo-field">
              <span>Longitude</span>
              <input
                type="number"
                step="any"
                aria-label={`Longitude for ${site.name}`}
                value={fieldValue(site.id, 'lng')}
                onChange={(e) => setField(site.id, 'lng', e.target.value)}
              />
            </label>
            <button
              className="btn btn-secondary"
              onClick={() => void save(site.id)}
              aria-label={`Save coordinates for ${site.name}`}
            >
              Save
            </button>
            {saved === site.id && <span className="muted small">Saved</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function RecognitionIndexCard() {
  const sites = useSites();
  const vectors = useQuery({
    queryKey: kvKey('surveys', 'emb.'),
    queryFn: () => appStore.kvList('surveys', 'emb.', 2000),
  });

  const counts = new Map<string, number>();
  for (const entry of vectors.data ?? []) {
    const siteId = siteIdOfEmbKey(entry.key);
    counts.set(siteId, (counts.get(siteId) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const label = (siteId: string) => {
    if (siteId === '0') return 'Unscoped (no site)';
    const site = sites.data?.find((s) => String(s.id) === siteId);
    return site ? site.name : `Site ${siteId}`;
  };

  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>Recognition index</h3>
      </div>
      <div className="kit-card-bd">
        <p className="muted small">
          Stored embeddings per site bucket ({vectors.data?.length ?? 0} vectors total). Read-only —
          vectors are written by the capture pipeline.
        </p>
        {rows.length === 0 && <p className="muted small">No embeddings stored yet.</p>}
        {rows.length > 0 && (
          <table className="diag-table">
            <tbody>
              {rows.map(([siteId, count]) => (
                <tr key={siteId}>
                  <th>{label(siteId)}</th>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AgentsCard() {
  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>Studio agents</h3>
      </div>
      <div className="kit-card-bd">
        {AGENTS.map(([name, purpose]) => (
          <div className="agent-row" key={name}>
            <span className="agent-name">{name}</span>
            <span className="muted small">{purpose}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Who may place ASSET markers. Notes, findings and work orders stay open to
 * everyone doing the job — an asset pin is a portfolio claim that later scans
 * and routes trust, so it can be narrowed to named people.
 */
function PlaceAssetPolicyCard() {
  const [policy, setPolicy] = useState<PlaceAssetPolicy>(DEFAULT_PLACE_ASSET_POLICY);
  const [emails, setEmails] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadPlaceAssetPolicy().then((p) => {
      setPolicy(p);
      setEmails(p.emails.join('\n'));
    });
  }, []);

  const save = async (next: PlaceAssetPolicy) => {
    setPolicy(next);
    try {
      await savePlaceAssetPolicy(next);
      setStatus('Saved');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not save');
    }
  };

  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>Who can place assets</h3>
        {status && <span className="muted small">{status}</span>}
      </div>
      <div className="kit-card-bd">
        <p className="muted small" style={{ marginTop: 0 }}>
          Pinning a note, finding or work order is open to anyone doing the job. Placing an asset
          marker says where that asset physically is — every later scan and route trusts it.
        </p>
        <DsSelect
          label="Allowed"
          value={policy.allowAll ? 'all' : 'listed'}
          options={[
            { value: 'all', label: 'Anyone signed in' },
            { value: 'listed', label: 'Only these people' },
          ]}
          onChange={(v: string) => void save({ ...policy, allowAll: v === 'all' })}
        />
        {!policy.allowAll && (
          <label className="field" style={{ marginTop: 10 }}>
            <span>Emails, one per line</span>
            <textarea
              rows={4}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              onBlur={() =>
                void save({
                  ...policy,
                  emails: emails
                    .split(/[\n,]/)
                    .map((e) => e.trim())
                    .filter(Boolean),
                })
              }
              placeholder="lead@facilio.com"
            />
          </label>
        )}
      </div>
    </div>
  );
}

function DeepLinksCard() {
  const [links, setLinks] = useState<LinkTemplates>(EMPTY_LINKS);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadLinks().then(setLinks);
  }, []);

  const save = async (next: LinkTemplates) => {
    setLinks(next);
    await saveLinks(next);
    setStatus('Saved');
    setTimeout(() => setStatus(null), 1500);
  };

  return (
    <div className="kit-card">
      <div className="kit-card-hd">
        <h3>Open-in-Facilio links</h3>
        {status && <span className="muted small">{status}</span>}
      </div>
      <div className="kit-card-bd">
        <p className="muted small" style={{ marginTop: 0 }}>
          The AR windows show an “Open in Facilio” shortcut when these templates are set. Use
          your org’s web app URL with <code>{'{id}'}</code> where the record id goes. Left
          empty, the shortcut stays hidden.
        </p>
        <label className="field">
          <span>Work order summary URL</span>
          <input
            value={links.wo}
            onChange={(e) => setLinks({ ...links, wo: e.target.value })}
            onBlur={() => void save(links)}
            placeholder="https://yourorg.facilio.com/maintenance/workorder/{id}/summary"
          />
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          <span>Asset summary URL</span>
          <input
            value={links.asset}
            onChange={(e) => setLinks({ ...links, asset: e.target.value })}
            onBlur={() => void save(links)}
            placeholder="https://yourorg.facilio.com/assets/asset/{id}/summary"
          />
        </label>
      </div>
    </div>
  );
}

function DangerZoneCard() {
  const [done, setDone] = useState<string | null>(null);

  // Local only: the persisted react-query cache and the mock KV namespace.
  // Nothing here can touch org data — that is the point of it being safe to ship.
  const clear = () => {
    if (!window.confirm('Clear the local query cache and mock app-store data on this device?')) {
      return;
    }
    const doomed = ['fv.queryCache'];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('fv.mockKv')) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    setDone(`Cleared ${doomed.length} local ${doomed.length === 1 ? 'key' : 'keys'}. Reload to refetch.`);
  };

  return (
    <div className="kit-card danger">
      <div className="kit-card-hd">
        <h3>Danger zone</h3>
      </div>
      <div className="kit-card-bd row" style={{ alignItems: 'center', gap: 12 }}>
        <button className="btn btn-danger" onClick={clear}>
          Clear local caches
        </button>
        {done && <span className="muted small">{done}</span>}
      </div>
    </div>
  );
}

export default function SettingsScreen() {
  return (
    <section className="screen page">
      <h2>Settings</h2>
      <SessionCard />
      <AppStoreHealthCard />
      <SiteGeoCard />
      <RecognitionIndexCard />
      <AgentsCard />
      <PlaceAssetPolicyCard />
      <DeepLinksCard />
      <DangerZoneCard />
    </section>
  );
}
