import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core/acoustics.js";
import { PARAM_V1 } from "../src/core/params.js";
import { generateIR } from "../src/core/generator.js";
import { analyzeSynthetic } from "./helpers.js";

test("analytic exponential decay: T estimates recover theoretical T60", () => {
  // Envelope A(t)=10^(-3t/T60); Schroeder decay shares the same rate, so the
  // 60 dB extrapolation must return T60 regardless of which fit window.
  const { report } = analyzeSynthetic({ t60: 0.5, durationS: 1.6 });
  assert.ok(report.EDT.value !== null, report.EDT.reason ?? "");
  assert.ok(report.T20.value !== null, report.T20.reason ?? "");
  assert.ok(report.T30.value !== null, report.T30.reason ?? "");
  assert.ok(Math.abs((report.T30.value as number) - 0.5) < 0.02, `T30=${report.T30.value}`);
  assert.ok(Math.abs((report.T20.value as number) - 0.5) < 0.02, `T20=${report.T20.value}`);
  assert.ok(Math.abs((report.EDT.value as number) - 0.5) < 0.03, `EDT=${report.EDT.value}`);
});

test("amplitude scaling invariance (dB metrics and times unchanged)", () => {
  const a = analyzeSynthetic({ t60: 0.4, amplitude: 1 });
  const b = analyzeSynthetic({ t60: 0.4, amplitude: 1000 });
  for (const k of ["EDT", "T20", "T30"] as const) {
    assert.ok(Math.abs((a.report[k].value as number) - (b.report[k].value as number)) < 1e-6);
  }
  for (const k of ["C50", "C80", "D50"] as const) {
    assert.ok(Math.abs((a.report[k] as number) - (b.report[k] as number)) < 1e-9);
  }
});

test("sample-rate equivalence: same physical T60 at 1k and 8k Hz", () => {
  const a = analyzeSynthetic({ sampleRate: 1000, t60: 0.3, durationS: 1.2 });
  const b = analyzeSynthetic({ sampleRate: 8000, t60: 0.3, durationS: 1.2 });
  assert.ok(Math.abs((a.report.T30.value as number) - (b.report.T30.value as number)) < 0.01);
});

test("pre-onset silence does not shift energy boundaries (D50/C50)", () => {
  const noSilence = analyzeSynthetic({ t60: 0.5, preSilenceS: 0, durationS: 1.6 });
  const silenced = analyzeSynthetic({ t60: 0.5, preSilenceS: 0.05, durationS: 1.65 });
  assert.ok(Math.abs((noSilence.report.D50 as number) - (silenced.report.D50 as number)) < 1e-6);
  assert.ok(Math.abs((noSilence.report.C50 as number) - (silenced.report.C50 as number)) < 1e-6);
});

test("50/80 ms boundary: hand-computed C50/C80/D50 for a 1 s unit sequence", () => {
  // Samples 0..999 = 1 at 1000 Hz. Early [0,50) = 50 units; late [50,1000)=950.
  const sr = 1000;
  const samples = new Float64Array(1000).fill(1);
  const r = analyze({
    samples,
    sampleRate: sr,
    window: { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: 1000 },
    params: PARAM_V1,
  });
  const expectedC50 = 10 * Math.log10(50 / 950);
  const expectedD50 = 50 / 1000;
  // C80: early 80, late 920.
  const expectedC80 = 10 * Math.log10(80 / 920);
  assert.ok(Math.abs((r.C50 as number) - expectedC50) < 1e-9);
  assert.ok(Math.abs((r.C80 as number) - expectedC80) < 1e-9);
  assert.ok(Math.abs((r.D50 as number) - expectedD50) < 1e-12);
});

test("50/80 boundary sample is excluded from early (off-by-one check)", () => {
  // Put a distinct sample exactly at the 50 ms index; it must count as late.
  const sr = 1000;
  const samples = new Float64Array(1000).fill(0);
  for (let i = 0; i < 50; i++) samples[i] = 1; // 50 early units
  samples[50] = 10; // boundary sample -> late
  const r = analyze({
    samples,
    sampleRate: sr,
    window: { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: 1000 },
    params: PARAM_V1,
  });
  // early energy 50, late energy 100 => C50 = 10 log10(50/100)
  assert.ok(Math.abs((r.C50 as number) - 10 * Math.log10(0.5)) < 1e-9);
  void r;
});

