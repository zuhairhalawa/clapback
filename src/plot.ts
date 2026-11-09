// Decay graph as inline SVG: level (dB) against time after the clap.

export interface Curve {
  t: number[];
  edcDb: number[];
  envelopeDb: number[];
  rt60: number;
  kind: 'now' | 'before' | 'after';
  label: string;
}

const H = 300;
const L = 46;
const R = 14;
const T = 14;
const B = 44;
const YMIN = -70;

function niceStep(span: number): number {
  if (span <= 0.6) return 0.1;
  if (span <= 1.5) return 0.25;
  if (span <= 3) return 0.5;
  return 1;
}

function path(xs: number[], ys: number[], x: (v: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const v = ys[i];
    if (!Number.isFinite(v) || v < YMIN) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function decaySvg(curves: Curve[], summary: string, W = 640): string {
  const span = Math.min(3, Math.max(0.5, ...curves.map((c) => Math.max(c.t[c.t.length - 1] ?? 0, c.rt60 * 1.08))));
  const x = (s: number) => L + (s / span) * (W - L - R);
  const y = (d: number) => T + (Math.max(d, YMIN) / YMIN) * (H - T - B);

  let g = '';
  for (let d = 0; d >= -60; d -= 20) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(d)}" y2="${y(d)}"/>`;
    g += `<text class="tick" x="${L - 8}" y="${y(d) + 4}" text-anchor="end">${d}</text>`;
  }
  const step = niceStep(span);
  for (let s = 0; s <= span + 1e-9; s += step) {
    g += `<text class="tick" x="${x(s)}" y="${H - B + 18}" text-anchor="middle">${Number(s.toFixed(2))}</text>`;
  }
  g += `<text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">seconds after the clap</text>`;
  g += `<text class="axis" x="${L - 40}" y="${T - 2}" text-anchor="start">dB</text>`;

  let body = '';
  for (const c of curves) {
    body += `<g class="curve ${c.kind}">`;
    body += `<path class="env" d="${path(c.t, c.envelopeDb, x, y)}"/>`;
    body += `<path class="edc" pathLength="1" d="${path(c.t, c.edcDb, x, y)}"/>`;
    // An ideal decay with this echo time: 60 dB down at RT60.
    body += `<line class="fit" x1="${x(0)}" y1="${y(0)}" x2="${x(Math.min(c.rt60, span))}" y2="${y(Math.max(-60, (-60 * span) / c.rt60))}"/>`;
    if (c.rt60 <= span) {
      body += `<circle class="mark" cx="${x(c.rt60)}" cy="${y(-60)}" r="5"/>`;
      body += `<text class="mark-label" x="${x(c.rt60)}" y="${y(-60) - 12}" text-anchor="${c.rt60 > span * 0.8 ? 'end' : 'middle'}">${c.label} ${c.rt60.toFixed(2)} s</text>`;
    }
    body += '</g>';
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${summary.replace(/"/g, '&quot;')}" preserveAspectRatio="xMidYMid meet">
<g class="axes">${g}<line class="floor" x1="${L}" x2="${W - R}" y1="${y(-60)}" y2="${y(-60)}"/></g>${body}</svg>`;
}
