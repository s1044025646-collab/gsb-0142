/**
 * Direct-sound onset preview. Suggests an onset from the strongest sample
 * or a dB threshold relative to peak. This is only a suggestion; the stored
 * onset is whatever the operator sets.
 */
export interface OnsetPreview {
  /** Index of the maximum |sample|. */
  peakIndex: number;
  peakAmplitude: number;
  /** First index reaching thresholdDb below peak (back-searched). */
  thresholdIndex: number;
  suggestedOnset: number;
  /** Sparse ASCII-free preview buckets (mean |x|) for CLI display. */
  buckets: { startSample: number; meanAbs: number }[];
}

export function previewOnset(
  samples: ArrayLike<number>,
  opts: { thresholdDb?: number; bucketCount?: number } = {},
): OnsetPreview {
  const thresholdDb = opts.thresholdDb ?? -20;
  const bucketCount = Math.max(1, opts.bucketCount ?? 24);
  let peakIndex = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) {
      peak = a;
      peakIndex = i;
    }
  }
  const level = peak * Math.pow(10, thresholdDb / 20);
  let thresholdIndex = peakIndex;
  while (thresholdIndex > 0 && Math.abs(samples[thresholdIndex - 1]) >= level) {
    thresholdIndex--;
  }

  const buckets: { startSample: number; meanAbs: number }[] = [];
  const width = Math.max(1, Math.floor(samples.length / bucketCount));
  for (let b = 0; b < samples.length; b += width) {
    const e = Math.min(b + width, samples.length);
    let s = 0;
    for (let i = b; i < e; i++) s += Math.abs(samples[i]);
    buckets.push({ startSample: b, meanAbs: s / (e - b) });
  }

  return {
    peakIndex,
    peakAmplitude: peak,
    thresholdIndex,
    suggestedOnset: thresholdIndex,
    buckets,
  };
}
