// Filters for decay analysis: zero-phase octave bands and a DC/rumble high-pass.

import { applyGain, spectrum } from './fft.ts';

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ cookbook band-pass (constant 0 dB peak gain). */
export function bandpass(fc: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function runBiquad(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/**
 * Octave-band magnitude: a Butterworth-shaped band-pass of order 4 per side
 * (|H|^2 = 1 / (1 + W^8)), -3 dB at fc / sqrt2 and fc * sqrt2, about -26 dB at
 * the neighbouring band centres. Applied with zero phase, so the filter adds no
 * delay or ringing tail of its own to the room's decay.
 */
export function octaveGain(fc: number): (f: number) => number {
  const bw = Math.SQRT2 - Math.SQRT1_2; // (f2 - f1) / fc for one octave
  return (f: number) => {
    if (f <= 0) return 0;
    const w = (f / fc - fc / f) / bw;
    return 1 / Math.sqrt(1 + Math.pow(w, 8));
  };
}

/** Several octave bands of x at once (one forward FFT). */
export function octaveBands(x: Float32Array, centres: readonly number[], fs: number): Float32Array[] {
  const spec = spectrum(x, Math.round(0.25 * fs));
  return centres.map((fc) => applyGain(spec, fs, x.length, octaveGain(fc)));
}

/** One octave band of x. */
export function octaveBand(x: Float32Array, fc: number, fs: number): Float32Array {
  return octaveBands(x, [fc], fs)[0];
}

/** Gentle high-pass (2nd order) to remove DC and rumble below ~60 Hz. */
export function highpass(x: Float32Array, fc: number, fs: number): Float32Array {
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const f: Biquad = {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
  return runBiquad(x, f);
}
