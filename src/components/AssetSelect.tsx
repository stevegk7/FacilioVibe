/**
 * Asset picker as a real DSM DROPDOWN, not a bare search box.
 *
 * The bare search field looked broken: an empty input, no hint that anything
 * was behind it, nothing to tap. This is the same control as DsSelect — a
 * labelled trigger that expands INLINE on touch (the pattern that survived
 * the popover-clipped and sheet-in-sheet failures) — except the options are
 * the org's assets in the current scope, listed immediately, with a filter
 * row inside the dropdown for the buildings where the list is long.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useAssetSearch } from '../api/hooks';
import type { Asset } from '../api/types';
import Icon from './Icon';

function useCoarsePointer(): boolean {
  const query = '(pointer: coarse), (max-width: 767px)';
  const [coarse, setCoarse] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return coarse;
}

export default function AssetSelect({
  label = 'Asset',
  value,
  scopeSiteId,
  disabled,
  onPick,
}: {
  label?: string;
  value: Asset | null;
  scopeSiteId: number | undefined;
  disabled?: boolean;
  onPick(asset: Asset): void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const coarse = useCoarsePointer();

  // The list loads as soon as the dropdown opens — an empty query IS a valid
  // query (all assets in scope). Typing narrows server-side.
  const search = useAssetSearch(
    { text: text.trim(), scope: scopeSiteId ? { siteId: scopeSiteId } : undefined },
    open,
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as HTMLElement)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Expanding in the flow can push the list below the fold of the sheet that
  // contains it — bring it into view rather than leaving the user to guess.
  useEffect(() => {
    if (!open || !coarse) return;
    const id = window.setTimeout(
      () => listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      60,
    );
    return () => window.clearTimeout(id);
  }, [open, coarse]);

  const rows = (search.data ?? []).slice(0, 50);

  const body = (
    <div
      className="ds-select-inline as-asset-list scroll-y"
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={label}
    >
      <div className="as-asset-filter">
        <Icon name="search" size={16} />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter assets…"
          aria-label="Filter assets"
        />
      </div>
      {search.isLoading && <div className="ds-select-empty">Loading assets…</div>}
      {!search.isLoading && rows.length === 0 && (
        <div className="ds-select-empty">
          {text.trim() ? 'No assets match that here.' : 'No assets in this scope.'}
        </div>
      )}
      {rows.map((asset) => (
        <button
          key={asset.id}
          type="button"
          role="option"
          aria-selected={value?.id === asset.id}
          className={value?.id === asset.id ? 'ds-select-opt selected as-asset-opt' : 'ds-select-opt as-asset-opt'}
          onClick={() => {
            onPick(asset);
            setOpen(false);
          }}
        >
          <span className="as-asset-opt-main">
            <span className="ds-select-opt-label">{asset.name}</span>
            <span className="as-asset-opt-meta">
              {asset.spaceName ?? asset.category ?? `#${asset.id}`}
            </span>
          </span>
          {value?.id === asset.id && <Icon name="check" size={18} className="ds-select-tick" />}
        </button>
      ))}
    </div>
  );

  return (
    <div className="ds-select" ref={rootRef}>
      <span className="ds-select-label">{label}</span>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        className={open ? 'ds-select-btn open' : 'ds-select-btn'}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value ? 'ds-select-value' : 'ds-select-value placeholder'}>
          {value?.name ?? 'Choose an asset…'}
        </span>
        <Icon name="chevron-down" size={16} className="ds-select-caret" />
      </button>
      {open && body}
    </div>
  );
}
