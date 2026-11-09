// Echo time (RT60) from one hand clap.
//
// Method (ISO 3382-2 style, simplified for a hand clap):
//  1. find the clap, and measure the background noise in the quiet moment before it;
//  2. split the signal into zero-phase octave bands (500 Hz, 1 kHz, 2 kHz, 4 kHz)
//     plus a speech band;
//  3. per band: smooth the energy envelope, fit its decay, and find where it meets
//     the noise floor (the "crosspoint", after Lundeby et al. 1995);
//  4. Schroeder backward integration of the noise-subtracted energy up to the
//     crosspoint, plus the energy of the fitted tail beyond it;
//  5. fit a line to the decay curve over -5..-35 dB (T30), -5..-25 dB (T20) or
//     -5..-15 dB (T10), whichever the clap's loudness above the noise allows,
//     and extrapolate it to 60 dB.
// The headline echo time is the mean of the 500 Hz, 1 kHz and 2 kHz bands, the
// speech range used by classroom standards such as ANSI/ASA S12.60.

import { highpass, octaveBands } from './filters.ts';

export type Method = 'T30' | 'T20' | 'T10';

export interface BandResult {
  /** Band centre in Hz, or 0 for the speech band (500 Hz - 2.8 kHz). */
  fc: number;
  rt60: number | null;
  method: Method | null;
  /** Coefficient of determination of the line fitted to the decay curve. */
  r2: number;
  /** Clap level above the background noise in this band, dB. */
  dynamicRangeDb: number;
  /** Why this band has no result, if it has none. */
  reason?: string;
  /** Decay-curve fit: level(t) = interceptDb + slopeDbPerS * t. */
  slopeDbPerS: number;
  interceptDb: number;
  fitFromDb: number;
  fitToDb: number;
}

export interface DecayPlot {
  /** Seconds after the clap, evenly spaced. */
  t: Float32Array;
  /** Smoothed energy envelope, dB relative to its peak. */
  envelopeDb: Float32Array;
  /** Schroeder decay curve, dB relative to its start (NaN past the crosspoint). */
  edcDb: Float32Array;
  noiseDb: number;
  crosspoint: number;
}

export interface ClapAnalysis {
  ok: boolean;
  /** Headline echo time in seconds (mean of 500 Hz, 1 kHz, 2 kHz). */
  rt60: number | null;
  bands: BandResult[];
  speech: BandResult;
  plot: DecayPlot | null;
  peakDbfs: number;
  /** Broadband clap level above background noise, dB. */
  snrDb: number;
  clipped: boolean;
  sampleRate: number;
  warnings: string[];
  /** A short reason when ok is false. */
  error?: string;
}

export const BAND_CENTRES = [500, 1000, 2000, 4000] as const;
const HEADLINE_BANDS = [500, 1000, 2000];

const BLOCK_S = 0.005; // envelope smoothing block
const PLOT_POINTS = 360;

function db(x: number): number {
  return 10 * Math.log10(Math.max(x, 1e-30));
}

interface LineFit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

function fitLine(xs: ArrayLike<number>, ys: ArrayLike<number>): LineFit {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, r2, n };
}

/** Mean energy in blocks of `len` samples starting at `start`. */
function blockEnergy(e: Float32Array, start: number, len: number): Float32Array {
  const count = Math.floor((e.length - start) / len);
  const out = new Float32Array(Math.max(count, 0));
  for (let b = 0; b < count; b++) {
    let s = 0;
    const o = start + b * len;
    for (let i = 0; i < len; i++) s += e[o + i];
    out[b] = s / len;
  }
  return out;
}

function meanRange(e: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.max(0, from);
  const b = Math.min(e.length, to);
  for (let i = a; i < b; i++) s += e[i];
  return b > a ? s / (b - a) : 0;
}

/** Find the clap: the first sample within 30% of the loudest one. */
export function findOnset(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const th = 0.3 * peak;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= th) return i;
  return 0;
}

interface BandDecay {
  result: BandResult;
  plot: DecayPlot | null;
}

