import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { analyze, AnalysisReport } from "../src/core/acoustics.js";
import { generateIR } from "../src/core/generator.js";
import { PARAM_V1 } from "../src/core/params.js";

export function tempDbPath(): string {
  return mkdtempSync(join(tmpdir(), "acoustic-")).replace(/\//g, "\\") + "\\t.sqlite";
}

export function makeRepo(path = tempDbPath()): { repo: Repo; path: string } {
  const db = openDb(path);
  return { repo: new Repo(db), path };
}

/** Build a clean exponential IR and analyze it with full window. */
export function analyzeSynthetic(opts: {
  sampleRate?: number;
  t60?: number;
  durationS?: number;
  preSilenceS?: number;
  amplitude?: number;
  noiseStd?: number;
  seed?: number;
  t2?: number;
  stage2StartS?: number;
  singlePulse?: boolean;
}): { report: AnalysisReport; samples: Float64Array; onset: number; sr: number } {
  const sr = opts.sampleRate ?? 1000;
  const pre = opts.preSilenceS ?? 0;
  const t60 = opts.t60 ?? 0.5;
  const g = generateIR({
    sampleRate: sr,
    t1S: t60,
    t2S: opts.t2,
    stage2StartS: opts.stage2StartS,
    preSilenceS: pre,
    durationS: (opts.durationS ?? 1.6) + pre,
    onsetAmplitude: opts.amplitude ?? 1,
    noiseStd: opts.noiseStd ?? 0,
    singlePulse: opts.singlePulse,
    rng: (() => {
      let s = (opts.seed ?? 7) >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    })(),
  });
  const onset = g.onsetSample;
  const report = analyze({
    samples: g.samples,
    sampleRate: sr,
    window: {
      onset,
      noiseStart: 0,
      noiseEnd: onset,
      integrationEnd: g.samples.length,
    },
    params: PARAM_V1,
  });
  return { report, samples: g.samples, onset, sr };
}
