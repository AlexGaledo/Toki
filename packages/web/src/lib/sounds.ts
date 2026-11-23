/** AudioContext can be unavailable, blocked by autoplay policy, or throw mid-render; none of that reaches the caller. */
export type Cue = 'send' | 'receive' | 'approvalRequest' | 'approve' | 'deny' | 'done' | 'error' | 'connected';

const PEAK = 0.126;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let unlockAttached = false;

function ensureContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
    }
    return ctx;
  } catch {
    return null;
  }
}

function unlock() {
  try {
    const c = ensureContext();
    if (c && c.state === 'suspended') void c.resume().catch(() => {});
  } catch {
    /* ignore */
  }
}

function attachUnlockListeners() {
  if (unlockAttached || typeof window === 'undefined') return;
  unlockAttached = true;
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}
attachUnlockListeners();

export function setSoundsEnabled(v: boolean) {
  enabled = v;
}

function reducedMotion(): boolean {
  try {
    return !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function attenuation(cue: Cue, opts?: { roomActive?: boolean }): number {
  if (cue !== 'receive' && cue !== 'done') return 1;
  try {
    const hidden = document.visibilityState === 'hidden';
    const roomActive = opts?.roomActive ?? true;
    return hidden || !roomActive ? 1 : 0.5;
  } catch {
    return 1;
  }
}

function tone(c: AudioContext, dest: AudioNode, opts: { freq: number; freqEnd?: number; type?: OscillatorType; start: number; dur: number; peak: number }) {
  const osc = c.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(1, opts.freq), opts.start);
  if (opts.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqEnd), opts.start + opts.dur);
  const g = c.createGain();
  const attack = Math.min(0.014, opts.dur * 0.3);
  g.gain.setValueAtTime(0.0001, opts.start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0005, opts.peak), opts.start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.dur);
  osc.connect(g).connect(dest);
  osc.start(opts.start);
  osc.stop(opts.start + opts.dur + 0.03);
}

function noiseSweep(c: AudioContext, dest: AudioNode, opts: { start: number; dur: number; freqFrom: number; freqTo: number; peak: number; type?: BiquadFilterType; peakAt?: number }) {
  const len = Math.max(1, Math.floor(c.sampleRate * opts.dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = opts.type ?? 'bandpass';
  filt.Q.value = 0.9;
  filt.frequency.setValueAtTime(Math.max(1, opts.freqFrom), opts.start);
  filt.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), opts.start + opts.dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, opts.start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0005, opts.peak), opts.start + opts.dur * (opts.peakAt ?? 0.4));
  g.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.dur);
  src.connect(filt).connect(g).connect(dest);
  src.start(opts.start);
  src.stop(opts.start + opts.dur + 0.03);
}

function render(cue: Cue, c: AudioContext, dest: AudioNode) {
  const t0 = c.currentTime + 0.006;
  switch (cue) {
    case 'send':
      tone(c, dest, { freq: 880, freqEnd: 1320, type: 'sine', start: t0, dur: 0.06, peak: PEAK * 0.8 });
      break;

    case 'receive':
      tone(c, dest, { freq: 659.25, type: 'triangle', start: t0, dur: 0.09, peak: PEAK });
      tone(c, dest, { freq: 880, type: 'triangle', start: t0 + 0.09, dur: 0.11, peak: PEAK * 0.9 });
      break;

    case 'approvalRequest':
      for (const at of [0, 0.12]) {
        tone(c, dest, { freq: 1000, type: 'sine', start: t0 + at, dur: 0.07, peak: PEAK * 1.15 });
        noiseSweep(c, dest, { start: t0 + at, dur: 0.07, freqFrom: 1400, freqTo: 1400, peak: PEAK * 0.12, peakAt: 0.3 });
      }
      break;

    case 'approve':
      tone(c, dest, { freq: 600, freqEnd: 900, type: 'sine', start: t0, dur: 0.09, peak: PEAK });
      break;

    case 'deny':
      tone(c, dest, { freq: 700, freqEnd: 450, type: 'sine', start: t0, dur: 0.09, peak: PEAK });
      break;

    case 'done': {
      tone(c, dest, { freq: 523.25, type: 'triangle', start: t0, dur: 0.1, peak: PEAK * 0.8 });
      tone(c, dest, { freq: 659.25, type: 'triangle', start: t0 + 0.08, dur: 0.1, peak: PEAK * 0.85 });
      tone(c, dest, { freq: 783.99, type: 'triangle', start: t0 + 0.16, dur: 0.14, peak: PEAK });
      break;
    }

    case 'error': {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(110, t0);
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(420, t0);
      filt.frequency.exponentialRampToValueAtTime(280, t0 + 0.2);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(PEAK * 0.95, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(filt).connect(g).connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.22);
      break;
    }

    case 'connected':
      noiseSweep(c, dest, { start: t0, dur: 0.45, freqFrom: 200, freqTo: 2000, peak: PEAK * 0.55, type: 'bandpass', peakAt: 0.55 });
      tone(c, dest, { freq: 440, freqEnd: 660, type: 'sine', start: t0 + 0.04, dur: 0.4, peak: PEAK * 0.65 });
      break;
  }
}

function playInternal(cue: Cue, volumeScale: number) {
  const c = ensureContext();
  if (!c || !master) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});
  const g = c.createGain();
  g.gain.value = volumeScale;
  g.connect(master);
  render(cue, c, g);
}

export function play(cue: Cue, opts?: { roomActive?: boolean }) {
  try {
    if (!enabled || reducedMotion()) return;
    playInternal(cue, attenuation(cue, opts));
  } catch {
    /* AudioContext unavailable / blocked — silently degrade */
  }
}

export function preview(cue: Cue) {
  try {
    playInternal(cue, 1);
  } catch {
    /* ignore */
  }
}
