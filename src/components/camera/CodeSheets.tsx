// QR registry sheets: link an unknown code, or resolve a CONFLICT where the
// registry and the code's own encoded id disagree. The conflict sheet ASKS —
// it never auto-picks, never silently repoints (roadmap 3, QR lane).
import { useEffect, useState } from 'react';
import { provider } from '../../api/provider';
import { appStore } from '../../api/appStore';
import type { Asset, CodeEntry, Floor, Space } from '../../api/types';
import DsSelect from '../DsSelect';
import {
  describeEntry,
  linkCode,
  resolveCode,
  type CodeResolution,
  type CodeTarget,
} from '../../vision/codes';
import './camera.css';

export interface CodeSheetProps {
  code: string;
  siteId?: number;
  onClose(): void;
  onLinked?(entry: CodeEntry): void;
}

/** Resolves the code, then renders the right sheet for what it finds. */
export function CodeSheet({ code, siteId, onClose, onLinked }: CodeSheetProps) {
  const [resolution, setResolution] = useState<CodeResolution | null>(null);

  useEffect(() => {
    let on = true;
    void resolveCode(code).then((r) => {
      if (on) setResolution(r);
    });
    return () => {
      on = false;
    };
  }, [code]);

  return (
    <div className="fv-sheet-backdrop">
      <div className="fv-sheet" role="dialog" aria-label="QR code">
        {!resolution && <p className="muted">Checking code…</p>}
        {resolution?.kind === 'target' && (
          <KnownTarget entry={resolution.entry} onClose={onClose} />
        )}
        {resolution?.kind === 'unknown' && (
          <LinkCodeForm code={resolution.code} siteId={siteId} onClose={onClose} onLinked={onLinked} />
        )}
        {resolution?.kind === 'conflict' && (
          <ConflictForm
            code={resolution.code}
            entry={resolution.entry}
            impliedAssetId={resolution.impliedAssetId}
            onClose={onClose}
            onLinked={onLinked}
          />
        )}
      </div>
    </div>
  );
}

