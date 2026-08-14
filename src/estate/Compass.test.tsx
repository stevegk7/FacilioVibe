// The compass is driven per frame from the engine rather than from React
// state, so the thing worth pinning is exactly that: the needle follows a
// changing heading without the component re-rendering, and it survives an
// engine that is missing, dead, or older than this feature.
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Compass from './Compass';
import type { EstateEngineApi } from './types';

/** Only getHeading is exercised; the rest of the surface is irrelevant here. */
function engineWith(heading: () => number) {
  return { current: { getHeading: heading } as unknown as EstateEngineApi };
}

const dial = () => document.querySelector('.est-compass-dial') as HTMLElement;

describe('Compass', () => {
  it('points at the camera heading, converted to degrees', async () => {
    render(<Compass engineRef={engineWith(() => Math.PI / 2)} />);
    await waitFor(() => expect(dial().style.transform).toBe('rotate(90deg)'));
  });

  it('follows the heading as it changes, without a re-render', async () => {
    let heading = 0;
    render(<Compass engineRef={engineWith(() => heading)} />);
    await waitFor(() => expect(dial().style.transform).toBe('rotate(0deg)'));

    // Nothing tells React about this — the rAF loop is the only path.
    heading = Math.PI;
    await waitFor(() => expect(dial().style.transform).toBe('rotate(180deg)'));
  });

  it('renders north, and stays out of the tab order — it is a readout', () => {
    render(<Compass engineRef={engineWith(() => 0)} />);
    expect(screen.getByText('N')).toBeInTheDocument();
    expect(document.querySelector('.est-compass')).toHaveAttribute('aria-hidden', 'true');
  });

  it('survives no engine, and an engine too old to have getHeading', async () => {
    // The canvas is shared and parked between screens, so the ref can hold an
    // engine from before this feature existed — or nothing at all.
    const { unmount } = render(<Compass engineRef={{ current: null }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(dial().style.transform).toBe('');
    unmount();

    render(<Compass engineRef={{ current: {} as EstateEngineApi }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(dial().style.transform).toBe('');
  });

  it('ignores a heading that is not a number rather than writing NaN', async () => {
    render(<Compass engineRef={engineWith(() => Number.NaN)} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(dial().style.transform).toBe('');
  });
});