function analyzeBand(
  x: Float32Array,
  fs: number,
  onset: number,
  fc: number,
  wantPlot: boolean,
): BandDecay {
  const fail = (reason: string, dr = 0): BandDecay => ({
    result: {
      fc,
      rt60: null,
      method: null,
      r2: 0,
      dynamicRangeDb: dr,
      reason,
      slopeDbPerS: 0,
      interceptDb: 0,
      fitFromDb: 0,
      fitToDb: 0,
    },
    plot: null,
  });

  const e = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) e[i] = x[i] * x[i];

  // Background noise: the quiet stretch before the clap, else the last 15 %.
  const guard = Math.round(0.02 * fs);
  let noise: number;
  if (onset - guard > 0.05 * fs) noise = meanRange(e, 0, onset - guard);
  else noise = meanRange(e, Math.floor(e.length * 0.85), e.length);
  const noiseDb = db(noise);

  // Start at this band's energy peak just after the onset.
  const searchEnd = Math.min(e.length, onset + Math.round(0.03 * fs));
  let start = Math.max(0, onset - Math.round(0.005 * fs));
  let best = 0;
  for (let i = start; i < searchEnd; i++) {
    if (e[i] > best) {
      best = e[i];
      start = i;
    }
  }
  // Back up to the start of the burst so the envelope peak is not cut.
  start = Math.max(0, start - Math.round(0.002 * fs));

  const blockLen = Math.max(1, Math.round(BLOCK_S * fs));
  const env = blockEnergy(e, start, blockLen);
  if (env.length < 10) return fail('Recording too short after the clap.');
  let peakBlock = 0;
  for (let b = 1; b < Math.min(env.length, 10); b++) if (env[b] > env[peakBlock]) peakBlock = b;
  const peakDb = db(env[peakBlock]);
  const dr = peakDb - noiseDb;
  if (dr < 20) return fail('Clap not loud enough above the background noise.', dr);

  const envDb = new Float32Array(env.length);
  for (let b = 0; b < env.length; b++) envDb[b] = db(env[b]) - peakDb;
  const noiseRel = noiseDb - peakDb;

  // Coarse decay fit on the envelope, from -5 dB to 10 dB above the noise.
  const tb = (b: number) => (b + 0.5) * BLOCK_S;
  let b0 = peakBlock;
  while (b0 < env.length && envDb[b0] > -5) b0++;
  let b1 = b0;
  while (b1 < env.length && envDb[b1] > noiseRel + 10) b1++;
  if (b1 - b0 < 3) return fail('Decay too short to measure.', dr);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let b = b0; b < b1; b++) {
    xs.push(tb(b));
    ys.push(envDb[b]);
  }
  let coarse = fitLine(xs, ys);
  if (coarse.slope >= -1) return fail('No decay found after the clap.', dr);

  // Crosspoint: where the decay line meets the noise floor. Refine twice,
  // re-fitting over the last 20 dB above the noise (Lundeby's idea).
  let tc = (noiseRel - coarse.intercept) / coarse.slope;
  for (let iter = 0; iter < 2; iter++) {
    const lo = Math.max(b0, Math.floor(tc / BLOCK_S) - Math.ceil(-20 / coarse.slope / BLOCK_S));
    const hi = Math.min(env.length, Math.floor(tc / BLOCK_S));
    if (hi - lo < 4) break;
    const xs2: number[] = [];
    const ys2: number[] = [];
    for (let b = lo; b < hi; b++) {
      // Remove the noise contribution before fitting the late decay.
      const sig = env[b] - noise;
      if (sig <= 0) continue;
      xs2.push(tb(b));
      ys2.push(db(sig) - peakDb);
    }
    if (xs2.length < 4) break;
    const f = fitLine(xs2, ys2);
    if (f.slope >= -1) break;
    coarse = f;
    tc = (noiseRel - f.intercept) / f.slope;
  }
  const lastT = (e.length - start) / fs;
  tc = Math.min(Math.max(tc, 0.02), lastT);

  // Schroeder backward integration with noise subtraction and tail correction.
  const nc = Math.floor(tc * fs);
  const tailLevel = Math.pow(10, (coarse.intercept + coarse.slope * tc) / 10) * Math.pow(10, peakDb / 10);
  const tailSeconds = 10 / (-coarse.slope * Math.LN10);
  const tail = tailLevel * tailSeconds * fs;
  const edc = new Float64Array(nc);
  let acc = tail;
  for (let i = nc - 1; i >= 0; i--) {
    acc += e[start + i] - noise;
    edc[i] = acc;
  }
  const e0 = edc[0];
  if (!(e0 > 0)) return fail('No decay found after the clap.', dr);

  // Decay curve at 1 ms steps for the regression.
  const step = Math.max(1, Math.round(0.001 * fs));
  const tEdc: number[] = [];
  const dEdc: number[] = [];
  for (let i = 0; i < nc; i += step) {
    tEdc.push(i / fs);
    dEdc.push(edc[i] > 0 ? db(edc[i] / e0) : -200);
  }

  // Pick the widest range the clap's loudness allows (10 dB headroom over noise).
  const ranges: { m: Method; lo: number; need: number }[] = [
    { m: 'T30', lo: -35, need: 45 },
    { m: 'T20', lo: -25, need: 35 },
    { m: 'T10', lo: -15, need: 25 },
  ];
  let chosen: { m: Method; lo: number } | null = null;
  for (const r of ranges) {
    if (dr >= r.need && dEdc[dEdc.length - 1] <= r.lo) {
      chosen = r;
      break;
    }
  }
  if (!chosen) return fail('Clap not loud enough above the background noise.', dr);

  const fx: number[] = [];
  const fy: number[] = [];
  for (let i = 0; i < tEdc.length; i++) {
    if (dEdc[i] <= -5 && dEdc[i] >= chosen.lo) {
      fx.push(tEdc[i]);
      fy.push(dEdc[i]);
    }
    if (dEdc[i] < chosen.lo) break;
  }
  if (fx.length < 5) return fail('Decay too short to measure.', dr);
  const fit = fitLine(fx, fy);
  if (fit.slope >= 0) return fail('No decay found after the clap.', dr);
  const rt60 = -60 / fit.slope;

  const result: BandResult = {
    fc,
    rt60,
    method: chosen.m,
    r2: fit.r2,
    dynamicRangeDb: dr,
    slopeDbPerS: fit.slope,
    interceptDb: fit.intercept,
    fitFromDb: -5,
    fitToDb: chosen.lo,
  };
  if (fit.r2 < 0.95) result.reason = 'Uneven decay; treat this number as rough.';

  let plot: DecayPlot | null = null;
  if (wantPlot) {
    const span = Math.min(lastT, Math.max(0.4, Math.min(3, rt60 * 1.15, tc * 1.6)));
    const t = new Float32Array(PLOT_POINTS);
    const pe = new Float32Array(PLOT_POINTS);
    const pd = new Float32Array(PLOT_POINTS);
    for (let k = 0; k < PLOT_POINTS; k++) {
      const tk = (k / (PLOT_POINTS - 1)) * span;
      t[k] = tk;
      const bi = Math.min(env.length - 1, Math.floor(tk / BLOCK_S));
      pe[k] = envDb[bi];
      const si = Math.floor(tk * fs);
      pd[k] = si < nc && edc[si] > 0 ? db(edc[si] / e0) : NaN;
    }
    plot = { t, envelopeDb: pe, edcDb: pd, noiseDb: noiseRel, crosspoint: tc };
  }
  return { result, plot };
}

