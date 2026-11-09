// Synthetic rooms with a known echo time, for tests, samples and demos.
//
// A room's impulse response is modelled as Gaussian noise under an exponential
// envelope that falls 60 dB in RT60 seconds (the statistical model of a diffuse
// field). A hand clap is a ~2 ms burst; the recording is that burst convolved with
// the room, plus background noise at a chosen level below the clap.

import { applyGain, spectrum } from './fft.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface RoomSpec {
  /** Echo time in seconds, either one value or one per octave band centre. */
  rt60: number | Record<number, number>;
  sampleRate?: number;
  /** Clap level above the background noise (10 ms peak energy vs noise energy), dB. */
  snrDb?: number;
  /** Quiet time before the clap, seconds. */
  preroll?: number;
  /** Total length, seconds. */
  duration?: number;
  /** 'white' or 'pink' (room-like, more low-frequency) background noise. */
  noise?: 'white' | 'pink';
  seed?: number;
}

export function impulseResponse(spec: RoomSpec, rand: () => number): Float32Array {
  const fs = spec.sampleRate ?? 48000;
  const g = gaussian(rand);
  const maxRt = typeof spec.rt60 === 'number' ? spec.rt60 : Math.max(...Object.values(spec.rt60));
  const n = Math.round(fs * Math.min(maxRt * 1.6 + 0.1, 6));
  const ir = new Float32Array(n);
  const decayAt = (rt: number, i: number) => Math.pow(10, (-3 * (i / fs)) / rt); // amplitude: -60 dB at rt
  if (typeof spec.rt60 === 'number') {
    for (let i = 0; i < n; i++) ir[i] = g() * decayAt(spec.rt60, i);
  } else {
    // Split the spectrum between the bands (power-complementary crossover
    // halfway between neighbouring centres, on a log-frequency axis).
    const centres = Object.keys(spec.rt60).map(Number).sort((a, b) => a - b);
    const u = centres.map((c) => Math.log2(c));
    const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
    const weight = (k: number) => (f: number) => {
      if (f <= 0) return 0;
      const lf = Math.log2(f);
      let w = 1;
      if (k > 0) w *= smooth((lf - (u[k - 1] + u[k]) / 2 + 0.15) / 0.3);
      if (k < centres.length - 1) w *= 1 - smooth((lf - (u[k] + u[k + 1]) / 2 + 0.15) / 0.3);
      return Math.sqrt(w);
    };
    centres.forEach((fc, k) => {
      const rt = (spec.rt60 as Record<number, number>)[fc];
      const noise = new Float32Array(n);
      for (let i = 0; i < n; i++) noise[i] = g();
      const band = applyGain(spectrum(noise), fs, n, weight(k));
      for (let i = 0; i < n; i++) ir[i] += band[i] * decayAt(rt, i);
    });
  }
  // Direct sound stands out a little above the diffuse tail.
  ir[0] += 4;
  return ir;
}

function clapBurst(fs: number, rand: () => number): Float32Array {
  const g = gaussian(rand);
  const len = Math.round(0.002 * fs);
  const b = new Float32Array(len);
  for (let i = 0; i < len; i++) b[i] = g() * Math.sin((Math.PI * i) / len);
  return b;
}

function pinkNoise(n: number, rand: () => number): Float32Array {
  // Paul Kellet's filter on white noise.
  const g = gaussian(rand);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = g();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

/** A recording of one clap in a synthetic room. */
export function synthClap(spec: RoomSpec): Float32Array {
  const fs = spec.sampleRate ?? 48000;
  const rand = mulberry32(spec.seed ?? 1);
  const preroll = spec.preroll ?? 0.4;
  const duration = spec.duration ?? 3.5;
  const n = Math.round(fs * duration);
  const out = new Float32Array(n);
  const ir = impulseResponse(spec, rand);
  const burst = clapBurst(fs, rand);
  const at = Math.round(preroll * fs);
  for (let k = 0; k < burst.length; k++) {
    const bk = burst[k];
    const o = at + k;
    const m = Math.min(ir.length, n - o);
    for (let i = 0; i < m; i++) out[o + i] += bk * ir[i];
  }
  // Normalise the clap peak to -6 dBFS.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= 0.5 / peak;

  // Background noise relative to the clap's loudest 10 ms.
  const bl = Math.round(0.01 * fs);
  let peakE = 0;
  for (let s = at - bl; s < at + 4 * bl; s += bl >> 2) {
    let acc = 0;
    for (let i = s; i < s + bl; i++) acc += out[i] * out[i];
    peakE = Math.max(peakE, acc / bl);
  }
  const snr = spec.snrDb ?? 55;
  const noiseRms = Math.sqrt(peakE) * Math.pow(10, -snr / 20);
  const raw = spec.noise === 'pink' ? pinkNoise(n, rand) : (() => {
    const g = gaussian(rand);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = g();
    return w;
  })();
  let ms = 0;
  for (let i = 0; i < n; i++) ms += raw[i] * raw[i];
  const scale = noiseRms / Math.sqrt(ms / n);
  for (let i = 0; i < n; i++) out[i] += raw[i] * scale;
  return out;
}
