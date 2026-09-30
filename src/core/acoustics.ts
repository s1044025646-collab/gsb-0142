import type { AnalysisParams } from "./params.js";

/** One sample marker / window description (all indices are 0-based, absolute). */
export interface WindowSpec {
  /** Direct-sound onset sample index (time zero for energy splits). */
  onset: number;
  /** Noise window start sample (before onset), inclusive. */
  noiseStart: number;
  /** Noise window end sample (before onset), exclusive. */
  noiseEnd: number;
  /** Integration endpoint sample, exclusive. */
  integrationEnd: number;
}

export interface FitEstimate {
  /** Estimated 60 dB-equivalent decay time in seconds, or null if not estimable. */
  value: number | null;
  /** Human-readable reason when value is null. */
  reason: string | null;
  /** Fit window start/end times (s, relative to onset) actually used. */
  fitStartS: number | null;
  fitEndS: number | null;
  /** Slope in dB/s. */
  slopeDbPerS: number | null;
  /** Intercept in dB at t=0 (onset). */
  interceptDb: number | null;
  /** RMSE of dB curve around the fitted line over the window. */
  rmseDb: number | null;
  /** R^2 of the fit. */
  r2: number | null;
}

export interface AnalysisReport {
  paramVersion: string;
  sampleRate: number;
  onsetSample: number;
  noiseStart: number;
  noiseEnd: number;
  integrationEnd: number;
  usableSamples: number;
  durationS: number;
  /** Estimated noise power per sample (mean square of noise window). */
  noisePower: number;
  /** Peak instantaneous squared energy (post correction) at onset segment. */
  peakPower: number;
  /** Total dynamic range available (dB) for decay fitting. */
  dynamicRangeDb: number;
  /** 10*log10(noise/peak); a high (close to 0) value means too noisy. */
  noiseToPeakDb: number;
  schroeder: { tS: number[]; db: number[] };
  EDT: FitEstimate;
  T20: FitEstimate;
  T30: FitEstimate;
  C50: number | null;
  C80: number | null;
  D50: number | null;
  /** Aggregate quality flags. */
  flags: string[];
}

export const DB_FLOOR = -200;

function mean(xs: ArrayLike<number>, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += xs[i];
  return b > a ? s / (b - a) : 0;
}

/**
 * Ordinary least squares fit y = m*x + b over an index range.
 * Returns null when the fit is degenerate (no x variance / non-finite).
 */
export function linearFit(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  a: number,
  b: number,
): { m: number; b: number; rmse: number; r2: number } | null {
  const n = b - a;
  if (n < 2) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = a; i < b; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const mx = sx / n,
    my = sy / n;
  const cov = sxy - n * mx * my;
  const varX = sxx - n * mx * mx;
  if (!(varX > 0) || !Number.isFinite(cov)) return null;
  const m = cov / varX;
  const bb = my - m * mx;
  let ssRes = 0,
    ssTot = 0;
  for (let i = a; i < b; i++) {
    const r = y[i] - (m * x[i] + bb);
    ssRes += r * r;
    const d = y[i] - my;
    ssTot += d * d;
  }
  const rmse = Math.sqrt(ssRes / n);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  if (![m, bb, rmse, r2].every(Number.isFinite)) return null;
  return { m, b: bb, rmse, r2 };
}

function nonMonotonicFraction(db: ArrayLike<number>, a: number, b: number): number {
  let ups = 0,
    steps = 0;
  for (let i = a + 1; i < b; i++) {
    steps++;
    if (db[i] > db[i - 1] + 1e-9) ups++;
  }
  return steps > 0 ? ups / steps : 0;
}

/**
 * Estimate a decay time from the Schroeder curve over [hiDb, loDb].
 * The fitted slope (dB/s) is extrapolated to a 60 dB drop, so a T20/T30
 * window never equates the recording length to the reverberation time.
 */
