import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/600.css';
import './styles.css';

import { analyzeClap, type ClapAnalysis } from './dsp/analyze.ts';
import { ClapListener, decodeFile, PRE_SECONDS } from './audio/capture.ts';
import { decaySvg, type Curve } from './plot.ts';
import {
  advise,
  character,
  grade,
  GRADE_WORD,
  median,
  ROOM_SIZES,
  USES,
  type Grade,
} from './verdict.ts';

// ---------- state ----------

interface ClapRec {
  rt60: number;
  bands: { fc: number; rt60: number | null }[];
  snrDb: number;
  rough: boolean;
  source: 'mic' | 'sample' | 'file';
  plot: { t: number[]; edcDb: number[]; envelopeDb: number[] };
}

type SlotId = 'before' | 'after';

interface State {
  before: ClapRec[];
  after: ClapRec[];
  active: SlotId;
  use: string;
  room: string;
}

const MAX_CLAPS = 3;
const KEY = 'clapback.v1';

function load(): State {
  const blank: State = { before: [], after: [], active: 'before', use: 'calls', room: 'bedroom' };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank;
    return { ...blank, ...(JSON.parse(raw) as Partial<State>) };
  } catch {
    return blank;
  }
}

const state = load();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode: fine, nothing persists */
  }
}

interface Summary {
  rt60: number;
  lo: number;
  hi: number;
  n: number;
  bands: { fc: number; rt60: number | null }[];
  rep: ClapRec;
  rough: boolean;
  source: ClapRec['source'];
}

function summarise(claps: ClapRec[]): Summary | null {
  if (!claps.length) return null;
  const rts = claps.map((c) => c.rt60);
  const rt60 = median(rts);
  const rep = claps.reduce((a, b) => (Math.abs(b.rt60 - rt60) < Math.abs(a.rt60 - rt60) ? b : a));
  const bands = [500, 1000, 2000, 4000].map((fc) => {
    const vals = claps.map((c) => c.bands.find((b) => b.fc === fc)?.rt60).filter((v): v is number => v != null);
    return { fc, rt60: vals.length ? median(vals) : null };
  });
  return {
    rt60,
    lo: Math.min(...rts),
    hi: Math.max(...rts),
    n: claps.length,
    bands,
    rep,
    rough: claps.some((c) => c.rough),
    source: rep.source,
  };
}

// ---------- elements ----------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const listenBtn = $<HTMLButtonElement>('#listen');
const listenMain = $<HTMLSpanElement>('.listen-main');
const listenSub = $<HTMLSpanElement>('.listen-sub');
const statusEl = $<HTMLParagraphElement>('#status');
const clapsEl = $<HTMLOListElement>('#claps');
const dial = $<HTMLDivElement>('.dial');
const resultEl = $<HTMLElement>('#result');
const compareEl = $<HTMLElement>('#compare');
const fileInput = $<HTMLInputElement>('#file');
const slotBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.slot'));
const sampleBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sample]'));
const echoTitle = $<HTMLHeadingElement>('.echo');

const fmt = (s: number) => `${s.toFixed(2)} s`;
const fmtHz = (fc: number) => (fc >= 1000 ? `${fc / 1000} kHz` : `${fc} Hz`);
const slotName = (s: SlotId) => (s === 'before' ? 'Before' : 'After');

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ---------- the headline echo follows the room ----------

function replayEcho(rt60: number): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Each echo copy appears a little later and fades for longer when the room rings longer.
  echoTitle.style.setProperty('--echo-gap', `${Math.min(0.45, Math.max(0.08, rt60 / 4))}s`);
  echoTitle.style.setProperty('--echo-ink', `${Math.min(1, Math.max(0.25, rt60 / 1.2))}`);
  echoTitle.classList.remove('play');
  void echoTitle.offsetWidth;
  echoTitle.classList.add('play');
}

// ---------- measuring ----------

