// Microphone capture with clap detection.
//
// The browser's voice processing (echo cancellation, noise suppression, automatic
// gain) is switched off: all three reshape exactly the decay we want to measure.
// An AudioWorklet hands raw blocks to this thread; we keep the last second in a
// ring buffer, and when a block is much louder than the running noise level we
// keep that second plus the next few seconds as one clap recording.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('clapback-tap', Tap);
`;

export interface CaptureEvents {
  /** Input level 0..1 (peak, smoothed), about 60 times a second. */
  onLevel(level: number): void;
  /** A clap was heard; recording its decay for `seconds`. */
  onClapStart(seconds: number): void;
  /** Seconds of decay recorded so far, while capturing. */
  onProgress(elapsed: number): void;
  /** One clap recording, ready to analyse. */
  onClap(samples: Float32Array, sampleRate: number): void;
}

export const PRE_SECONDS = 0.6;
export const POST_SECONDS = 3.0;

export class ClapListener {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private ring = new Float32Array(0);
  private ringPos = 0;
  private noiseRms = 0.002;
  private capturing: Float32Array[] | null = null;
  private captured = 0;
  private postSamples = 0;
  private preCopy: Float32Array | null = null;
  private level = 0;
  private lastLevelAt = 0;
  private armedAt = 0;
  paused = false;

  constructor(private ev: CaptureEvents) {}

  get running(): boolean {
    return this.ctx !== null;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'clapback-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node = node;
    this.ring = new Float32Array(Math.round(PRE_SECONDS * ctx.sampleRate));
    this.postSamples = Math.round(POST_SECONDS * ctx.sampleRate);
    this.armedAt = performance.now();
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onBlock(e.data);
    src.connect(node);
    if (ctx.state === 'suspended') await ctx.resume();
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.capturing = null;
  }

  private onBlock(block: Float32Array): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let peak = 0;
    let ss = 0;
    for (let i = 0; i < block.length; i++) {
      const a = Math.abs(block[i]);
      if (a > peak) peak = a;
      ss += block[i] * block[i];
    }
    const rms = Math.sqrt(ss / block.length);

    this.level = Math.max(peak, this.level * 0.9);
    const now = performance.now();
    if (now - this.lastLevelAt > 16) {
      this.lastLevelAt = now;
      this.ev.onLevel(this.level);
    }

    if (this.capturing) {
      this.capturing.push(block);
      this.captured += block.length;
      this.ev.onProgress(this.captured / ctx.sampleRate);
      if (this.captured >= this.postSamples) this.finish(ctx.sampleRate);
      return;
    }

    // Slow-moving noise estimate; only quiet blocks update it.
    const quiet = rms < this.noiseRms * 4;
    if (quiet) this.noiseRms = this.noiseRms * 0.98 + rms * 0.02;

    const settled = now - this.armedAt > PRE_SECONDS * 1000 + 150;
    const isClap = settled && !this.paused && peak > Math.max(0.02, this.noiseRms * 25);
    if (isClap) {
      // Unroll the ring buffer: the quiet moment before the clap.
      const n = this.ring.length;
      const pre = new Float32Array(n);
      pre.set(this.ring.subarray(this.ringPos), 0);
      pre.set(this.ring.subarray(0, this.ringPos), n - this.ringPos);
      this.preCopy = pre;
      this.capturing = [block];
      this.captured = block.length;
      this.ev.onClapStart(POST_SECONDS);
      return;
    }

    // Keep the last PRE_SECONDS.
    for (let i = 0; i < block.length; i++) {
      this.ring[this.ringPos] = block[i];
      this.ringPos = (this.ringPos + 1) % this.ring.length;
    }
  }

  private finish(fs: number): void {
    const parts = this.capturing ?? [];
    const pre = this.preCopy ?? new Float32Array(0);
    const total = pre.length + parts.reduce((s, p) => s + p.length, 0);
    const out = new Float32Array(total);
    out.set(pre, 0);
    let o = pre.length;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    this.capturing = null;
    this.preCopy = null;
    this.ring.fill(0);
    this.ringPos = 0;
    // Let the room settle before listening for the next clap.
    this.armedAt = performance.now();
    this.ev.onClap(out, fs);
  }
}

/** Decode an audio file (or a sample) to mono samples. */
export async function decodeFile(data: ArrayBuffer): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(data);
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return { samples: out, sampleRate: buf.sampleRate };
}
