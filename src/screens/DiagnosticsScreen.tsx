import { useEffect, useState } from 'react';
import { provider, isMockMode } from '../api/provider';
import { appStore } from '../api/appStore';
import { detectEmbed } from '../shell/embed';
import type { CurrentUser } from '../api/types';

// Hidden dev/debug screen (?tab=diagnostics): the fastest way to answer
// "what session, what mode, what host is this running in?" from a phone.
export default function DiagnosticsScreen() {
  const [me, setMe] = useState<CurrentUser | null | 'loading'>('loading');
  const [kvResult, setKvResult] = useState<string | null>(null);
  const embed = detectEmbed();

  // Round-trips the fvApi KV store (localStorage in mock mode): put → get →
  // delete under a throwaway key. The fastest "is the app store alive?" check.
  const runKvCheck = async () => {
    setKvResult('running…');
    const key = `diag.${Date.now()}`;
    try {
      await appStore.kvPut('settings', key, { ping: true });
      const read = await appStore.kvGet<{ ping: boolean }>('settings', key);
      await appStore.kvDelete('settings', key);
      const gone = await appStore.kvGet('settings', key);
      setKvResult(
        read?.ping === true && gone === null
          ? 'OK — put, get, delete all round-tripped'
          : `FAILED — read ${JSON.stringify(read)}, after delete ${JSON.stringify(gone)}`,
      );
    } catch (err) {
      setKvResult(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    provider
      .getCurrentUser()
      .then((user) => {
        if (!cancelled) setMe(user);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows: Array<[string, string]> = [
    ['Provider', isMockMode() ? 'mock (?mock=1)' : 'real (facilio-cmms)'],
    ['User', me === 'loading' ? '…' : me ? `${me.user.name} <${me.user.email}>` : 'signed out'],
    ['Org', me === 'loading' || !me ? '—' : String(me.org.orgId)],
    ['Embedded', embed.embedded ? 'yes' : 'no'],
    ['capp_id', embed.cappId ?? '—'],
    ['origin', embed.origin ?? '—'],
    ['URL', window.location.href],
    ['User agent', navigator.userAgent],
  ];

  return (
    <section className="screen">
      <h2>Diagnostics</h2>
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

      <div className="row" style={{ marginTop: 16, alignItems: 'center', gap: 12 }}>
        <button className="btn btn-secondary" onClick={runKvCheck}>
          KV store round-trip
        </button>
        {kvResult && (
          <span className={kvResult.startsWith('OK') ? 'muted small' : 'error small'}>
            {kvResult}
          </span>
        )}
      </div>
    </section>
  );
}