function estimate(
  tS: number[],
  db: number[],
  hiDb: number,
  loDb: number,
  dynamicRangeDb: number,
  p: AnalysisParams,
): FitEstimate {
  const none = (reason: string): FitEstimate => ({
    value: null,
    reason,
    fitStartS: null,
    fitEndS: null,
    slopeDbPerS: null,
    interceptDb: null,
    rmseDb: null,
    r2: null,
  });

  const span = hiDb - loDb; // e.g. 20 for T20
  if (dynamicRangeDb + 1e-9 < span) {
    return none(`DYNAMIC_RANGE: need ${span} dB, have ${dynamicRangeDb.toFixed(1)} dB`);
  }

  // Schroeder db is non-increasing. Find the contiguous region between levels.
  let i0 = -1,
    i1 = -1;
  for (let i = 0; i < db.length; i++) {
    if (i0 === -1 && db[i] <= hiDb) i0 = i;
    if (db[i] >= loDb) i1 = i;
  }
  if (i0 === -1 || i1 === -1 || i1 < i0) return none("WINDOW_NOT_REACHED");

  const n = i1 - i0 + 1;
  if (n < p.minFitSamples) return none(`TOO_FEW_SAMPLES: ${n} < ${p.minFitSamples}`);

  const nm = nonMonotonicFraction(db, i0, i1 + 1);
  if (nm > p.maxNonMonotonicFraction) {
    return none(`NON_MONOTONIC: ${(nm * 100).toFixed(1)}% upward steps`);
  }

  const fit = linearFit(tS, db, i0, i1 + 1);
  if (!fit) return none("FIT_FAILED");
  if (fit.m >= 0) return none("NON_DECAYING_SLOPE");
  if (fit.rmse > p.maxFitRmseDb) {
    return none(`FIT_UNRELIABLE: rmse ${fit.rmse.toFixed(2)} > ${p.maxFitRmseDb} dB`);
  }

  const t60 = -60 / fit.m; // seconds for a 60 dB drop
  if (!(t60 > 0) || !Number.isFinite(t60)) return none("NON_FINITE_T60");

  return {
    value: t60,
    reason: null,
    fitStartS: tS[i0],
    fitEndS: tS[i1],
    slopeDbPerS: fit.m,
    interceptDb: fit.b,
    rmseDb: fit.rmse,
    r2: fit.r2,
  };
}

export interface AnalyzeInput {
  samples: Float64Array | number[];
  sampleRate: number;
  window: WindowSpec;
  params: AnalysisParams;
}

/**
 * Full analysis. Time zero = direct-sound onset. Samples before onset are
 * excluded from early/late energy splits; they only feed the noise estimate.
 */
