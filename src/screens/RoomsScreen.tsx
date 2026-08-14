// Rooms browser (roadmap 4): captures grouped by space name, thumbnail grid,
// full-photo viewer with marker bubbles (asset names), and capture deletion
// that also removes the capture's emb.* vectors. Photo urls come from
// appStore.getPhotoUrl at render time — file IDs are what's persisted.
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { appStore } from '../api/appStore';
import { useAsset } from '../api/hooks';
import { deleteCapture, type CaptureRow } from '../vision/captureStore';
import { useCaptures } from './CaptureScreen';
import '../vision/vision.css';
import './surveys.css';

const UNGROUPED = 'Unassigned space';

export default function RoomsScreen() {
  const captures = useCaptures();
  const [openId, setOpenId] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, CaptureRow[]>();
    for (const row of captures.data ?? []) {
      const key = row.spaceName?.trim() || UNGROUPED;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [captures.data]);

  const open = (captures.data ?? []).find((row) => row.id === openId) ?? null;

  const total = captures.data?.length ?? 0;

  // Same frame as Surveys: fixed head, ONE internal scroller, no page scroll.
  return (
    <section className="screen sv-screen fv-rooms">
      <header className="sv-head">
        <div className="sv-head-row">
          <h2 className="sv-h1">Rooms</h2>
          <span className="sv-chip static">
            {total} capture{total === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <div className="sv-list scroll-y">
        {captures.isLoading && <p className="sv-status">Loading captures…</p>}
        {captures.isError && <p className="sv-status error">Couldn’t load captures.</p>}
        {!captures.isLoading && groups.length === 0 && (
          <p className="empty-card">
            No captures yet. A capture is a photo of a space with its assets boxed on it — take
            one from the Capture tab and it lands here, grouped by space.
          </p>
        )}
        {groups.map(([space, rows]) => (
          <div key={space} className="fv-room-group">
            <h3>
              {space} <span className="muted small">({rows.length})</span>
            </h3>
            <div className="fv-room-grid">
              {rows.map((row) => (
                <button
                  key={row.id}
                  className="fv-room-thumb"
                  aria-label={`Open capture in ${space}`}
                  onClick={() => setOpenId(row.id)}
                >
                  <StoredPhoto fileId={row.thumbFileId} alt={`Capture in ${space}`} />
                  {row.embeddingStatus === 'pending' && (
                    <span className="fv-thumb-pending">AI pending</span>
                  )}
                  {row.markers.length > 0 && (
                    <span className="fv-thumb-badge">{row.markers.length}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {open && <CaptureViewer row={open} onClose={() => setOpenId(null)} />}
    </section>
  );
}

/** Resolves a fileId to a session object URL — the URL is never persisted. */
function StoredPhoto({ fileId, alt }: { fileId: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let on = true;
    setUrl(null);
    setFailed(false);
    appStore
      .getPhotoUrl(fileId)
      .then((u) => {
        if (on) setUrl(u);
      })
      .catch(() => {
        if (on) setFailed(true);
      });
    return () => {
      on = false;
    };
  }, [fileId]);
  if (failed) return <span className="fv-photo-fallback">photo unavailable</span>;
  if (!url) return <span className="fv-photo-fallback">…</span>;
  return <img src={url} alt={alt} />;
}

function CaptureViewer({ row, onClose }: { row: CaptureRow; onClose(): void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    // Removes the capture row AND its emb.* vectors in one motion.
    await deleteCapture(row);
    await queryClient.invalidateQueries({ queryKey: ['captures'] });
    onClose();
  };

  const taken = new Date(row.createdAt);

  return (
    <div className="fv-viewer-backdrop">
      <div className="fv-viewer" role="dialog" aria-label="Capture viewer">
        <div className="fv-viewer-head">
          <span className="title">
            {row.spaceName || UNGROUPED} · {isNaN(taken.getTime()) ? row.createdAt : taken.toLocaleString()}
          </span>
          <button className="fv-viewer-close" aria-label="Close viewer" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="fv-viewer-photo">
          <StoredPhoto fileId={row.photoFileId} alt="Capture" />
          {row.markers.map((m, i) => (
            <MarkerBubble
              key={i}
              assetId={m.assetId}
              x={m.rect.x + m.rect.w / 2}
              y={m.rect.y + m.rect.h / 2}
            />
          ))}
        </div>
        {row.embeddingStatus === 'pending' && (
          <p className="muted small">AI indexing pending for this capture.</p>
        )}
        <div className="fv-viewer-actions">
          {!confirming ? (
            <button className="fv-btn-danger" onClick={() => setConfirming(true)}>
              Delete capture
            </button>
          ) : (
            <>
              <button className="fv-btn-plain" disabled={deleting} onClick={() => setConfirming(false)}>
                Keep it
              </button>
              <button className="fv-btn-danger" disabled={deleting} onClick={() => void remove()}>
                {deleting ? 'Deleting…' : 'Yes, delete photo + vectors'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkerBubble({ assetId, x, y }: { assetId: number; x: number; y: number }) {
  const asset = useAsset(assetId);
  return (
    <span className="fv-marker-bubble" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
      <span className="dot" aria-hidden="true" />
      <span className="name">{asset.data?.name ?? `Asset #${assetId}`}</span>
    </span>
  );
}