function toRec(a: ClapAnalysis, source: ClapRec['source']): ClapRec | null {
  if (!a.ok || a.rt60 === null || !a.plot) return null;
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : NaN);
  return {
    rt60: a.rt60,
    bands: a.bands.map((b) => ({ fc: b.fc, rt60: b.rt60 })),
    snrDb: a.snrDb,
    rough: a.warnings.length > 0 || (a.speech.r2 ?? 1) < 0.95,
    source,
    plot: {
      t: Array.from(a.plot.t, (v) => Math.round(v * 1000) / 1000),
      edcDb: Array.from(a.plot.edcDb, r),
      envelopeDb: Array.from(a.plot.envelopeDb, r),
    },
  };
}

let replaceOnNextClap = false;

function addClap(slot: SlotId, rec: ClapRec): void {
  if (replaceOnNextClap) {
    state[slot] = [];
    replaceOnNextClap = false;
  }
  const list = state[slot];
  list.push(rec);
  while (list.length > MAX_CLAPS) list.shift();
  save();
}

let lastRt: number | null = null;

/** Analyse one recording into the given slot. Returns a status line. */
function measure(samples: Float32Array, fs: number, slot: SlotId, source: ClapRec['source']): string {
  const a = analyzeClap(samples, fs);
  const rec = toRec(a, source);
  lastRt = rec ? rec.rt60 : null;
  if (!rec) return a.error ?? 'That did not sound like a clap. Try one sharp clap, then stay quiet.';
  addClap(slot, rec);
  const n = state[slot].length;
  const more = MAX_CLAPS - n;
  let line = `Clap ${n}: ${fmt(rec.rt60)}.`;
  if (a.warnings.length) line += ` ${a.warnings[0]}`;
  if (more > 0) line += ` Clap ${more === 1 ? 'once more' : `${more} more times`} for a steadier number.`;
  return line;
}

const listener = new ClapListener({
  onLevel(level) {
    dial.style.setProperty('--level', String(Math.min(1, level * 2.5)));
  },
  onClapStart(seconds) {
    dial.classList.add('capturing');
    dial.style.setProperty('--progress', '0');
    setStatus(`Heard it. Hold still for ${seconds} seconds while the echo fades…`);
  },
  onProgress(elapsed) {
    dial.style.setProperty('--progress', String(Math.min(1, elapsed / 3)));
  },
  onClap(samples, fs) {
    dial.classList.remove('capturing');
    const slot = state.active;
    const line = measure(samples, fs, slot, 'mic');
    setStatus(line);
    render(true);
    if (state[slot].length >= MAX_CLAPS) {
      stopListening();
      setStatus(`Clap ${MAX_CLAPS}: ${fmt(lastRt ?? 0)}. That’s ${MAX_CLAPS} claps for “${slotName(slot)}”, done.`);
    }
  },
});

function updateListenButton(): void {
  const on = listener.running;
  listenBtn.classList.toggle('on', on);
  dial.classList.toggle('on', on);
  const n = state[state.active].length;
  listenMain.textContent = on ? 'Listening' : n >= MAX_CLAPS ? 'Measure again' : n ? 'Clap again' : 'Start listening';
  listenSub.textContent = on ? 'clap now · press to stop' : 'uses your microphone';
}

async function startListening(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    setStatus('This browser can’t share its microphone with Clapback. Try the sample rooms below, or open Clapback in an up-to-date browser.');
    return;
  }
  // A full measurement is replaced only once a new clap is actually heard.
  replaceOnNextClap = state[state.active].length >= MAX_CLAPS;
  try {
    setStatus('Asking for the microphone…');
    await listener.start();
    setStatus(`Listening for the “${slotName(state.active)}” clap. Clap once, loudly, then stay quiet.`);
  } catch (err) {
    const name = (err as DOMException)?.name;
    setStatus(
      name === 'NotAllowedError'
        ? 'The microphone is blocked. Allow it from the address bar and press start again, or try the sample rooms below.'
        : name === 'NotFoundError'
          ? 'No microphone was found. Plug one in, or try the sample rooms below.'
          : 'The microphone could not start. Try again, or use the sample rooms below.',
    );
    listener.stop();
  }
  updateListenButton();
}

function stopListening(): void {
  listener.stop();
  dial.classList.remove('capturing');
  dial.style.setProperty('--level', '0');
  updateListenButton();
}

