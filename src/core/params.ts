/**
 * Analysis parameter sets. Full-band analysis only (no octave bands).
 * Every parameter set is immutable and versioned. Re-running analysis with
 * the same sample + window + param version reproduces the identical report.
 */
export interface AnalysisParams {
  /** Semantic version of the parameter set, e.g. "1.0.0". */
  version: string;
  /**
   * Noise floor handling: "subtract" estimates noise power in the noise
   * window and subtracts it (Lundeby-style simple correction, clamped >= 0),
   * "none" uses raw squared energy.
   */
  noiseStrategy: "subtract" | "none";
  /**
   * Tail truncation: integration ends at the integration endpoint (in
   * samples, relative to the recording). Samples after the endpoint do not
   * contribute. "noise_crossing" additionally truncates where the corrected
   * energy first reaches the estimated noise floor.
   */
  tailStrategy: "endpoint" | "noise_crossing";
  /** EDT fit interval in dB: [0, -10] (slope extrapolated to 60 dB). */
  edtDbRange: readonly [number, number];
  /** T20 fit interval in dB: [-5, -25]. */
  t20DbRange: readonly [number, number];
  /** T30 fit interval in dB: [-5, -35]. */
  t30DbRange: readonly [number, number];
  /** Clarity/definition early boundary 50 ms. */
  c50Ms: number;
  /** Clarity early boundary 80 ms. */
  c80Ms: number;
  /** Definition early boundary 50 ms. */
  d50Ms: number;
  /** Minimum usable decay span (dB) for a reliable estimate. */
  minDynamicRangeDb: number;
  /**
   * Monotonicity guard: fraction (0..1) of allowed local upward deviations
   * in the Schroeder curve inside a fit window. Above it => non-monotonic.
   */
  maxNonMonotonicFraction: number;
  /** Minimum number of samples inside a fit window. */
  minFitSamples: number;
  /** Maximum allowed |normalized residual RMSE| (dB) for a good fit. */
  maxFitRmseDb: number;
  /** Noise floor ceiling: noise/peak energy ratio above this => too noisy. */
  maxNoiseToPeakDb: number;
}

export const PARAM_V1: AnalysisParams = Object.freeze({
  version: "1.0.0",
  noiseStrategy: "subtract",
  tailStrategy: "noise_crossing",
  edtDbRange: [0, -10] as const,
  t20DbRange: [-5, -25] as const,
  t30DbRange: [-5, -35] as const,
  c50Ms: 50,
  c80Ms: 80,
  d50Ms: 50,
  minDynamicRangeDb: 10,
  maxNonMonotonicFraction: 0.05,
  minFitSamples: 8,
  maxFitRmseDb: 1.5,
  maxNoiseToPeakDb: -10,
});

const REGISTRY: Readonly<Record<string, AnalysisParams>> = Object.freeze({
  "1.0.0": PARAM_V1,
});

export function getParams(version: string): AnalysisParams {
  const p = REGISTRY[version];
  if (!p) {
    const err = new Error(`unknown parameter version: ${version}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = "PARAM_VERSION_UNKNOWN";
    err.status = 400;
    throw err;
  }
  return p;
}

export function latestVersion(): string {
  return PARAM_V1.version;
}

export function listVersions(): string[] {
  return Object.keys(REGISTRY);
}
