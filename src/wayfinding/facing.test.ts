// The facing indicator's whole job is to be honest, so most of these pin the
// REFUSALS rather than the maths: a heading that is not north-referenced, a
// sensor that reports it does not know, a step with no bearing.
import { describe, expect, it } from 'vitest';
import {
  CONE_MAX_DEG,
  CONE_MIN_DEG,
  CONE_UNKNOWN_DEG,
  canShowFacing,
  coneHalfAngleDeg,
  relativeBearing,
  turnPhrase,
} from './facing';

const live = { ok: true, absolute: true };

describe('relativeBearing', () => {
  it('is zero when you already face the step', () => {
    expect(relativeBearing(90, 90)).toBe(0);
  });

  it('is negative to the left and positive to the right', () => {
    expect(relativeBearing(0, 90)).toBe(-90);
    expect(relativeBearing(90, 0)).toBe(90);
  });

  it('takes the short way round the compass', () => {
    // Facing 350°, target 10° — a 20° turn right, not 340° left.
    expect(relativeBearing(10, 350)).toBe(20);
    expect(relativeBearing(350, 10)).toBe(-20);
  });

  it('resolves the antipode consistently rather than flipping sign', () => {
    expect(Math.abs(relativeBearing(0, 180))).toBe(180);
  });
});

describe('coneHalfAngleDeg', () => {
  it('uses the reported error when the platform gives one', () => {
    expect(coneHalfAngleDeg(25)).toBe(25);
  });

  it('assumes the degraded end when nothing is reported', () => {
    // Android's absolute event carries no accuracy at all.
    expect(coneHalfAngleDeg(undefined)).toBe(CONE_UNKNOWN_DEG);
  });

  it('never claims to be better than a magnetometer can be indoors', () => {
    expect(coneHalfAngleDeg(0)).toBe(CONE_MIN_DEG);
    expect(coneHalfAngleDeg(2)).toBe(CONE_MIN_DEG);
  });

  it('caps the width rather than drawing most of the horizon', () => {
    expect(coneHalfAngleDeg(180)).toBe(CONE_MAX_DEG);
  });
});

describe('canShowFacing — the refusals', () => {
  it('shows when the step has a bearing and the compass is north-referenced', () => {
    expect(canShowFacing(90, { ...live, accuracyDeg: 20 })).toBe(true);
  });

  it('refuses a step with no bearing — most indoor edges have none', () => {
    expect(canShowFacing(undefined, { ...live, accuracyDeg: 20 })).toBe(false);
  });

  it('refuses a relative heading — a session origin is not a bearing', () => {
    // The single most dangerous case: the number looks fine and means nothing.
    expect(canShowFacing(90, { ok: true, absolute: false, accuracyDeg: 5 })).toBe(false);
  });

  it('refuses before the first sensor event lands', () => {
    expect(canShowFacing(90, { ok: false, absolute: true })).toBe(false);
  });

  it('refuses when the sensor reports it does not know', () => {
    expect(canShowFacing(90, { ...live, accuracyDeg: 90 })).toBe(false);
  });

  it('still shows with no reported accuracy — Android, at the degraded width', () => {
    expect(canShowFacing(90, live)).toBe(true);
  });

  it('refuses a non-finite bearing', () => {
    expect(canShowFacing(Number.NaN, { ...live, accuracyDeg: 10 })).toBe(false);
  });
});

describe('turnPhrase', () => {
  it('says ahead only inside the band a cone can defend', () => {
    expect(turnPhrase(0)).toBe('straight ahead');
    expect(turnPhrase(-20)).toBe('straight ahead');
    expect(turnPhrase(21)).toBe('slightly right');
  });

  it('distinguishes a glance from a real turn', () => {
    expect(turnPhrase(45)).toBe('slightly right');
    expect(turnPhrase(-45)).toBe('slightly left');
    expect(turnPhrase(90)).toBe('to your right');
    expect(turnPhrase(-90)).toBe('to your left');
  });

  it('says behind you, which is the answer people most need at a lift lobby', () => {
    expect(turnPhrase(180)).toBe('behind you');
    expect(turnPhrase(-150)).toBe('behind you');
  });

  it('wraps values outside -180..180 rather than mis-phrasing them', () => {
    expect(turnPhrase(370)).toBe('straight ahead');
    expect(turnPhrase(-370)).toBe('straight ahead');
  });
});