listenBtn.addEventListener('click', () => {
  if (listener.running) {
    stopListening();
    setStatus(state[state.active].length ? 'Stopped.' : 'Stopped. Press start when you’re ready to clap.');
  } else void startListening();
});

function setActive(slot: SlotId): void {
  state.active = slot;
  replaceOnNextClap = false;
  save();
  for (const b of slotBtns) b.setAttribute('aria-pressed', String(b.dataset.slot === slot));
  updateListenButton();
  renderClaps();
}

for (const b of slotBtns) {
  b.addEventListener('click', () => {
    if (listener.running) stopListening();
    setActive(b.dataset.slot as SlotId);
    setStatus(
      state.active === 'after'
        ? 'Change one thing in the room, then press start and clap from the same spot.'
        : 'Measuring the room as it is now. Press start, then clap.',
    );
  });
}

// ---------- samples and files ----------

let sampleAudio: HTMLAudioElement | null = null;

async function runSample(kind: 'bare' | 'treated'): Promise<void> {
  if (listener.running) stopListening();
  const slot: SlotId = kind === 'bare' ? 'before' : 'after';
  setActive(slot);
  replaceOnNextClap = true;
  sampleBtns.forEach((b) => (b.disabled = true));
  setStatus(kind === 'bare' ? 'Playing a clap in a bare bedroom (a simulated room)…' : 'Playing a clap in the same room, now with a duvet, rug and curtains (simulated)…');
  try {
    sampleAudio?.pause();
    sampleAudio = new Audio(`/samples/${kind}-1.wav`);
    void sampleAudio.play().catch(() => undefined);
    dial.classList.add('capturing');
    for (let k = 1; k <= MAX_CLAPS; k++) {
      const buf = await (await fetch(`/samples/${kind}-${k}.wav`)).arrayBuffer();
      const { samples, sampleRate } = await decodeFile(buf);
      dial.style.setProperty('--progress', String(k / MAX_CLAPS));
      await new Promise((r) => setTimeout(r, 650));
      const line = measure(samples, sampleRate, slot, 'sample');
      setStatus(k === MAX_CLAPS ? `Sample room measured from ${MAX_CLAPS} claps.` : line);
      render(k === MAX_CLAPS);
    }
  } catch {
    setStatus('The sample could not load. Check your connection and try again.');
  } finally {
    dial.classList.remove('capturing');
    sampleBtns.forEach((b) => (b.disabled = false));
    updateListenButton();
  }
}

for (const b of sampleBtns) b.addEventListener('click', () => void runSample(b.dataset.sample as 'bare' | 'treated'));

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    const { samples, sampleRate } = await decodeFile(await f.arrayBuffer());
    // Keep the loudest clap with a little quiet before it.
    let at = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > peak) { peak = Math.abs(samples[i]); at = i; }
    const from = Math.max(0, at - Math.round(PRE_SECONDS * sampleRate));
    const to = Math.min(samples.length, at + Math.round(3.2 * sampleRate));
    setStatus(measure(samples.slice(from, to), sampleRate, state.active, 'file'));
    render(true);
  } catch {
    setStatus('That file could not be read as audio. Try a WAV, MP3 or M4A recording.');
  }
  fileInput.value = '';
});

// ---------- rendering ----------

function renderClaps(): void {
  const list = state[state.active];
  clapsEl.innerHTML = '';
  for (let k = 0; k < MAX_CLAPS; k++) {
    const li = document.createElement('li');
    const c = list[k];
    li.className = c ? 'got' : '';
    li.textContent = c ? fmt(c.rt60) : '–';
    li.setAttribute('aria-label', c ? `Clap ${k + 1}: ${fmt(c.rt60)}` : `Clap ${k + 1}: not yet`);
    clapsEl.append(li);
  }
}

function gradeChip(g: Grade): string {
  return `<span class="grade ${g}">${GRADE_WORD[g]}</span>`;
}

function scaleBar(rt: number, good: number, okay: number, max = 1.6): string {
  const p = (v: number) => `${(Math.min(v, max) / max) * 100}%`;
  return `<div class="scale" aria-hidden="true">
    <span class="zone good" style="width:${p(good)}"></span><span class="zone okay" style="width:calc(${p(okay)} - ${p(good)})"></span><span class="zone poor"></span>
    <span class="pin" style="left:${p(rt)}"></span>
  </div>`;
}

