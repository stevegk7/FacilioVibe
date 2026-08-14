// The plate has two data paths and mock mode can only exercise one of them:
// mockProvider ships `plans: {}` on purpose, so a demo session always renders the
// schematic path. These cover the CAD path with the real shape from
// public/plans/*.json — layers.walls as [[x,z],...] polylines and rooms carrying
// x0/z0/x1/z1 — so the wiring cannot rot unnoticed against the only floors in the
// live org that have geometry.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FloorPlate from '../components/FloorPlate';

/** A slice shaped exactly like albalawi-ground.json. */
const PLAN = {
  walls: [
    [[-6, -4], [6, -4]],
    [[6, -4], [6, 4]],
    [[6, 4], [-6, 4]],
    [[-6, 4], [-6, -4]],
  ],
  rooms: [
    { x0: -5.5, z0: -3.5, x1: -0.5, z1: 3.5 },
    { x0: 0.5, z0: -3.5, x1: 5.5, z1: 3.5 },
  ],
};

const ROUTE = [
  { x: -3, z: 0 },
  { x: 0, z: 0 },
  { x: 3, z: 1.5 },
];

describe('FloorPlate — CAD path', () => {
  it('draws walls, rooms and the route, framed in metres', () => {
    const { container } = render(<FloorPlate geometry={PLAN} route={ROUTE} label="Ground Floor" />);

    expect(container.querySelectorAll('.wf-plate-wall')).toHaveLength(4);
    expect(container.querySelectorAll('.wf-plate-room')).toHaveLength(2);
    expect(container.querySelectorAll('.wf-plate-route')).toHaveLength(1);

    // viewBox is the floor extent plus padding, in metres — z maps straight to
    // SVG y with no flip, because +z IS the drawing's down.
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('-7.5 -5.5 15 11');
  });

  it('names the floor for a screen reader rather than drawing the label', () => {
    const { container } = render(<FloorPlate geometry={PLAN} route={ROUTE} label="Level 2" />);
    expect(container.querySelector('.wf-plate')).toHaveAttribute('aria-label', 'Route on Level 2');
    // The plate is one image; its internals must not be announced piecemeal.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('extends the frame to contain a route that leaves the drawn geometry', () => {
    // A leg can legitimately end at a stair core the plan does not cover.
    const { container } = render(
      <FloorPlate geometry={PLAN} route={[{ x: 0, z: 0 }, { x: 20, z: 0 }]} />,
    );
    const [minX, , width] = (container.querySelector('svg')!.getAttribute('viewBox') as string)
      .split(' ')
      .map(Number);
    expect(minX + width).toBeGreaterThanOrEqual(20);
  });

  it('renders the schematic path when there is no bound plan', () => {
    const { container } = render(
      <FloorPlate geometry={{ spaces: [[[0, 0], [8, 0], [8, 6], [0, 6]]] }} route={ROUTE} />,
    );
    expect(container.querySelectorAll('.wf-plate-wall')).toHaveLength(0);
    expect(container.querySelectorAll('.wf-plate-room')).toHaveLength(1);
    expect(container.querySelector('.wf-plate-route')).toBeTruthy();
  });

  it('draws nothing at all rather than a smear when there is no geometry', () => {
    const { container } = render(<FloorPlate geometry={{}} route={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('omits the route line for a single point, keeping the start marker', () => {
    const { container } = render(
      <FloorPlate geometry={PLAN} route={[{ x: 0, z: 0 }]} />,
    );
    expect(container.querySelector('.wf-plate-route')).toBeNull();
    expect(container.querySelector('.wf-plate-start')).toBeTruthy();
    expect(container.querySelector('.wf-plate-end')).toBeNull();
  });
});
