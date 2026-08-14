// Marker editor for the capture flow: tap the photo to drop a marker,
// drag its box to move, drag the corner handle to resize, and assign an
// asset per marker through provider.searchAssets text search.
import { useEffect, useRef, useState } from 'react';
import { provider } from '../../api/provider';
import type { Asset } from '../../api/types';
import type { NormRect } from '../../vision/types';
import './camera.css';

export interface EditorMarker {
  id: number;
  rect: NormRect;
  assetId?: number;
  assetName?: string;
}

const MIN_EDGE = 0.06;

function clampRect(rect: NormRect): NormRect {
  const w = Math.min(1, Math.max(MIN_EDGE, rect.w));
  const h = Math.min(1, Math.max(MIN_EDGE, rect.h));
  return {
    x: Math.min(1 - w, Math.max(0, rect.x)),
    y: Math.min(1 - h, Math.max(0, rect.y)),
    w,
    h,
  };
}

export function MarkerEditor({
  photoUrl,
  markers,
  onChange,
  siteId,
}: {
  photoUrl: string;
  markers: EditorMarker[];
  onChange(next: EditorMarker[]): void;
  siteId?: number;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const nextId = useRef(1);
  const drag = useRef<{
    id: number;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    rect: NormRect;
  } | null>(null);

  const norm = (clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return { x: 0, y: 0 };
    const box = el.getBoundingClientRect();
    return {
      x: box.width ? (clientX - box.left) / box.width : 0,
      y: box.height ? (clientY - box.top) / box.height : 0,
    };
  };

  const addMarkerAt = (clientX: number, clientY: number) => {
    const p = norm(clientX, clientY);
    const id = nextId.current++;
    const rect = clampRect({ x: p.x - 0.12, y: p.y - 0.09, w: 0.24, h: 0.18 });
    onChange([...markers, { id, rect }]);
    setSelectedId(id);
  };

  const updateRect = (id: number, rect: NormRect) => {
    onChange(markers.map((m) => (m.id === id ? { ...m, rect: clampRect(rect) } : m)));
  };

  const removeMarker = (id: number) => {
    onChange(markers.filter((m) => m.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const startDrag = (
    e: React.PointerEvent,
    id: number,
    mode: 'move' | 'resize',
    rect: NormRect,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(id);
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, rect };
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const el = stageRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dx = (ev.clientX - d.startX) / box.width;
      const dy = (ev.clientY - d.startY) / box.height;
      if (d.mode === 'move') {
        updateRect(d.id, { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy });
      } else {
        updateRect(d.id, { ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy });
      }
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selected = markers.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="fv-marker-editor">
      <div
        ref={stageRef}
        className="fv-marker-stage"
        onClick={(e) => {
          // taps on existing boxes stop propagation — this only fires on the photo
          addMarkerAt(e.clientX, e.clientY);
        }}
      >
        <img src={photoUrl} alt="Captured frame" draggable={false} />
        {markers.map((m, i) => (
          <div
            key={m.id}
            className={m.id === selectedId ? 'fv-marker-box selected' : 'fv-marker-box'}
            style={{
              left: `${m.rect.x * 100}%`,
              top: `${m.rect.y * 100}%`,
              width: `${m.rect.w * 100}%`,
              height: `${m.rect.h * 100}%`,
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => startDrag(e, m.id, 'move', m.rect)}
          >
            <span className="fv-marker-tag">{m.assetName ?? `Marker ${i + 1}`}</span>
            <span
              className="fv-marker-handle"
              aria-hidden="true"
              onPointerDown={(e) => startDrag(e, m.id, 'resize', m.rect)}
            />
          </div>
        ))}
      </div>
      <p className="muted small">Tap the photo to add a marker; drag boxes to fit the asset.</p>

      <ul className="fv-marker-list">
        {markers.map((m, i) => (
          <li key={m.id} className={m.id === selectedId ? 'selected' : undefined}>
            <button className="fv-marker-name" onClick={() => setSelectedId(m.id)}>
              Marker {i + 1}: {m.assetName ?? 'no asset yet'}
            </button>
            <button
              className="fv-btn-plain"
              aria-label={`Remove marker ${i + 1}`}
              onClick={() => removeMarker(m.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <MarkerAssetPicker
          key={selected.id}
          siteId={siteId}
          onPick={(asset) => {
            onChange(
              markers.map((m) =>
                m.id === selected.id ? { ...m, assetId: asset.id, assetName: asset.name } : m,
              ),
            );
          }}
        />
      )}
    </div>
  );
}

function MarkerAssetPicker({
  siteId,
  onPick,
}: {
  siteId?: number;
  onPick(asset: Asset): void;
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Asset[]>([]);
  useEffect(() => {
    let on = true;
    void provider.searchAssets({ text, scope: siteId ? { siteId } : undefined }).then((rows) => {
      if (on) setResults(rows.slice(0, 8));
    });
    return () => {
      on = false;
    };
  }, [text, siteId]);
  return (
    <div className="fv-asset-search">
      <input
        type="search"
        placeholder="Assign asset: search by name…"
        aria-label="Assign asset"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ul className="fv-asset-results">
        {results.map((a) => (
          <li key={a.id}>
            <button onClick={() => onPick(a)}>
              {a.name}
              {a.spaceName && <span className="muted"> · {a.spaceName}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
