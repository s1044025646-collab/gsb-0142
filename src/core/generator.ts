/**
 * Synthetic impulse-response generator. Deterministic when a seeded RNG is
 * supplied. Supports pre-onset silence, exponential decay, an optional second
 * decay stage (dual-slope), additive tail noise and a bare single pulse.
 */

export interface GeneratorOptions {
  sampleRate: number;
  preSilenceS?: number;
  onsetAmplitude?: number;
  t1S?: number;
  t2S?: number;
  stage2StartS?: number;
  durationS?: number;
  noiseStd?: number;
  singlePulse?: boolean;
  rng?: () => number;
}

/** Mulberry32: tiny deterministic PRNG. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller gaussian from a uniform RNG. */
function gaussian(rng: () => number): number {
  let u = 0,
    v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function generateIR(opts: GeneratorOptions): {
  samples: Float64Array;
  onsetSample: number;
  sampleRate: number;
} {
  const {
    sampleRate,
    preSilenceS = 0,
    onsetAmplitude = 1,
    t1S = 0.5,
    t2S,
    stage2StartS,
    durationS = preSilenceS + Math.max(t1S, t2S ?? 0) * 2 + 0.2,
    noiseStd = 0,
    singlePulse = false,
    rng = Math.random,
  } = opts;

  const N = Math.max(1, Math.round(durationS * sampleRate));
  const onset = Math.round(preSilenceS * sampleRate);
  const out = new Float64Array(N);

  // Amplitude envelope: A(t) = A0 * 10^(-3 t / T60) => 60 dB drop per T60.
  const ampAt = (tS: number): number => {
    if (singlePulse) return 0;
    if (t2S !== undefined && stage2StartS !== undefined && tS >= stage2StartS) {
      const a1 = onsetAmplitude * Math.pow(10, (-3 * stage2StartS) / t1S);
      return a1 * Math.pow(10, (-3 * (tS - stage2StartS)) / t2S);
    }
    return onsetAmplitude * Math.pow(10, (-3 * tS) / t1S);
  };

  for (let i = 0; i < N; i++) {
    let v = 0;
    if (i === onset) v = onsetAmplitude;
    else if (i > onset) v = ampAt((i - onset) / sampleRate);
    if (noiseStd > 0) v += noiseStd * gaussian(rng);
    out[i] = v;
  }

  return { samples: out, onsetSample: Math.min(onset, N - 1), sampleRate };
}