test("hand-checked Schroeder decay and total energy", () => {
  // Two impulses of amplitude 2 (energy 4) and 1 (energy 1), both post-onset.
  const sr = 10;
  const samples = new Float64Array(5).fill(0);
  samples[0] = 2;
  samples[3] = 1;
  const r = analyze({
    samples,
    sampleRate: sr,
    window: { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: 5 },
    params: PARAM_V1,
  });
  const { db } = r.schroeder;
  // Tail energy at index 0 = 5 (4+1); at index 3 = 1. Ratio 1/5 -> -6.9897 dB.
  assert.ok(Math.abs(db[0] - 0) < 1e-12);
  assert.ok(Math.abs(db[3] - 10 * Math.log10(1 / 5)) < 1e-9);
  // D50 at sr=10: boundary round(0.05*10)=1 sample early -> early 4 / total 5.
  assert.ok(Math.abs((r.D50 as number) - 0.8) < 1e-12);
});

test("single pulse: C50/C80 not a fake finite value, D50=1, T unestimable", () => {
  const { report } = analyzeSynthetic({
    singlePulse: true,
    preSilenceS: 0.01,
    durationS: 0.2,
  });
  assert.equal(report.C50, null);
  assert.equal(report.C80, null);
  assert.equal(report.D50, 1);
  assert.equal(report.T30.value, null);
  assert.ok(report.flags.includes("ENERGY_RATIO_UNDEFINED"));
});

test("all-zero record: zero energy yields nulls and flags, never Infinity", () => {
  const samples = new Float64Array(500).fill(0);
  const r = analyze({
    samples,
    sampleRate: 1000,
    window: { onset: 10, noiseStart: 0, noiseEnd: 10, integrationEnd: 500 },
    params: PARAM_V1,
  });
  assert.equal(r.C50, null);
  assert.equal(r.T30.value, null);
  assert.ok(r.flags.includes("ZERO_ENERGY"));
  for (const v of [r.EDT.value, r.T20.value, r.T30.value, r.C50, r.C80, r.D50]) {
    assert.ok(v === null || Number.isFinite(v));
  }
});

test("too-short record is flagged unestimable", () => {
  const samples = new Float64Array(6).fill(0);
  samples[0] = 1;
  const r = analyze({
    samples,
    sampleRate: 1000,
    window: { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: 6 },
    params: PARAM_V1,
  });
  assert.ok(r.flags.includes("RECORD_TOO_SHORT") || r.T30.value === null);
});

test("dual-stage decay: stage 2 dominates late T30", () => {
  // Two distinct but close slopes; stage 2 (0.45 s) takes over around -11 dB,
  // inside the T20/T30 windows, pulling fitted T below stage-1 0.8 s.
  const { report } = analyzeSynthetic({
    t60: 0.8,
    t2: 0.45,
    stage2StartS: 0.15,
    preSilenceS: 0.01,
    durationS: 0.01 + 1.6,
  });
  assert.ok(report.T30.value !== null, report.T30.reason ?? "");
  assert.ok((report.T30.value as number) < 0.72, `T30=${report.T30.value}`);
  assert.ok((report.T30.value as number) > 0.45, `T30=${report.T30.value}`);
});

test("tail noise: excessive noise floor flags NOISE_FLOOR_TOO_HIGH", () => {
  const g = generateIR({
    sampleRate: 2000,
    t1S: 0.2,
    preSilenceS: 0.02,
    durationS: 0.52,
    onsetAmplitude: 1,
    noiseStd: 0.7,
    rng: mulberry(7),
  });
  const r = analyze({
    samples: g.samples,
    sampleRate: 2000,
    window: {
      onset: g.onsetSample,
      noiseStart: 0,
      noiseEnd: g.onsetSample,
      integrationEnd: g.samples.length,
    },
    params: PARAM_V1,
  });
  assert.ok(r.flags.includes("NOISE_FLOOR_TOO_HIGH"));
});

test("deterministic generator with fixed seed reproduces identical samples", () => {
  const a = generateIR({
    sampleRate: 1000,
    t1S: 0.3,
    noiseStd: 0.01,
    durationS: 0.5,
    rng: mulberry(42),
  });
  const b = generateIR({
    sampleRate: 1000,
    t1S: 0.3,
    noiseStd: 0.01,
    durationS: 0.5,
    rng: mulberry(42),
  });
  assert.deepEqual(Array.from(a.samples), Array.from(b.samples));
});

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

