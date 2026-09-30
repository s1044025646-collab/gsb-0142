// Core full-band room-acoustics metrics.
//
// Definitions (all full-band, single channel):
//  - Time zero: the direct-sound onset sample index (user-set or auto-detected).
//    All metric times and early/late splits are relative to this index; samples
//    before it never enter any energy sum.
//  - Schroeder decay curve: L(t) = 10*log10( E(t) / E(0) ), where
//    E(t) = sum_{i=t}^{integrationEnd-1} e[i] is the reverse-cumulative
//    (backwards-integrated) energy of the noise-corrected squared signal
//    e[i] = max(x[i]^2 - noisePower, 0).
//  - Noise handling: noisePower is the mean of x^2 over the noise window
//    (default: last 10% of the integration window). It is subtracted from the
//    squared signal and clamped at zero (strategy disclosed in README).
//  - EDT/T20/T30: least-squares line fitted to L(t) over [0,-10] / [-5,-25] /
//    [-5,-35] dB; reverberation time = -60 / slope (extrapolated from the
//    fitted slope, never the recording length).
//  - C50/C80 = 10*log10(early/late), D50 = 100*early/(early+late), with the
//    early/late boundary at exactly 50/80 ms after the onset.
//  - Zero or missing energy never yields Infinity/NaN: the metric is null and
//    a flag explains why.

export interface WindowParams {
  onsetIndex: number;
  noiseStart?: number | null;
  noiseEnd?: number | null;
  integrationEnd?: number | null;
}

export interface FitInfo {
  slopeDbPerSec: number;
  interceptDb: number;
  r2: number;
  rangeDb: [number, number];
  tStart: number;
  tEnd: number;
  pointCount: number;
}

export interface MetricValue {
  value: number | null;
  flags: string[];
}

export interface ResidualPoint {
  t: number;
  actualDb: number;
  fittedDb: number;
  residualDb: number;
}

export interface DecayPoint {
  t: number;
  levelDb: number | null;
}

export interface AnalysisResult {
  sampleRate: number;
  onsetIndex: number;
  integrationEnd: number;
  noiseWindow: { start: number; end: number; powerDb: number | null };
  peakToNoiseDb: number | null;
  durationSec: number;
  flags: string[];
  edt: MetricValue;
  t20: MetricValue;
  t30: MetricValue;
  c50: MetricValue;
  c80: MetricValue;
  d50: MetricValue;
  fits: { edt: FitInfo | null; t20: FitInfo | null; t30: FitInfo | null };
  residuals: ResidualPoint[];
  decayCurve: DecayPoint[];
}

export class ValidationError extends Error {
  code = "VALIDATION_ERROR";
}

const MIN_RECORDING_SEC = 0.1;
const MIN_FIT_POINTS = 3;
const MIN_FIT_SPAN_SEC = 0.005;
const MIN_R2 = 0.9;
const NOISE_HIGH_MARGIN_DB = 20;
const MAX_DECAY_POINTS = 1000;
const MAX_RESIDUAL_POINTS = 500;

function toDb(power: number): number {
  return 10 * Math.log10(power);
}

export function detectOnset(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i] * samples[i];
    if (p > peak) peak = p;
  }
  if (peak <= 0) return 0;
  const threshold = peak * 1e-3; // 30 dB below peak power
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] * samples[i] >= threshold) return i;
  }
  return 0;
}

