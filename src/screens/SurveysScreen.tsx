// Surveys registry (roadmap 5): the standpoints this org has surveyed, their
// enrolled QR labels, and the marker list of each one. Authoring happens in
// the full-screen Place-Assets overlay; this screen is the library around it.
//
// Codes live in ONE registry (src/vision/codes) keyed by the normalized code —
// enrolling here and scanning in the AR stage must agree, so this screen never
// writes the 'codes' collection by hand.
//
// Mobile-native anatomy (matches the reference app): a scope chip + gradient
// CTA in a fixed head, ONE internally-scrolling list below it, and the survey
// detail as a bottom Sheet rather than a second full page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { appStore } from '../api/appStore';
import type { Survey, SurveyMarker } from '../api/types';
import { QrCode, printQrLabel } from '../ar/QrCode';
import LookAround from '../ar/LookAround';
import Sheet from '../components/Sheet';
import Icon from '../components/Icon';
import LocationPicker from '../components/LocationPicker';
import { useLocationScope } from '../state/LocationContext';
import { provider } from '../api/provider';
import { getCodeEntry, linkCode, unlinkCode } from '../vision/codes';
import { normalizeCode } from '../vision/qr';
import PlaceAssetsScreen from './PlaceAssetsScreen';
import '../ar/arspace.css';
import './surveys.css';

function useSurveys() {
  return useQuery({
    queryKey: ['surveys'],
    queryFn: () =>
      appStore
        .kvList<Survey>('surveys', 'survey.', 200)
        .then((rows) =>
          rows
            .map((r) => r.value)
            .filter((s) => s && Array.isArray(s.markers))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
        ),
  });
}

