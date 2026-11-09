// Sample claps for the "no microphone" demo and the browser tests.
// Two simulated rooms: a bare bedroom, and the same room after a duvet, a rug and
// curtains. Three claps each (different random rooms with the same echo time).
import { mkdirSync, writeFileSync } from 'node:fs';
import { synthClap } from '../src/dsp/synth.ts';
import { encodeWav } from '../src/audio/wav.ts';

const FS = 48000;
const rooms = {
  bare: { 500: 0.95, 1000: 0.88, 2000: 0.82, 4000: 0.7 },
  treated: { 500: 0.5, 1000: 0.4, 2000: 0.34, 4000: 0.3 },
};
mkdirSync('public/samples', { recursive: true });
for (const [name, rt60] of Object.entries(rooms)) {
  for (let k = 1; k <= 3; k++) {
    const x = synthClap({ rt60, snrDb: 50, noise: 'pink', seed: 70 + k * 13 + name.length, preroll: 0.6, duration: 3.6 });
    writeFileSync(`public/samples/${name}-${k}.wav`, encodeWav(x, FS));
  }
}

// Fake-microphone loops for the browser tests: 3 claps, each with quiet before
// and a long tail, so the page hears them as separate claps.
mkdirSync('test/fixtures', { recursive: true });
for (const [name, rt60] of Object.entries(rooms)) {
  const parts: Float32Array[] = [];
  for (let k = 1; k <= 3; k++) parts.push(synthClap({ rt60, snrDb: 52, noise: 'pink', seed: 300 + k, preroll: 1.2, duration: 5.2 }));
  const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  writeFileSync(`test/fixtures/mic-${name}.wav`, encodeWav(all, FS));
}
console.log('ok');