function leastSquares(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const d = ys[i] - (slope * xs[i] + intercept);
    ssRes += d * d;
    const c = ys[i] - meanY;
    ssTot += c * c;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

function fitDecay(
  times: number[],
  levels: (number | null)[],
  hiDb: number,
  loDb: number,
): { fit: FitInfo | null; flags: string[] } {
  const flags: string[] = [];
  let minLevel = Infinity;
  for (const l of levels) if (l !== null && l < minLevel) minLevel = l;
  if (!(minLevel <= loDb)) {
    flags.push("INSUFFICIENT_DYNAMIC_RANGE");
    return { fit: null, flags };
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const l = levels[i];
    if (l !== null && l <= hiDb && l >= loDb) {
      xs.push(times[i]);
      ys.push(l);
    }
  }
  if (xs.length < MIN_FIT_POINTS || xs[xs.length - 1] - xs[0] < MIN_FIT_SPAN_SEC) {
    flags.push("INSUFFICIENT_FIT_POINTS");
    return { fit: null, flags };
  }
  const { slope, intercept, r2 } = leastSquares(xs, ys);
  if (!(slope < 0)) {
    flags.push("NON_DECAYING_TREND");
    return { fit: null, flags };
  }
  if (r2 < MIN_R2) {
    flags.push("FIT_UNRELIABLE");
    return { fit: null, flags };
  }
  return {
    fit: {
      slopeDbPerSec: slope,
      interceptDb: intercept,
      r2,
      rangeDb: [hiDb, loDb],
      tStart: xs[0],
      tEnd: xs[xs.length - 1],
      pointCount: xs.length,
    },
    flags,
  };
}

export function analyze(
  samples: ArrayLike<number>,
  sampleRate: number,
  params: WindowParams,
): AnalysisResult {
  const n = samples.length;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new ValidationError("sampleRate must be a positive number");
  }
  if (n === 0) throw new ValidationError("samples must not be empty");
  const onset = params.onsetIndex;
  if (!Number.isInteger(onset) || onset < 0 || onset >= n) {
    throw new ValidationError(`onsetIndex must be an integer in [0, ${n - 1}]`);
  }
  const intEnd = params.integrationEnd ?? n;
  if (!Number.isInteger(intEnd) || intEnd <= onset || intEnd > n) {
    throw new ValidationError(`integrationEnd must be an integer in (${onset}, ${n}]`);
  }
  const defaultNoiseStart = Math.max(onset, intEnd - Math.max(1, Math.round(0.1 * (intEnd - onset))));
  const ns = params.noiseStart ?? defaultNoiseStart;
  const ne = params.noiseEnd ?? intEnd;
  if (!Number.isInteger(ns) || !Number.isInteger(ne) || ns < 0 || ne > n || ns >= ne) {
    throw new ValidationError("noise window must satisfy 0 <= noiseStart < noiseEnd <= length");
  }

  let noiseSum = 0;
  for (let i = ns; i < ne; i++) noiseSum += samples[i] * samples[i];
  const noisePower = noiseSum / (ne - ns);

  let peak = 0;
  for (let i = onset; i < intEnd; i++) {
    const p = samples[i] * samples[i];
    if (p > peak) peak = p;
  }
  const peakToNoiseDb = noisePower > 0 ? toDb(peak / noisePower) : null;

  const len = intEnd - onset;
  const e = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const p = samples[onset + i] * samples[onset + i] - noisePower;
    e[i] = p > 0 ? p : 0;
  }

  const flags: string[] = [];
  const nullMetric = (...f: string[]): MetricValue => ({ value: null, flags: f });
  const emptyResult = (extraFlags: string[]): AnalysisResult => ({
    sampleRate,
    onsetIndex: onset,
    integrationEnd: intEnd,
    noiseWindow: { start: ns, end: ne, powerDb: noisePower > 0 ? toDb(noisePower) : null },
    peakToNoiseDb,
    durationSec: len / sampleRate,
    flags: extraFlags,
    edt: nullMetric(),
    t20: nullMetric(),
    t30: nullMetric(),
    c50: nullMetric(),
    c80: nullMetric(),
    d50: nullMetric(),
    fits: { edt: null, t20: null, t30: null },
    residuals: [],
    decayCurve: [],
  });

  let totalEnergy = 0;
  for (let i = 0; i < len; i++) totalEnergy += e[i];
  if (!(totalEnergy > 0)) {
    return emptyResult(["ZERO_ENERGY"]);
  }

  const durationSec = len / sampleRate;
  if (durationSec < MIN_RECORDING_SEC) {
    return emptyResult(["TOO_SHORT_RECORDING"]);
  }

  if (peakToNoiseDb !== null && peakToNoiseDb < NOISE_HIGH_MARGIN_DB) {
    flags.push("NOISE_FLOOR_HIGH");
  }

  // Reverse-cumulative Schroeder integration.
  const E = new Float64Array(len);
  let acc = 0;
  for (let i = len - 1; i >= 0; i--) {
    acc += e[i];
    E[i] = acc;
  }
  const E0 = E[0];
  const times = new Array<number>(len);
  const levels = new Array<number | null>(len);
  for (let i = 0; i < len; i++) {
    times[i] = i / sampleRate;
    levels[i] = E[i] > 0 ? toDb(E[i] / E0) : null;
  }

  // Non-monotonic trend check on 5 ms short-time energy frames.
  const frame = Math.max(1, Math.round(0.005 * sampleRate));
  const frameCount = Math.floor(len / frame);
  if (frameCount >= 4) {
    const frameE = new Array<number>(frameCount).fill(0);
    for (let f = 0; f < frameCount; f++) {
      let s = 0;
      for (let i = f * frame; i < (f + 1) * frame; i++) s += e[i];
      frameE[f] = s;
    }
    let maxEarly = 0;
    const quarter = Math.max(1, Math.floor(frameCount / 4));
    for (let f = 0; f < quarter; f++) if (frameE[f] > maxEarly) maxEarly = frameE[f];
    for (let f = quarter; f < frameCount; f++) {
      if (frameE[f] > maxEarly * 4) {
        flags.push("NON_MONOTONIC_TREND");
        break;
      }
    }
  }

  const edtFit = fitDecay(times, levels, 0, -10);
  const t20Fit = fitDecay(times, levels, -5, -25);
  const t30Fit = fitDecay(times, levels, -5, -35);

  const rt = (fit: FitInfo | null): number | null =>
    fit && fit.slopeDbPerSec < 0 ? -60 / fit.slopeDbPerSec : null;

  const edt: MetricValue = { value: rt(edtFit.fit), flags: edtFit.flags };
  const t20: MetricValue = { value: rt(t20Fit.fit), flags: t20Fit.flags };
  const t30: MetricValue = { value: rt(t30Fit.fit), flags: t30Fit.flags };

  // Early/late energy ratios; boundary strictly after onset.
  const clarity = (ms: number): MetricValue => {
    const k = Math.round((ms / 1000) * sampleRate);
    if (k <= 0 || k >= len) return nullMetric("BOUNDARY_OUTSIDE_WINDOW");
    let early = 0, late = 0;
    for (let i = 0; i < k; i++) early += e[i];
    for (let i = k; i < len; i++) late += e[i];
    if (!(late > 0)) return nullMetric("ZERO_LATE_ENERGY");
    if (!(early > 0)) return nullMetric("ZERO_EARLY_ENERGY");
    return { value: toDb(early / late), flags: [] };
  };
  const c50 = clarity(50);
  const c80 = clarity(80);

  const k50 = Math.round(0.05 * sampleRate);
  let d50: MetricValue;
  if (k50 <= 0 || k50 >= len) {
    d50 = nullMetric("BOUNDARY_OUTSIDE_WINDOW");
  } else {
    let early = 0, late = 0;
    for (let i = 0; i < k50; i++) early += e[i];
    for (let i = k50; i < len; i++) late += e[i];
    const total = early + late;
    d50 = total > 0 ? { value: (100 * early) / total, flags: [] } : nullMetric("ZERO_ENERGY");
  }

  // Residuals from the widest reliable fit (prefer T30, then T20, then EDT),
  // evaluated over that fit's own time range.
  const bestFit = t30Fit.fit ?? t20Fit.fit ?? edtFit.fit;
  const residuals: ResidualPoint[] = [];
  if (bestFit) {
    const rstep = Math.max(1, Math.floor(len / MAX_RESIDUAL_POINTS));
    for (let i = 0; i < len; i += rstep) {
      if (times[i] < bestFit.tStart - 1e-12 || times[i] > bestFit.tEnd + 1e-12) continue;
      const l = levels[i];
      if (l === null) continue;
      const fitted = bestFit.slopeDbPerSec * times[i] + bestFit.interceptDb;
      residuals.push({ t: times[i], actualDb: l, fittedDb: fitted, residualDb: l - fitted });
    }
  }

  const decayCurve: DecayPoint[] = [];
  const dstep = Math.max(1, Math.floor(len / MAX_DECAY_POINTS));
  for (let i = 0; i < len; i += dstep) {
    decayCurve.push({ t: times[i], levelDb: levels[i] });
  }

  return {
    sampleRate,
    onsetIndex: onset,
    integrationEnd: intEnd,
    noiseWindow: { start: ns, end: ne, powerDb: noisePower > 0 ? toDb(noisePower) : null },
    peakToNoiseDb,
    durationSec,
    flags,
    edt,
    t20,
    t30,
    c50,
    c80,
    d50,
    fits: { edt: edtFit.fit, t20: t20Fit.fit, t30: t30Fit.fit },
    residuals,
    decayCurve,
  };
}
