// Synthetic impulse-response generator for demos and tests.
// Randomness is injectable (seed) so output is reproducible.

export type SynthType =
  | "decay"        // single exponential decay (analytic T60)
  | "two-stage"    // fast early decay + slow late decay
  | "impulse"      // single pulse at the onset
  | "noisy-decay"  // exponential decay over a constant noise floor
  | "zeros";       // all-zero recording

export interface SynthOptions {
  type: SynthType;
  sampleRate?: number;
  durationSec?: number;
  t60?: number;        // primary decay (seconds), default 1.2
  t60Late?: number;    // two-stage late decay, default 3 * t60
  leadingSilenceSec?: number;
  noiseSnrDb?: number; // noisy-decay: peak-to-noise ratio, default 40
  amplitude?: number;
  seed?: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Decay constant so that level drops 60 dB in t60 seconds:
// x(t) = exp(-alpha * t) with alpha = 3*ln(10)/t60.
export function alphaForT60(t60: number): number {
  return (3 * Math.LN10) / t60;
}

export function synthesize(opts: SynthOptions): { sampleRate: number; samples: number[] } {
  const fs = opts.sampleRate ?? 16000;
  const durationSec = opts.durationSec ?? 2.0;
  const t60 = opts.t60 ?? 1.2;
  const amp = opts.amplitude ?? 1;
  const lead = Math.round((opts.leadingSilenceSec ?? 0) * fs);
  const n = Math.round(durationSec * fs);
  const rand = mulberry32(opts.seed ?? 42);
  const samples = new Array<number>(n).fill(0);

  switch (opts.type) {
    case "zeros":
      break;
    case "impulse": {
      if (lead < n) samples[lead] = amp;
      break;
    }
    case "decay": {
      const alpha = alphaForT60(t60);
      for (let i = lead; i < n; i++) {
        const t = (i - lead) / fs;
        samples[i] = amp * Math.exp(-alpha * t) * (2 * rand() - 1);
      }
      break;
    }
    case "two-stage": {
      const a1 = alphaForT60(t60);
      const a2 = alphaForT60(opts.t60Late ?? 3 * t60);
      const knee = lead + Math.round(0.25 * (n - lead));
      let carry = 1;
      for (let i = lead; i < n; i++) {
        const t = (i - lead) / fs;
        let env: number;
        if (i < knee) {
          env = Math.exp(-a1 * t);
          carry = env;
        } else {
          const tk = (knee - lead) / fs;
          env = carry * Math.exp(-a2 * (t - tk));
        }
        samples[i] = amp * env * (2 * rand() - 1);
      }
      break;
    }
    case "noisy-decay": {
      const alpha = alphaForT60(t60);
      const snrDb = opts.noiseSnrDb ?? 40;
      // noise RMS relative to peak amplitude 1: 10^(-snr/20)
      const noiseAmp = Math.pow(10, -snrDb / 20);
      for (let i = 0; i < n; i++) {
        const t = i >= lead ? (i - lead) / fs : 0;
        const env = i >= lead ? Math.exp(-alpha * t) : 0;
        samples[i] = amp * (env + noiseAmp) * (2 * rand() - 1);
      }
      break;
    }
  }
  return { sampleRate: fs, samples };
}
