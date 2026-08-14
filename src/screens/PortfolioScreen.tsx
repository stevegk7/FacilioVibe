import { useState } from 'react';
import { useAsset, useAssetSearch } from '../api/hooks';
import LocationPicker from '../components/LocationPicker';
import WorkOrderPanel from '../components/WorkOrderPanel';
import { useLocationScope } from '../state/LocationContext';

/**
 * Phase 2 home (hidden tab, ?tab=portfolio): pick a location, browse assets,
 * open one. Work orders/status/tasks attach to the detail pane in PR-B2.
 */
export default function PortfolioScreen() {
  const { scope, names } = useLocationScope();
  const [text, setText] = useState('');
  const [assetId, setAssetId] = useState<number | null>(null);

  const search = useAssetSearch({ text, scope });
  const asset = useAsset(assetId);

  const crumbs = [names.site, names.building, names.floor].filter(Boolean).join(' › ');

  if (assetId !== null) {
    return (
      <section className="screen">
        <button className="link-btn" onClick={() => setAssetId(null)}>
          ← Back to assets
        </button>
        {asset.isLoading && <p className="muted">Loading asset…</p>}
        {asset.isError && <p className="error">{(asset.error as Error).message}</p>}
        {asset.data === null && !asset.isLoading && (
          <p className="muted">Asset #{assetId} not found.</p>
        )}
        {asset.data && (
          <>
            <h2>{asset.data.name}</h2>
            <p className="muted">
              {asset.data.category && <span className="pill">{asset.data.category}</span>}
              {asset.data.spaceName && <span className="pill">{asset.data.spaceName}</span>}
              <span className="pill">#{asset.data.id}</span>
            </p>
            <WorkOrderPanel asset={asset.data} />
          </>
        )}
      </section>
    );
  }

  return (
    <section className="screen">
      <h2>Portfolio</h2>
      <LocationPicker />
      {crumbs && <p className="muted small">Scope: {crumbs}</p>}

      <input
        className="search-box"
        type="search"
        placeholder="Search assets by name…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {search.isLoading && <p className="muted">Loading assets…</p>}
      {search.isError && <p className="error">{(search.error as Error).message}</p>}
      {search.data && search.data.length === 0 && (
        <p className="muted">No assets match this scope.</p>
      )}
      {search.data && search.data.length > 0 && (
        <ul className="card-list">
          {search.data.map((a) => (
            <li key={a.id}>
              <button className="card card-btn" onClick={() => setAssetId(a.id)}>
                <strong>{a.name}</strong>
                {a.category && <span className="pill">{a.category}</span>}
                {a.spaceName && <span className="pill">{a.spaceName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