function curveOf(s: Summary, kind: Curve['kind'], label: string): Curve {
  return { ...s.rep.plot, rt60: s.rt60, kind, label };
}

function renderResult(animate: boolean): void {
  const slot: SlotId = state.after.length && state.active === 'after' ? 'after' : state.before.length ? 'before' : 'after';
  const s = summarise(state[slot]);
  if (!s) {
    resultEl.hidden = true;
    return;
  }
  resultEl.hidden = false;
  const ch = character(s.rt60);
  const use = USES.find((u) => u.id === state.use) ?? USES[0];
  const room = ROOM_SIZES.find((r) => r.id === state.room) ?? ROOM_SIZES[1];
  const adv = advise(s.rt60, use, room, s.bands);
  const spread = s.n > 1 ? `${s.n} claps, from ${fmt(s.lo)} to ${fmt(s.hi)}` : '1 clap so far';
  const sourceNote = s.source === 'sample' ? ' Sample room (simulated).' : s.source === 'file' ? ' From a recording.' : '';
  const summaryText = `Decay curve: the sound falls 60 decibels in about ${fmt(s.rt60)}.`;

  const uses = USES.map((u) => {
    const g = grade(s.rt60, u);
    return `<li class="use">
      <div class="use-head"><span class="use-name">${u.name}</span>${gradeChip(g)}</div>
      ${scaleBar(s.rt60, u.good, u.okay)}
      <p>${u.says[g]} <span class="target">Good: up to ${u.good} s.</span></p>
    </li>`;
  }).join('');

  const bandMax = Math.max(1, ...s.bands.map((b) => b.rt60 ?? 0));
  const bands = s.bands
    .map((b) =>
      b.rt60 == null
        ? `<li><span class="bf">${fmtHz(b.fc)}</span><span class="bar none"></span><span class="bv">too quiet</span></li>`
        : `<li><span class="bf">${fmtHz(b.fc)}</span><span class="bar" style="--w:${(b.rt60 / bandMax) * 100}%"></span><span class="bv">${fmt(b.rt60)}</span></li>`,
    )
    .join('');

  const fixes = adv.needed > 0
    ? `<p class="need">To reach about <strong>${adv.target} s</strong> for ${use.name.toLowerCase()} in a ${room.name.toLowerCase()} (${room.dims}), add roughly <strong>${adv.needed.toFixed(1)} m²</strong> of soft, thick surface. For example:</p>
       <ol class="fix-list">${adv.fixes.map((f) => `<li>${f.text} <span class="area">≈ ${f.area} m²</span></li>`).join('')}</ol>`
    : `<p class="need">Already good for ${use.name.toLowerCase()}. Nothing to add.</p>`;

  resultEl.innerHTML = `
    <div class="result-head">
      <p class="kicker">${slotName(slot)}</p>
      <h2 id="result-title" class="room-word">${ch.word}</h2>
      <p class="rt"><span class="rt-num">${s.rt60.toFixed(2)}</span><span class="rt-unit"> s echo time</span></p>
      <p class="rt-line">${ch.line}</p>
      <p class="spread">${spread}.${s.rough ? ' Some claps were quiet or uneven, so treat this as rough.' : ''}${sourceNote}</p>
    </div>
    <ul class="uses">${uses}</ul>
    <figure class="graph${animate ? ' draw' : ''}">
      ${decaySvg([curveOf(s, 'now', '')], summaryText, innerWidth < 700 ? 420 : 940)}
      <figcaption>${summaryText} The thick line is the measured decay; the dashed line is a steady ${fmt(s.rt60)} decay for comparison.</figcaption>
    </figure>
    <div class="cols">
      <div class="bands-box">
        <h3>By pitch</h3>
        <ul class="bands">${bands}</ul>
        ${adv.bandNote ? `<p class="note">${adv.bandNote}</p>` : ''}
      </div>
      <div class="fix-box">
        <h3>What to change</h3>
        <div class="pickers">
          <label>Goal <select id="pick-use">${USES.map((u) => `<option value="${u.id}"${u.id === use.id ? ' selected' : ''}>${u.name}</option>`).join('')}</select></label>
          <label>Room <select id="pick-room">${ROOM_SIZES.map((r) => `<option value="${r.id}"${r.id === room.id ? ' selected' : ''}>${r.name}</option>`).join('')}</select></label>
        </div>
        ${fixes}
        <ul class="tips">${adv.tips.map((t) => `<li>${t}</li>`).join('')}</ul>
      </div>
    </div>
    ${slot === 'before' && !state.after.length ? `<div class="next">
      <p><strong>Now try one change.</strong> Throw a duvet over the desk, close the curtains or open the wardrobe, then clap again from the same spot.</p>
      <button type="button" class="primary" id="go-after">Measure the after</button>
    </div>` : ''}
    <p class="reset-row"><button type="button" class="link" id="reset">Start over</button></p>`;

  $<HTMLSelectElement>('#pick-use').addEventListener('change', (e) => {
    state.use = (e.target as HTMLSelectElement).value;
    save();
    render(false);
  });
  $<HTMLSelectElement>('#pick-room').addEventListener('change', (e) => {
    state.room = (e.target as HTMLSelectElement).value;
    save();
    render(false);
  });
  document.querySelector('#go-after')?.addEventListener('click', () => {
    setActive('after');
    document.querySelector('#meter')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    void startListening();
  });
  $<HTMLButtonElement>('#reset').addEventListener('click', () => {
    if (listener.running) stopListening();
    state.before = [];
    state.after = [];
    save();
    setActive('before');
    setStatus('Cleared. Stand where you record, press start, then clap.');
    render(false);
  });
}