function KnownTarget({ entry, onClose }: { entry: CodeEntry; onClose(): void }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    if (entry.type === 'asset' && entry.assetId) {
      void provider.getAsset(entry.assetId).then((a) => {
        if (on && a) setName(a.name);
      });
    }
    return () => {
      on = false;
    };
  }, [entry]);
  return (
    <>
      <h3>Code recognized</h3>
      <p>
        This code is linked to <strong>{name ?? describeEntry(entry)}</strong>.
      </p>
      <div className="fv-sheet-actions">
        <button className="fv-btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}

// ---- link an unknown code ----

type LinkType = CodeEntry['type'];

function LinkCodeForm({
  code,
  siteId,
  onClose,
  onLinked,
}: {
  code: string;
  siteId?: number;
  onClose(): void;
  onLinked?(entry: CodeEntry): void;
}) {
  const [type, setType] = useState<LinkType>('asset');
  const [target, setTarget] = useState<CodeTarget | null>(null);
  const [targetLabel, setTargetLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const link = async () => {
    if (!target || busy) return;
    setBusy(true);
    const entry = await linkCode(code, target);
    onLinked?.(entry);
    onClose();
  };

  return (
    <>
      <h3>Link this code</h3>
      <p className="muted">
        <code className="fv-code">{code}</code> isn’t registered yet. Pick what it identifies.
      </p>
      <DsSelect
        label="Type"
        value={type}
        options={[
          { value: 'asset', label: 'Asset' },
          { value: 'space', label: 'Space' },
          { value: 'floor', label: 'Floor' },
          { value: 'survey', label: 'Survey' },
        ]}
        onChange={(v) => {
          setType(v as LinkType);
          setTarget(null);
          setTargetLabel('');
        }}
      />
      <TargetPicker
        key={type}
        type={type}
        siteId={siteId}
        onPick={(t, label) => {
          setTarget(t);
          setTargetLabel(label);
        }}
      />
      {target && (
        <p>
          Linking to <strong>{targetLabel}</strong>
        </p>
      )}
      <div className="fv-sheet-actions">
        <button className="fv-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="fv-btn-primary" disabled={!target || busy} onClick={() => void link()}>
          Link code
        </button>
      </div>
    </>
  );
}

function TargetPicker({
  type,
  siteId,
  onPick,
}: {
  type: LinkType;
  siteId?: number;
  onPick(target: CodeTarget, label: string): void;
}) {
  if (type === 'asset') return <AssetSearchPicker siteId={siteId} onPick={onPick} />;
  if (type === 'space') return <SpacePicker siteId={siteId} onPick={onPick} />;
  if (type === 'floor') return <FloorPicker onPick={onPick} />;
  return <SurveyPicker onPick={onPick} />;
}

function AssetSearchPicker({
  siteId,
  onPick,
}: {
  siteId?: number;
  onPick(target: CodeTarget, label: string): void;
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
        placeholder="Search assets by name…"
        aria-label="Search assets"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ul className="fv-asset-results">
        {results.map((a) => (
          <li key={a.id}>
            <button onClick={() => onPick({ type: 'asset', assetId: a.id }, a.name)}>
              {a.name}
              {a.spaceName && <span className="muted"> · {a.spaceName}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SpacePicker({
  siteId,
  onPick,
}: {
  siteId?: number;
  onPick(target: CodeTarget, label: string): void;
}) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [value, setValue] = useState('');
  useEffect(() => {
    let on = true;
    void provider.listAllSpaces().then((rows) => {
      if (on) setSpaces(siteId ? rows.filter((s) => s.siteId === siteId) : rows);
    });
    return () => {
      on = false;
    };
  }, [siteId]);
  return (
    <DsSelect
      label="Space"
      value={value}
      placeholder="Pick a space"
      options={spaces.map((s) => ({ value: String(s.id), label: s.name }))}
      onChange={(v) => {
        setValue(v);
        const space = spaces.find((s) => String(s.id) === v);
        if (space) onPick({ type: 'space', spaceId: space.id }, space.name);
      }}
    />
  );
}

function FloorPicker({ onPick }: { onPick(target: CodeTarget, label: string): void }) {
  const [floors, setFloors] = useState<Floor[]>([]);
  const [value, setValue] = useState('');
  useEffect(() => {
    let on = true;
    void provider.listFloors().then((rows) => {
      if (on) setFloors(rows);
    });
    return () => {
      on = false;
    };
  }, []);
  return (
    <DsSelect
      label="Floor"
      value={value}
      placeholder="Pick a floor"
      options={floors.map((f) => ({ value: String(f.id), label: f.name }))}
      onChange={(v) => {
        setValue(v);
        const floor = floors.find((f) => String(f.id) === v);
        if (floor) onPick({ type: 'floor', floorId: floor.id }, floor.name);
      }}
    />
  );
}

function SurveyPicker({ onPick }: { onPick(target: CodeTarget, label: string): void }) {
  const [surveys, setSurveys] = useState<{ id: string; name: string }[]>([]);
  const [value, setValue] = useState('');
  useEffect(() => {
    let on = true;
    void appStore
      .kvList<{ id: string; name?: string }>('surveys', 'survey.', 100)
      .then((rows) => {
        if (on) {
          setSurveys(rows.map((r) => ({ id: r.value.id, name: r.value.name ?? r.key })));
        }
      });
    return () => {
      on = false;
    };
  }, []);
  if (surveys.length === 0) return <p className="muted">No surveys yet.</p>;
  return (
    <DsSelect
      label="Survey"
      value={value}
      placeholder="Pick a survey"
      options={surveys.map((s) => ({ value: s.id, label: s.name }))}
      onChange={(v) => {
        setValue(v);
        const survey = surveys.find((s) => s.id === v);
        if (survey) onPick({ type: 'survey', surveyId: survey.id }, survey.name);
      }}
    />
  );
}

// ---- conflict: registry vs the id the code itself encodes ----

function ConflictForm({
  code,
  entry,
  impliedAssetId,
  onClose,
  onLinked,
}: {
  code: string;
  entry: CodeEntry;
  impliedAssetId: number;
  onClose(): void;
  onLinked?(entry: CodeEntry): void;
}) {
  const [registryLabel, setRegistryLabel] = useState(describeEntry(entry));
  const [impliedLabel, setImpliedLabel] = useState(`Asset #${impliedAssetId}`);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    void provider.getAsset(impliedAssetId).then((a) => {
      if (on && a) setImpliedLabel(a.name);
    });
    if (entry.type === 'asset' && entry.assetId) {
      void provider.getAsset(entry.assetId).then((a) => {
        if (on && a) setRegistryLabel(a.name);
      });
    } else if (entry.type === 'space' && entry.spaceId) {
      void provider.listAllSpaces().then((rows) => {
        const space = rows.find((s) => s.id === entry.spaceId);
        if (on && space) setRegistryLabel(space.name);
      });
    } else if (entry.type === 'floor' && entry.floorId) {
      void provider.listFloors().then((rows) => {
        const floor = rows.find((f) => f.id === entry.floorId);
        if (on && floor) setRegistryLabel(floor.name);
      });
    }
    return () => {
      on = false;
    };
  }, [entry, impliedAssetId]);

  const choose = async (target: CodeTarget) => {
    if (busy) return;
    setBusy(true);
    const next = await linkCode(code, target);
    onLinked?.(next);
    onClose();
  };

  const keepTarget: CodeTarget =
    entry.type === 'asset'
      ? { type: 'asset', assetId: entry.assetId ?? 0 }
      : entry.type === 'space'
        ? { type: 'space', spaceId: entry.spaceId ?? 0 }
        : entry.type === 'floor'
          ? { type: 'floor', floorId: entry.floorId ?? 0 }
          : { type: 'survey', surveyId: entry.surveyId ?? '' };

  return (
    <div role="alertdialog" aria-label="QR code conflict">
      <h3>This code points to two different things</h3>
      <p>
        The registry maps <code className="fv-code">{code}</code> to{' '}
        <strong>{registryLabel}</strong> ({describeEntry(entry)}), but the code itself encodes{' '}
        <strong>{impliedLabel}</strong> (Asset #{impliedAssetId}).
      </p>
      <p>
        <strong>Which one is correct?</strong> Nothing changes until you choose.
      </p>
      <div className="fv-sheet-actions fv-sheet-actions-col">
        <button className="fv-btn-secondary" disabled={busy} onClick={() => void choose(keepTarget)}>
          Keep {registryLabel}
        </button>
        <button
          className="fv-btn-secondary"
          disabled={busy}
          onClick={() => void choose({ type: 'asset', assetId: impliedAssetId })}
        >
          Relink to {impliedLabel}
        </button>
        <button className="fv-btn-plain" onClick={onClose}>
          Decide later
        </button>
      </div>
    </div>
  );
}
