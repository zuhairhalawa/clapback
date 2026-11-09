import { describe, expect, it } from 'vitest';
import { analyzeClap } from '../src/dsp/analyze.ts';
import { synthClap } from '../src/dsp/synth.ts';

const RTS = [0.2, 0.35, 0.5, 0.8, 1.2, 2.0];
const relErr = (got: number | null, want: number) => (got === null ? Infinity : Math.abs(got - want) / want);

function clap(rt60: number, snrDb: number, seed: number, noise: 'white' | 'pink' = 'pink', sampleRate = 48000) {
  return synthClap({ rt60, snrDb, seed, noise, sampleRate, duration: Math.max(2, rt60 * 1.6 + 1) });
}

describe('echo time from a synthetic clap with known RT60', () => {
  for (const rt of RTS) {
    it(`RT60 ${rt} s, clap 55 dB above room noise: within 10 %`, () => {
      for (let seed = 1; seed <= 3; seed++) {
        const a = analyzeClap(clap(rt, 55, seed), 48000);
        expect(a.ok).toBe(true);
        expect(relErr(a.rt60, rt)).toBeLessThan(0.1);
        expect(a.speech.method).not.toBeNull();
      }
    });
    it(`RT60 ${rt} s, clap 45 dB above room noise: within 18 %`, () => {
      for (let seed = 11; seed <= 13; seed++) {
        const a = analyzeClap(clap(rt, 45, seed), 48000);
        expect(a.ok).toBe(true);
        expect(relErr(a.rt60, rt)).toBeLessThan(0.18);
      }
    });
    it(`RT60 ${rt} s, clap only 35 dB above room noise: within 22 %`, () => {
      for (let seed = 21; seed <= 23; seed++) {
        const a = analyzeClap(clap(rt, 35, seed), 48000);
        expect(a.ok).toBe(true);
        expect(relErr(a.rt60, rt)).toBeLessThan(0.22);
      }
    });
  }

  it('works at 44.1 kHz too (many phones and laptops)', () => {
    const a = analyzeClap(clap(0.6, 50, 5, 'white', 44100), 44100);
    expect(relErr(a.rt60, 0.6)).toBeLessThan(0.06);
  });

  it('measures each octave band separately when the room is boomy', () => {
    const want: Record<number, number> = { 500: 1.1, 1000: 0.8, 2000: 0.6, 4000: 0.45 };
    const x = synthClap({ rt60: want, snrDb: 55, seed: 9, noise: 'pink', duration: 3 });
    const a = analyzeClap(x, 48000);
    for (const b of a.bands) expect(relErr(b.rt60, want[b.fc])).toBeLessThan(0.2);
    // Headline = mean of 500 Hz, 1 kHz, 2 kHz.
    expect(relErr(a.rt60, (1.1 + 0.8 + 0.6) / 3)).toBeLessThan(0.08);
  });
});

describe('refuses to guess', () => {
  it('silence gives no number', () => {
    const a = analyzeClap(new Float32Array(48000 * 2), 48000);
    expect(a.ok).toBe(false);
    expect(a.rt60).toBeNull();
  });

  it('a clap drowned in noise gives no number', () => {
    const a = analyzeClap(clap(0.6, 12, 3), 48000);
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/loud enough|decay/i);
  });

  it('steady noise with no clap gives no number', () => {
    const x = synthClap({ rt60: 0.5, snrDb: 0, seed: 4 });
    const a = analyzeClap(x, 48000);
    expect(a.ok).toBe(false);
  });

  it('warns when the clap overloads the microphone but still measures', () => {
    const x = clap(0.7, 55, 6);
    for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * 6));
    const a = analyzeClap(x, 48000);
    expect(a.clipped).toBe(true);
    expect(a.warnings.join(' ')).toMatch(/overloaded/);
    expect(relErr(a.rt60, 0.7)).toBeLessThan(0.08);
  });
});