export function analyze(input: AnalyzeInput): AnalysisReport {
  const { samples, sampleRate, window: w, params: p } = input;
  const N = samples.length;
  const flags: string[] = [];

  // Noise power from pre-onset window (mean square).
  const noisePower = (() => {
    let s = 0;
    for (let i = w.noiseStart; i < w.noiseEnd; i++) s += samples[i] * samples[i];
    return w.noiseEnd > w.noiseStart ? s / (w.noiseEnd - w.noiseStart) : 0;
  })();

  const correct = (x: number): number => {
    if (p.noiseStrategy !== "subtract") return x * x;
    const v = x * x - noisePower;
    return v > 0 ? v : 0;
  };

  // Usable segment: onset .. integrationEnd.
  const end = Math.min(w.integrationEnd, N);
  const usable = Math.max(0, end - w.onset);
  const energy = new Float64Array(usable);
  let peakPower = 0;
  for (let i = 0; i < usable; i++) {
    energy[i] = correct(samples[w.onset + i]);
    if (energy[i] > peakPower) peakPower = energy[i];
  }
  // Robust signal reference: a single noise spike can exceed the direct sound
  // sample, so use a high percentile of the corrected energy rather than the
  // absolute maximum when judging the noise-floor ceiling.
  const sortedPeak = (() => {
    const copy = Array.from(energy).sort((x, y) => y - x);
    const idx = Math.min(copy.length - 1, Math.floor(copy.length * 0.001));
    return copy[idx] || peakPower;
  })();

  // Backward integrated (Schroeder) energy: E(t) = integral_t^end p dt.
  const tail = new Float64Array(usable);
  let acc = 0;
  for (let i = usable - 1; i >= 0; i--) {
    acc += energy[i];
    tail[i] = acc;
  }

  // Optional noise-crossing truncation of the *displayed* curve end.
  let effEnd = usable;
  if (p.tailStrategy === "noise_crossing" && noisePower > 0) {
    for (let i = usable - 1; i >= 0; i--) {
      if (energy[i] > 2 * noisePower) {
        effEnd = i + 1;
        break;
      }
    }
  }

  const e0 = tail[0] ?? 0;
  const tS: number[] = [];
  const db: number[] = [];
  for (let i = 0; i < effEnd; i++) {
    tS.push(i / sampleRate);
    const r = e0 > 0 ? tail[i] / e0 : 0;
    db.push(r > 0 ? 10 * Math.log10(r) : DB_FLOOR);
  }

  const dynamicRangeDb = db.length ? db[0] - db[db.length - 1] : 0;
  const noiseToPeakDb = sortedPeak > 0 && noisePower > 0
    ? 10 * Math.log10(noisePower / sortedPeak)
    : -Infinity;

  if (peakPower <= 0) flags.push("ZERO_ENERGY");
  if (usable < p.minFitSamples) flags.push("RECORD_TOO_SHORT");
  if (noiseToPeakDb !== -Infinity && noiseToPeakDb > p.maxNoiseToPeakDb) {
    flags.push("NOISE_FLOOR_TOO_HIGH");
  }
  if (dynamicRangeDb < p.minDynamicRangeDb) flags.push("INSUFFICIENT_DYNAMIC_RANGE");

  const EDT = estimate(tS, db, p.edtDbRange[0], p.edtDbRange[1], dynamicRangeDb, p);
  const T20 = estimate(tS, db, p.t20DbRange[0], p.t20DbRange[1], dynamicRangeDb, p);
  const T30 = estimate(tS, db, p.t30DbRange[0], p.t30DbRange[1], dynamicRangeDb, p);
  for (const [name, e] of [["EDT", EDT], ["T20", T20], ["T30", T30]] as const) {
    if (e.value === null) flags.push(`${name}_UNESTIMABLE`);
  }

  // Energy ratios. Early energy includes the onset sample; late starts after
  // the boundary sample. Pre-onset silence never enters either integral.
  const ratioMetrics = (boundaryMs: number): { c: number | null; d?: number } => {
    const bSamples = Math.round((boundaryMs / 1000) * sampleRate);
    const cut = Math.min(Math.max(bSamples, 0), usable);
    let early = 0,
      late = 0;
    for (let i = 0; i < cut; i++) early += energy[i];
    for (let i = cut; i < usable; i++) late += energy[i];
    const total = early + late;
    if (total <= 0) return { c: null };
    const d = early / total;
    if (late <= 0) {
      // Real single impulse: C = +Inf mathematically. It must never masquerade
      // as a finite value, so it is reported null; D50 is still defined (=1).
      return { c: null, d };
    }
    return { c: 10 * Math.log10(early / late), d };
  };

  const r50 = ratioMetrics(p.c50Ms);
  const r80 = ratioMetrics(p.c80Ms);
  const C50 = r50.c;
  const C80 = r80.c;
  const D50 = r50.d === undefined ? null : r50.d;
  if (C50 === null || C80 === null || D50 === null) flags.push("ENERGY_RATIO_UNDEFINED");

  return {
    paramVersion: p.version,
    sampleRate,
    onsetSample: w.onset,
    noiseStart: w.noiseStart,
    noiseEnd: w.noiseEnd,
    integrationEnd: end,
    usableSamples: usable,
    durationS: usable / sampleRate,
    noisePower,
    peakPower,
    dynamicRangeDb,
    noiseToPeakDb: noiseToPeakDb === -Infinity ? DB_FLOOR : noiseToPeakDb,
    schroeder: { tS, db },
    EDT,
    T20,
    T30,
    C50,
    C80,
    D50,
    flags,
  };
}
