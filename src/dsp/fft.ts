// Minimal in-place radix-2 FFT, enough for zero-phase band filtering of a few
// seconds of audio.

export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Spectrum of a real signal, zero-padded to a power of two. */
export function spectrum(x: Float32Array, pad = 0): { re: Float64Array; im: Float64Array } {
  const n = nextPow2(x.length + pad);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im);
  return { re, im };
}

/**
 * Apply a real, zero-phase gain(f) to a spectrum and return the first `len`
 * samples of the result.
 */
export function applyGain(
  spec: { re: Float64Array; im: Float64Array },
  fs: number,
  len: number,
  gain: (f: number) => number,
): Float32Array {
  const n = spec.re.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k <= n / 2; k++) {
    const g = gain((k * fs) / n);
    re[k] = spec.re[k] * g;
    im[k] = spec.im[k] * g;
    if (k > 0 && k < n / 2) {
      re[n - k] = spec.re[n - k] * g;
      im[n - k] = spec.im[n - k] * g;
    }
  }
  fft(re, im, true);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = re[i];
  return out;
}
