import { useState } from 'react';
import { useBuildings, useFloors, useSites } from '../api/hooks';
import Icon from './Icon';
import { useLocationScope } from '../state/LocationContext';

/**
 * Site → building → floor as a NATIVE picker, not a form of dropdowns.
 *
 * The sheet keeps its full height the whole time: the closed state is three
 * field rows (label · current value · chevron); tapping one slides a
 * full-height LIST PAGE over the rows — search on top, scrolling options
 * below, back in the header. Nothing resizes, nothing expands in place —
 * the earlier inline-expanding selects made the sheet jump around, which
 * reads as broken on a phone.
 *
 * Every level stays optional — picking just a site is a valid scope.
 */
type Level = 'site' | 'building' | 'floor';

interface Option {
  id: number | undefined;
  label: string;
  sub?: string;
}

export default function LocationPicker() {
  const { scope, names, setLocation, clearLocation } = useLocationScope();
  const sites = useSites();
  const buildings = useBuildings();
  const floors = useFloors();
  const [page, setPage] = useState<Level | null>(null);
  const [query, setQuery] = useState('');

  const loading = sites.isLoading || buildings.isLoading || floors.isLoading;

  const optionsFor = (level: Level): Option[] => {
    if (level === 'site') {
      return [
        { id: undefined, label: 'All sites' },
        ...(sites.data ?? []).map((s) => ({ id: s.id, label: s.name })),
      ];
    }
    if (level === 'building') {
      return [
        { id: undefined, label: 'All buildings' },
        ...(buildings.data ?? [])
          .filter((b) => !scope.siteId || b.siteId === scope.siteId)
          .map((b) => ({ id: b.id, label: b.name })),
      ];
    }
    return [
      { id: undefined, label: 'All floors' },
      ...(floors.data ?? [])
        .filter((f) => !scope.buildingId || f.buildingId === scope.buildingId)
        .map((f) => ({ id: f.id, label: f.name })),
    ];
  };

  const currentId = (level: Level) =>
    level === 'site' ? scope.siteId : level === 'building' ? scope.buildingId : scope.floorId;

  const pick = (level: Level, option: Option) => {
    if (level === 'site') {
      setLocation({ scope: { siteId: option.id }, names: { site: option.id ? option.label : undefined } });
    } else if (level === 'building') {
      setLocation({
        scope: { siteId: scope.siteId, buildingId: option.id },
        names: { site: names.site, building: option.id ? option.label : undefined },
      });
    } else {
      setLocation({
        scope: { siteId: scope.siteId, buildingId: scope.buildingId, floorId: option.id },
        names: { site: names.site, building: names.building, floor: option.id ? option.label : undefined },
      });
    }
    setPage(null);
    setQuery('');
  };

  const FIELD_LABEL: Record<Level, string> = { site: 'Site', building: 'Building', floor: 'Floor' };
  const FIELD_VALUE: Record<Level, string> = {
    site: names.site ?? 'All sites',
    building: names.building ?? 'All buildings',
    floor: names.floor ?? 'All floors',
  };

  if (page) {
    const rows = optionsFor(page).filter(
      (o) => !query.trim() || o.label.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const selected = currentId(page);
    return (
      <div className="lp lp-page">
        <div className="lp-page-head">
          <button
            type="button"
            className="lp-back"
            aria-label="Back"
            onClick={() => {
              setPage(null);
              setQuery('');
            }}
          >
            <Icon name="chevron-left" size={20} />
          </button>
          <h3>{FIELD_LABEL[page]}</h3>
        </div>
        <div className="lp-search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${FIELD_LABEL[page].toLowerCase()}s…`}
            aria-label={`Search ${FIELD_LABEL[page].toLowerCase()}s`}
          />
        </div>
        <div className="lp-list scroll-y" role="listbox" aria-label={FIELD_LABEL[page]}>
          {loading && <p className="muted small">Loading locations…</p>}
          {!loading && rows.length === 0 && <p className="muted small">Nothing matches.</p>}
          {rows.map((option) => (
            <button
              key={option.id ?? 'all'}
              type="button"
              role="option"
              aria-selected={option.id === selected}
              className={option.id === selected ? 'lp-opt selected' : 'lp-opt'}
              onClick={() => pick(page, option)}
            >
              <span className="lp-opt-label">{option.label}</span>
              {option.id === selected && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="lp">
      {(['site', 'building', 'floor'] as const).map((level) => (
        <button key={level} type="button" className="lp-row" onClick={() => setPage(level)}>
          <span className="lp-row-label">{FIELD_LABEL[level]}</span>
          <span className="lp-row-value">{FIELD_VALUE[level]}</span>
          <Icon name="chevron-right" size={16} className="lp-row-chev" />
        </button>
      ))}
      {(scope.siteId || scope.buildingId || scope.floorId) && (
        <button className="link-btn" onClick={clearLocation}>
          Clear
        </button>
      )}
      {loading && <span className="muted small">Loading locations…</span>}
    </div>
  );
}
