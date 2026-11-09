import { describe, expect, it } from 'vitest';
import { absorptionNeeded, advise, character, grade, median, ROOM_SIZES, USES } from '../src/verdict.ts';

const calls = USES.find((u) => u.id === 'calls')!;
const recording = USES.find((u) => u.id === 'recording')!;
const bedroom = ROOM_SIZES.find((r) => r.id === 'bedroom')!;

describe('verdicts', () => {
  it('grades against each use', () => {
    expect(grade(0.4, calls)).toBe('good');
    expect(grade(0.7, calls)).toBe('okay');
    expect(grade(0.9, calls)).toBe('poor');
    expect(grade(0.4, recording)).toBe('okay');
  });

  it('names the room', () => {
    expect(character(0.25).word).toBe('Dry');
    expect(character(0.9).word).toBe('Echoey');
  });

  it('uses Sabine to size the fix', () => {
    // 36 m³ room from 0.9 s to 0.5 s: 0.161 * 36 * (1/0.5 - 1/0.9) = 5.15 m²
    expect(absorptionNeeded(0.9, 0.5, 36)).toBeCloseTo(5.152, 2);
    expect(absorptionNeeded(0.4, 0.5, 36)).toBe(0);
  });

  it('suggests enough household items to cover the gap, thick ones first for boomy rooms', () => {
    const adv = advise(0.9, calls, bedroom, [
      { fc: 500, rt60: 1.2 },
      { fc: 1000, rt60: 0.9 },
      { fc: 2000, rt60: 0.7 },
      { fc: 4000, rt60: 0.6 },
    ]);
    const total = adv.fixes.reduce((s, f) => s + f.area, 0);
    expect(total).toBeGreaterThanOrEqual(adv.needed);
    expect(adv.bandNote).toMatch(/Low sounds/);
    expect(adv.fixes[0].thick).toBe(true);
  });

  it('suggests nothing when the room is already good', () => {
    expect(advise(0.35, calls, bedroom, []).fixes).toHaveLength(0);
  });

  it('takes the median of several claps', () => {
    expect(median([0.9, 0.5, 0.8])).toBe(0.8);
    expect(median([0.4, 0.6])).toBe(0.5);
  });
});