function renderCompare(animate: boolean): void {
  const b = summarise(state.before);
  const a = summarise(state.after);
  if (!b || !a) {
    compareEl.hidden = true;
    return;
  }
  compareEl.hidden = false;
  const change = (a.rt60 - b.rt60) / b.rt60;
  const pct = Math.round(Math.abs(change) * 100);
  const headline = change < -0.05 ? `${pct} % less echo` : change > 0.05 ? `${pct} % more echo` : 'About the same';
  const rows = USES.map((u) => {
    const gb = grade(b.rt60, u);
    const ga = grade(a.rt60, u);
    return `<tr><th scope="row">${u.name}</th><td>${gradeChip(gb)}</td><td>${gradeChip(ga)}</td></tr>`;
  }).join('');
  const sampled = a.source === 'sample' || b.source === 'sample' ? '<p class="spread">Sample rooms (simulated).</p>' : '';
  compareEl.innerHTML = `
    <div class="cmp-head">
      <h2 id="compare-title" class="cmp-title">${headline}</h2>
      <p class="cmp-nums"><span class="was">${b.rt60.toFixed(2)} s</span><span class="arrow" aria-hidden="true"></span><span class="now">${a.rt60.toFixed(2)} s</span></p>
      <p class="cmp-line"><span class="sr">Echo time went from ${fmt(b.rt60)} before to ${fmt(a.rt60)} after.</span>${character(b.rt60).word} before, ${character(a.rt60).word.toLowerCase()} after.</p>
      ${sampled}
    </div>
    <figure class="graph${animate ? ' draw' : ''}">
      ${decaySvg([curveOf(b, 'before', 'Before'), curveOf(a, 'after', 'After')], `Before and after decay curves: ${fmt(b.rt60)} before, ${fmt(a.rt60)} after.`, innerWidth < 700 ? 420 : 640)}
      <figcaption><span class="key before"></span> Before <span class="key after"></span> After. A steeper curve means the room goes quiet sooner.</figcaption>
    </figure>
    <table class="cmp-table">
      <thead><tr><th scope="col">Good for</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function render(animate: boolean): void {
  const compareWasHidden = compareEl.hidden;
  renderClaps();
  renderResult(animate);
  renderCompare(animate);
  updateListenButton();
  const s = summarise(state[state.active]);
  if (animate && s) replayEcho(s.rt60);
  if (animate && !compareEl.hidden && (compareWasHidden || state.active === 'after')) {
    compareEl.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
}

setActive(state.active);
render(false);
if (state.before.length || state.after.length) setStatus('Welcome back. Your last measurements are below.');
