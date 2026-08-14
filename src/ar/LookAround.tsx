/**
 * Look around — the sweep photos, in bearing order, with the survey's markers
 * drawn where they actually are.
 *
 * This is the view for someone who has NOT arrived yet: no camera, no compass,
 * no standing in the right spot. Swipe the room and see which thing is which.
 */
import { useEffect, useRef, useState } from 'react';
import { appStore } from '../api/appStore';
import Icon from '../components/Icon';
import { markersByFrame, viewableFrames } from './panorama';
import type { Survey } from '../api/types';
import './lookAround.css';

export default function LookAround({ survey }: { survey: Survey }) {
  const frames = viewableFrames(survey);
  const overlays = markersByFrame(survey);
  const [index, setIndex] = useState(0);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const trackRef = useRef<HTMLDivElement>(null);

  // Object URLs are session-scoped and cached by fileId — never persisted.
  useEffect(() => {
    let live = true;
    void Promise.all(
      frames.map(async ({ frame, index: i }) => {
        if (frame.fileId == null) return;
        try {
          const url = await appStore.getPhotoUrl(frame.fileId);
          if (live) setUrls((prev) => (prev[i] ? prev : { ...prev, [i]: url }));
        } catch {
          /* a missing photo just leaves that frame blank */
        }
      }),
    );
    return () => {
      live = false;
    };
  }, [survey.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (frames.length === 0) {
    return (
      <p className="la-empty">
        This survey was captured before sweep photos were kept, so there is nothing to look at
        yet. Re-sweep the standpoint to build one.
      </p>
    );
  }

  const step = (dir: -1 | 1) => {
    const next = Math.min(frames.length - 1, Math.max(0, index + dir));
    setIndex(next);
    trackRef.current?.scrollTo({ left: next * (trackRef.current.clientWidth || 0), behavior: 'smooth' });
  };

  const current = frames[index];

  return (
    <div className="la">
      <div
        className="la-track scroll-y"
        ref={trackRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const w = el.clientWidth || 1;
          const i = Math.round(el.scrollLeft / w);
          if (i !== index && i >= 0 && i < frames.length) setIndex(i);
        }}
      >
        {frames.map(({ frame, index: frameIndex }, i) => (
          <figure className="la-slide" key={frameIndex}>
            {urls[frameIndex] ? (
              <img className="la-img" src={urls[frameIndex]} alt={`Sweep frame ${i + 1}`} />
            ) : (
              <div className="la-img la-loading" aria-hidden="true" />
            )}

            {overlays[frameIndex]?.map((hit) => (
              <button
                key={hit.marker.id}
                className={hit.marker.assetId ? 'la-pin asset' : 'la-pin note'}
                style={{ left: `${hit.x * 100}%`, top: `${hit.y * 100}%` }}
                title={hit.marker.label}
              >
                <Icon name={hit.marker.assetId ? 'wrench' : 'note'} size={16} />
                <span className="la-pin-label">{hit.marker.label}</span>
              </button>
            ))}

            <figcaption className="la-caption">
              {Math.round(frame.heading)}° · frame {i + 1} of {frames.length}
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="la-controls">
        <button className="la-nav" onClick={() => step(-1)} disabled={index === 0} aria-label="Previous frame">
          <Icon name="chevron-left" size={20} />
        </button>
        <span className="la-dots" aria-hidden="true">
          {frames.map((_, i) => (
            <span key={i} className={i === index ? 'la-dot on' : 'la-dot'} />
          ))}
        </span>
        <button
          className="la-nav next"
          onClick={() => step(1)}
          disabled={index === frames.length - 1}
          aria-label="Next frame"
        >
          <Icon name="chevron-left" size={20} />
        </button>
      </div>

      <p className="la-hint">
        Photos from the 360° sweep at {Math.round(current?.frame.heading ?? 0)}°. Markers sit
        where they were placed — use this to recognise the equipment before you get there.
      </p>
    </div>
  );
}
