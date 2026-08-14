// WS-B acceptance: the AR layout engine (src/ar/ArSpace) as a layout engine —
// cards never pile up, never sink into the dock band, and out-of-view markers
// are represented by at most four chevrons a side.
//
// jsdom has no layout: offsetWidth/offsetHeight are stubbed and the pose is
// pinned with the test hooks, then one synchronous layout pass is run.
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArCard,
  ArSpace,
  DOCK_CLEAR_PX,
  __layoutForTest,
  __resetPoseForTest,
  __setPoseForTest,
} from '../ar/ArSpace';

const CARD_W = 200;
const CARD_H = 64;
const CARD_BASE_Y = 0.5;

let widthSpy: PropertyDescriptor | undefined;
let heightSpy: PropertyDescriptor | undefined;

beforeAll(() => {
  widthSpy = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetWidth');
  heightSpy = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => CARD_W,
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => CARD_H,
  });
});

afterAll(() => {
  if (widthSpy) Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', widthSpy);
  if (heightSpy) Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', heightSpy);
});

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The rAF loop writes transforms straight to the DOM — read them back.
 * Cards are TOP-ANCHORED: the top-centre sits on the projected point, so the
 * anchor dot is the aimed pixel and the plate hangs below it. */
function rectOf(el: HTMLElement): Rect | null {
  const m = el.style.transform.match(
    /translate3d\(calc\(-50% \+ (-?[\d.]+)px\), (-?[\d.]+)px, 0\) scale\(([\d.]+)\)/,
  );
  if (!m) return null;
  const [dx, dy, scale] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cx = window.innerWidth / 2 + dx;
  const top = window.innerHeight * CARD_BASE_Y + dy;
  const w = (CARD_W * scale) / 2;
  return { left: cx - w, right: cx + w, top, bottom: top + CARD_H * scale };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function Stage({ markers }: { markers: { id: string; heading: number; pitch: number }[] }) {
  return (
    <ArSpace active={false}>
      {markers.map((m) => (
        <ArCard key={m.id} heading={m.heading} pitch={m.pitch} edgeLabel={m.id}>
          <div className="ar-asset-tag">{m.id}</div>
        </ArCard>
      ))}
    </ArSpace>
  );
}

function cardsOf(container: HTMLElement): HTMLElement[] {
  // hidden cards keep their last transform — only the visible ones are "laid out"
  return [...container.querySelectorAll<HTMLElement>('div[style*="translate3d"]')].filter(
    (el) => el.style.visibility !== 'hidden',
  );
}

function chevronsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button.vs-edge')].filter(
    (b) => b.style.display === 'flex',
  );
}

describe('AR layout engine', () => {
  it('8 in-view markers: no two card rects overlap', () => {
    // four bearing columns, two markers each — the pile-up case the collision
    // push-down exists for
    const markers = [-30, -30, -10, -10, 10, 10, 30, 30].map((heading, i) => ({
      id: `m${i}`,
      heading: (heading + 360) % 360,
      pitch: i % 2 === 0 ? 0 : -2,
    }));
    const { container } = render(<Stage markers={markers} />);
    __setPoseForTest(0, 0);
    __layoutForTest();

    const rects = cardsOf(container)
      .map(rectOf)
      .filter((r): r is Rect => r !== null);
    expect(rects).toHaveLength(8);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(
          overlaps(rects[i], rects[j]),
          `card ${i} overlaps card ${j}`,
        ).toBe(false);
      }
    }
  });

  it('keeps the bottom dock band free even for a steeply pitched marker', () => {
    const markers = [
      { id: 'level', heading: 0, pitch: 0 },
      { id: 'floor', heading: 12, pitch: -60 }, // way below the horizon
    ];
    const { container } = render(<Stage markers={markers} />);
    __setPoseForTest(0, 0);
    __layoutForTest();

    const floor = window.innerHeight - DOCK_CLEAR_PX;
    for (const rect of cardsOf(container).map(rectOf)) {
      expect(rect).not.toBeNull();
      expect((rect as Rect).bottom).toBeLessThanOrEqual(floor);
    }
  });

  it('out-of-view markers become at most 4 chevrons per side', () => {
    const markers = [
      ...[80, 84, 88, 92, 96, 100].map((heading, i) => ({ id: `r${i}`, heading, pitch: 0 })),
      ...[260, 264, 268, 272, 276, 280].map((heading, i) => ({ id: `l${i}`, heading, pitch: 0 })),
    ];
    const { container } = render(<Stage markers={markers} />);
    __setPoseForTest(0, 0);
    __layoutForTest();

    // every marker is >55° off-axis, so no cards are laid out at all
    expect(cardsOf(container)).toHaveLength(0);

    const shown = chevronsOf(container);
    const right = shown.filter((b) => b.style.right === '6px');
    const left = shown.filter((b) => b.style.left === '6px');
    expect(right.length).toBeLessThanOrEqual(4);
    expect(left.length).toBeLessThanOrEqual(4);
    expect(right.length + left.length).toBe(shown.length);
    expect(shown.length).toBe(8); // 4 a side out of 12 markers
  });

  it('WITHOUT A POSE, NOTHING IS DRAWN — no pile in the centre of the frame', () => {
    // The reported bug: open a survey with no compass and every marker was
    // stacked on the crosshair, five wrong answers drawn as confidently as
    // one right one. Hidden is the only honest output; the screen shows the
    // "enable the compass" banner instead.
    const markers = [0, 40, 120, 200, 300].map((heading, i) => ({
      id: `m${i}`,
      heading,
      pitch: 0,
    }));
    const { container } = render(<Stage markers={markers} />);

    __resetPoseForTest();
    __layoutForTest();
    expect(cardsOf(container)).toHaveLength(0);
    expect(chevronsOf(container)).toHaveLength(0);

    // and they come straight back once the sensor answers
    __setPoseForTest(0, 0);
    __layoutForTest();
    expect(cardsOf(container).length).toBeGreaterThan(0);
  });

  it('turning to face a marker brings it back to the same spot', () => {
    const markers = [{ id: 'only', heading: 90, pitch: 0 }];
    const { container } = render(<Stage markers={markers} />);

    __setPoseForTest(90, 0);
    __layoutForTest();
    const centred = rectOf(cardsOf(container)[0]) as Rect;
    expect(centred.left + CARD_W / 2).toBeCloseTo(window.innerWidth / 2, 0);

    __setPoseForTest(200, 0); // turn away — off-screen, chevron takes over
    __layoutForTest();
    expect(cardsOf(container)).toHaveLength(0);
    expect(chevronsOf(container)).toHaveLength(1);

    __setPoseForTest(90, 0); // turn back — exactly where it was left
    __layoutForTest();
    const again = rectOf(cardsOf(container)[0]) as Rect;
    expect(again).toEqual(centred);
  });
});