export default function SurveysScreen() {
  const surveys = useSurveys();
  // Which org am I looking at? Records are per-org, and the app is reachable
  // by users who belong to several — so never leave it implicit.
  const me = useQuery({ queryKey: ['me'], queryFn: () => provider.getCurrentUser() });
  const { names } = useLocationScope();
  const [openId, setOpenId] = useState<string | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);

  const rows = surveys.data ?? [];
  const selected = useMemo(() => rows.find((s) => s.id === openId) ?? null, [rows, openId]);
  const scopeLabel = names.floor ?? names.building ?? names.site ?? 'All sites';

  if (authoring) {
    return (
      <PlaceAssetsScreen onClose={() => setAuthoring(false)} onSaved={(id) => setOpenId(id)} />
    );
  }

  return (
    <section className="screen sv-screen">
      <header className="sv-head">
        <div className="sv-head-row">
          <span className="sv-title-wrap">
            <h2 className="sv-h1">Surveys</h2>
            <span className="sv-org">
              {me.data ? `Org ${me.data.org.orgId}` : 'Signing in…'} · build {__BUILD_ID__}
            </span>
          </span>
          <button
            className="sv-chip"
            aria-label={`Working scope: ${scopeLabel}`}
            onClick={() => setScopeOpen(true)}
          >
            <span className="sv-chip-text">{scopeLabel}</span>
            <span aria-hidden="true">· {rows.length} ⌄</span>
          </button>
        </div>
        <div className="sv-cta-row">
          {/* the authoring entry point — the AR survey overlay */}
          <button className="btn-cta" onClick={() => setAuthoring(true)}>
            <Icon name="compass" /> New survey
          </button>
        </div>
      </header>

      <div className="sv-list scroll-y">
        <div className="section-row">
          <span className="section-label">Standpoints ({rows.length})</span>
        </div>

        {surveys.isLoading && <p className="sv-status">Loading surveys…</p>}
        {/* Never dump an exception into the content area — the store's own
            unavailability notice is shown once, app-wide. */}
        {surveys.isError && <p className="sv-status">Couldn't load surveys. Pull to retry.</p>}

        {!surveys.isLoading && rows.length === 0 && (
          <p className="empty-card">
            A survey is a standpoint you have swept. Walking to it and scanning its label loads
            every marker pinned around that spot — with no searching.
          </p>
        )}

        {rows.length > 0 && (
          <div className="sv-rows">
            {rows.map((survey) => (
              <button
                key={survey.id}
                className="row-card"
                onClick={() => setOpenId(survey.id)}
              >
                <span className="sv-row-main">
                  <span className="row-card-title">{survey.name}</span>
                  <span className="row-card-meta">{metaLine(survey)}</span>
                </span>
                <span className={survey.qrCode ? 'row-badge ok' : 'row-badge'}>
                  {survey.qrCode ? 'QR' : 'No QR'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Sheet open={scopeOpen} title="Where are you working?" onClose={() => setScopeOpen(false)} size="tall">
        <div className="sv-selects">
          <LocationPicker />
        </div>
        <p className="sv-help">
          New surveys are stamped with this scope, and it is what the AR stage searches when it
          looks for the standpoint you are standing at.
        </p>
      </Sheet>

      {selected && <SurveyDetail survey={selected} onBack={() => setOpenId(null)} />}
    </section>
  );
}

function metaLine(survey: Survey): string {
  const assets = survey.markers.filter((m) => m.assetId).length;
  const notes = survey.markers.length - assets;
  return [
    survey.spaceName ?? 'Unscoped',
    `${assets} asset${assets === 1 ? '' : 's'}`,
    `${notes} note${notes === 1 ? '' : 's'}`,
    `${survey.sweep.length} sweep frames`,
  ].join(' · ');
}

function SurveyDetail({ survey, onBack }: { survey: Survey; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const qrBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let on = true;
    if (survey.standpointFileId) {
      void appStore
        .getPhotoUrl(survey.standpointFileId)
        .then((url) => {
          if (on) setPhotoUrl(url);
        })
        .catch(() => {
          /* a missing standpoint photo is not an error worth shouting about */
        });
    }
    return () => {
      on = false;
    };
  }, [survey.standpointFileId]);

  const generateCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const code = normalizeCode(`fv-sv-${survey.id}`);
      const existing = await getCodeEntry(code);
      if (existing && existing.surveyId !== survey.id) {
        setHint('That code already identifies something else — a code points at exactly one thing.');
        return;
      }
      await appStore.kvPut('surveys', `survey.${survey.id}`, { ...survey, qrCode: code });
      await linkCode(code, { type: 'survey', surveyId: survey.id });
      await queryClient.invalidateQueries({ queryKey: ['surveys'] });
      setHint('QR generated — print it and stick it at this standpoint.');
    } finally {
      setBusy(false);
    }
  };

  const print = () => {
    const svg = qrBoxRef.current?.querySelector('svg')?.outerHTML;
    if (!svg || !survey.qrCode) return;
    printQrLabel({
      code: survey.qrCode,
      title: survey.name,
      subtitle: survey.spaceName,
      svg,
    });
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (survey.qrCode) await unlinkCode(survey.qrCode);
      await appStore.kvDelete('surveys', `survey.${survey.id}`);
      await queryClient.invalidateQueries({ queryKey: ['surveys'] });
      onBack();
    } finally {
      setBusy(false);
    }
  };

  // Markers are stored relative to sweep frame 0; the ABSOLUTE reading is what
  // a compass shows while standing at the standpoint, so that is what we list.
  const base = survey.sweep[0]?.heading ?? 0;
  const abs = (m: SurveyMarker) => Math.round((base + m.heading + 360) % 360);
  const surveyed = new Date(survey.createdAt);

  return (
    <Sheet open title={survey.name} onClose={onBack} size="tall">
      {photoUrl && <img className="sv-photo" src={photoUrl} alt="Standpoint" />}

      <table className="info-table">
        <tbody>
          <tr>
            <th>Location</th>
            <td>
              {survey.spaceName ?? 'Unscoped'}
              {survey.geo
                ? ` · ${survey.geo.lat.toFixed(5)}, ${survey.geo.lng.toFixed(5)} (±${Math.round(survey.geo.accuracy)}m)`
                : ''}
            </td>
          </tr>
          <tr>
            <th>Surveyed</th>
            <td>{isNaN(surveyed.getTime()) ? survey.createdAt : surveyed.toLocaleString()}</td>
          </tr>
          <tr>
            <th>Sweep</th>
            <td>
              {survey.sweep.length} frames
              {survey.geo ? ` · ±${Math.round(survey.geo.accuracy)}m fix` : ''}
            </td>
          </tr>
          <tr>
            <th>Model</th>
            <td>{survey.modelId}</td>
          </tr>
        </tbody>
      </table>

      {!survey.qrCode ? (
        <div className="sv-card">
          <p className="sv-card-copy">
            No QR linked yet. Generating one mints a unique code for this standpoint — vendors
            scan it to load these markers with no searching.
          </p>
          <button className="btn-cta" disabled={busy} onClick={() => void generateCode()}>
            Generate QR for this survey
          </button>
        </div>
      ) : (
        <div className="sv-card">
          <div className="sv-qr-art" ref={qrBoxRef}>
            <QrCode value={survey.qrCode} size={152} />
          </div>
          <p className="sv-card-copy">
            Code <strong>{survey.qrCode}</strong>
            {survey.qrHeading != null ? ` · enrolled facing ${Math.round(survey.qrHeading)}°` : ''}
          </p>
          <button className="btn-quiet" onClick={print}>
            Print label
          </button>
        </div>
      )}

      {hint && (
        <p className="sv-hint" role="status">
          {hint}
        </p>
      )}

      <div className="section-row">
        <span className="section-label">Look around</span>
      </div>
      <LookAround survey={survey} />

      <div className="section-row">
        <span className="section-label">Markers ({survey.markers.length})</span>
      </div>

      {survey.markers.length === 0 && (
        <p className="empty-card">
          No markers on this standpoint yet — open it in the AR stage to pin assets and notes
          around you.
        </p>
      )}

      {survey.markers.map((marker) => (
        <div className="sv-marker" key={marker.id}>
          <span className="sv-marker-icon" aria-hidden="true">
            <Icon name={marker.assetId ? 'wrench' : 'note'} size={18} />
          </span>
          <span className="sv-marker-main">
            <span className="sv-marker-name">{marker.label}</span>
            <span className="sv-marker-meta">
              bearing {abs(marker)}° · pitch {Math.round(marker.pitch)}°
            </span>
          </span>
        </div>
      ))}

      <div className="sv-delete">
        <button className="btn-danger-outline" disabled={busy} onClick={() => void remove()}>
          Delete survey
        </button>
      </div>
    </Sheet>
  );
}