/** Analyse a recording that contains one clap (with a little quiet before it). */
export function analyzeClap(input: Float32Array, sampleRate: number): ClapAnalysis {
  const fs = sampleRate;
  const warnings: string[] = [];
  let peakAbs = 0;
  let clippedCount = 0;
  for (let i = 0; i < input.length; i++) {
    const a = Math.abs(input[i]);
    if (a > peakAbs) peakAbs = a;
    if (a >= 0.999) clippedCount++;
  }
  const clipped = clippedCount > 3;
  const base: ClapAnalysis = {
    ok: false,
    rt60: null,
    bands: [],
    speech: null as unknown as BandResult,
    plot: null,
    peakDbfs: 20 * Math.log10(Math.max(peakAbs, 1e-9)),
    snrDb: 0,
    clipped,
    sampleRate: fs,
    warnings,
  };
  if (input.length < fs * 0.5 || peakAbs < 1e-4) {
    return { ...base, error: 'No clap heard. Clap once, loudly, then stay quiet.' };
  }
  if (clipped) warnings.push('The clap overloaded the microphone. It still works, but clapping a little further away is better.');

  const x = highpass(input, 60, fs);
  const onset = findOnset(x);

  // Broadband level above noise, for the user-facing loudness hint.
  const guard = Math.round(0.02 * fs);
  const pre = onset - guard;
  let noise = 0;
  let n = 0;
  if (pre > 0.05 * fs) {
    for (let i = 0; i < pre; i++) noise += x[i] * x[i];
    n = pre;
  } else {
    for (let i = Math.floor(x.length * 0.85); i < x.length; i++) {
      noise += x[i] * x[i];
      n++;
    }
  }
  noise /= Math.max(n, 1);
  let peakE = 0;
  const bl = Math.round(BLOCK_S * fs);
  for (let s = Math.max(0, onset - bl); s < Math.min(x.length - bl, onset + 4 * bl); s += Math.max(1, bl >> 2)) {
    let acc = 0;
    for (let i = s; i < s + bl; i++) acc += x[i] * x[i];
    peakE = Math.max(peakE, acc / bl);
  }
  const snrDb = db(peakE) - db(noise);

  const filtered = octaveBands(x, BAND_CENTRES, fs);
  const bands = BAND_CENTRES.map((fc, i) => analyzeBand(filtered[i], fs, onset, fc, false).result);

  // Speech band: the sum of the 500 Hz, 1 kHz and 2 kHz octaves (about 350 Hz - 2.8 kHz).
  const speechSig = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) speechSig[i] = filtered[0][i] + filtered[1][i] + filtered[2][i];
  const speech = analyzeBand(speechSig, fs, onset, 0, true);

  const head = bands.filter((b) => HEADLINE_BANDS.includes(b.fc) && b.rt60 !== null);
  let rt60: number | null = null;
  if (head.length >= 2) rt60 = head.reduce((s, b) => s + (b.rt60 as number), 0) / head.length;
  else if (speech.result.rt60 !== null) rt60 = speech.result.rt60;

  if (rt60 === null) {
    return {
      ...base,
      bands,
      speech: speech.result,
      plot: speech.plot,
      snrDb,
      error: speech.result.reason ?? 'Could not measure the decay. Try a louder clap in a quieter moment.',
    };
  }
  if (snrDb < 35) warnings.push('The clap was only a little louder than the room noise, so this number is rough. A louder clap or a quieter moment helps.');

  return { ...base, ok: true, rt60, bands, speech: speech.result, plot: speech.plot, snrDb };
}
