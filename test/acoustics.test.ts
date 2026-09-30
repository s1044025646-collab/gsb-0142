import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, detectOnset } from "../src/acoustics.ts";
import { synthesize, alphaForT60 } from "../src/synth.ts";

function pureDecay(fs: number, t60: number, durationSec: number, lead = 0): number[] {
  const n = Math.round(durationSec * fs);
  const alpha = alphaForT60(t60);
  const x = new Array<number>(n).fill(0);
  for (let i = lead; i < n; i++) x[i] = Math.exp((-alpha * (i - lead)) / fs);
  return x;
}

test("analytic exponential decay: T20/T30/EDT match theoretical T60", () => {
  const fs = 16000;
  const t60 = 1.2;
  const x = pureDecay(fs, t60, 2.0);
  const r = analyze(x, fs, { onsetIndex: 0 });
  assert.ok(r.t30.value !== null && Math.abs(r.t30.value - t60) / t60 < 0.02, `T30=${r.t30.value}`);
  assert.ok(r.t20.value !== null && Math.abs(r.t20.value - t60) / t60 < 0.02, `T20=${r.t20.value}`);
  assert.ok(r.edt.value !== null && Math.abs(r.edt.value - t60) / t60 < 0.05, `EDT=${r.edt.value}`);
  assert.equal(r.flags.length, 0);
});

test("RT is extrapolated from slope, not recording length", () => {
  const fs = 16000;
  const x = pureDecay(fs, 0.5, 1.0); // recording is 1.0 s, T60 is 0.5 s
  const r = analyze(x, fs, { onsetIndex: 0 });
  assert.ok(r.t30.value !== null && Math.abs(r.t30.value - 0.5) < 0.02);
  assert.notEqual(r.t30.value, r.durationSec);
});

test("amplitude scaling invariance", () => {
  const fs = 16000;
  const x = pureDecay(fs, 1.0, 2.0);
  const y = x.map((v) => v * 7.3);
  const a = analyze(x, fs, { onsetIndex: 0 });
  const b = analyze(y, fs, { onsetIndex: 0 });
  for (const k of ["edt", "t20", "t30", "c50", "c80", "d50"] as const) {
    assert.ok(Math.abs((a[k].value ?? 0) - (b[k].value ?? 0)) < 1e-6, k);
  }
});

test("sample-rate equivalence: same T60 at 8k and 32k", () => {
  const t60 = 0.8;
  const a = analyze(pureDecay(8000, t60, 2.0), 8000, { onsetIndex: 0 });
  const b = analyze(pureDecay(32000, t60, 2.0), 32000, { onsetIndex: 0 });
  assert.ok(a.t30.value !== null && b.t30.value !== null);
  assert.ok(Math.abs(a.t30.value - b.t30.value) / t60 < 0.02);
});

test("leading silence: excluded from onset-referenced metrics", () => {
  const fs = 16000;
  const lead = Math.round(0.3 * fs);
  const x = pureDecay(fs, 1.0, 2.3, lead);
  const onset = detectOnset(x);
  assert.equal(onset, lead);
  const withSilence = analyze(x, fs, { onsetIndex: lead });
  const without = analyze(pureDecay(fs, 1.0, 2.0), fs, { onsetIndex: 0 });
  assert.ok(Math.abs((withSilence.t30.value ?? 0) - (without.t30.value ?? 0)) < 1e-6);
  assert.ok(Math.abs((withSilence.d50.value ?? 0) - (without.d50.value ?? 0)) < 1e-6);
});

test("hand-computed C50/C80/D50 at exact 50/80 ms boundaries", () => {
  const fs = 10000;
  const n = fs; // 1 s
  const x = new Array<number>(n).fill(0);
  x[0] = 1; // early impulse (energy 1)
  x[Math.round(0.05 * fs)] = 1; // exactly at the 50 ms boundary -> late
  x[Math.round(0.08 * fs)] = 2; // exactly at the 80 ms boundary -> late for C80
  const r = analyze(x, fs, { onsetIndex: 0, noiseStart: n - 1, noiseEnd: n });
  // early(50ms) = 1, late = 1 + 4 = 5
  assert.ok(r.c50.value !== null && Math.abs(r.c50.value - 10 * Math.log10(1 / 5)) < 1e-9);
  // early(80ms) = 1 + 1 = 2, late = 4
  assert.ok(r.c80.value !== null && Math.abs(r.c80.value - 10 * Math.log10(2 / 4)) < 1e-9);
  assert.ok(r.d50.value !== null && Math.abs(r.d50.value - (100 * 1) / 6) < 1e-9);
});

test("impulse just inside 50 ms boundary counts as early", () => {
  const fs = 10000;
  const n = fs;
  const x = new Array<number>(n).fill(0);
  x[0] = 1;
  x[Math.round(0.05 * fs) - 1] = 1; // one sample before boundary -> early
  x[Math.round(0.05 * fs)] = 1; // at boundary -> late
  const r = analyze(x, fs, { onsetIndex: 0, noiseStart: n - 1, noiseEnd: n });
  assert.ok(r.c50.value !== null && Math.abs(r.c50.value - 10 * Math.log10(2 / 1)) < 1e-9);
});

test("single impulse: no fake RT, no Infinity", () => {
  const fs = 16000;
  const x = new Array<number>(fs).fill(0);
  x[0] = 1;
  const r = analyze(x, fs, { onsetIndex: 0 });
  assert.equal(r.edt.value, null);
  assert.equal(r.t20.value, null);
  assert.equal(r.t30.value, null);
  assert.ok(r.t30.flags.includes("INSUFFICIENT_DYNAMIC_RANGE"));
  assert.equal(r.c50.value, null);
  assert.ok(r.c50.flags.includes("ZERO_LATE_ENERGY"));
  assert.equal(r.d50.value, 100);
  for (const m of [r.edt, r.t20, r.t30, r.c50, r.c80, r.d50]) {
    if (m.value !== null) assert.ok(Number.isFinite(m.value));
  }
});

test("two-stage decay: Schroeder curve shows a knee, T30 between the two stages", () => {
  const fs = 16000;
  const n = 3 * fs;
  const a1 = alphaForT60(0.4);
  const a2 = alphaForT60(2.4);
  // Knee at -10 dB so the EDT range sees only the fast early slope.
  const knee = Math.round((10 / (60 / 0.4)) * fs);
  const x = new Array<number>(n).fill(0);
  const carry = Math.exp((-a1 * knee) / fs);
  for (let i = 0; i < n; i++) {
    x[i] = i < knee ? Math.exp((-a1 * i) / fs) : carry * Math.exp((-a2 * (i - knee)) / fs);
  }
  const r = analyze(x, fs, { onsetIndex: 0 });
  assert.ok(r.t30.value !== null && r.t30.value > 0.4 && r.t30.value < 2.4, `T30=${r.t30.value}`);
  // Early part of the decay curve falls faster than the late part.
  const at = (t: number) => {
    const p = r.decayCurve.find((q) => q.t >= t && q.levelDb !== null);
    return p?.levelDb ?? null;
  };
  const earlySlope = ((at(0.05) ?? 0) - (at(0) ?? 0)) / 0.05;
  const lateSlope = ((at(1.0) ?? 0) - (at(0.5) ?? 0)) / 0.5;
  assert.ok(earlySlope < lateSlope, `early ${earlySlope} dB/s vs late ${lateSlope} dB/s`);
});

test("high noise floor is flagged", () => {
  const { sampleRate, samples } = synthesize({ type: "noisy-decay", t60: 0.8, noiseSnrDb: 12, seed: 7 });
  const r = analyze(samples, sampleRate, { onsetIndex: 0 });
  assert.ok(r.flags.includes("NOISE_FLOOR_HIGH"));
});

test("too-short recording is rejected", () => {
  const fs = 16000;
  const x = pureDecay(fs, 0.02, 0.05);
  const r = analyze(x, fs, { onsetIndex: 0 });
  assert.ok(r.flags.includes("TOO_SHORT_RECORDING"));
  assert.equal(r.t30.value, null);
  assert.equal(r.c50.value, null);
});

test("all-zero input: ZERO_ENERGY, everything null, no Infinity", () => {
  const r = analyze(new Array<number>(8000).fill(0), 16000, { onsetIndex: 0 });
  assert.ok(r.flags.includes("ZERO_ENERGY"));
  for (const m of [r.edt, r.t20, r.t30, r.c50, r.c80, r.d50]) assert.equal(m.value, null);
  assert.ok(Number.isFinite(JSON.stringify(r).length));
});

test("invalid windows throw ValidationError", () => {
  const x = pureDecay(16000, 1, 1);
  assert.throws(() => analyze(x, 16000, { onsetIndex: -1 }), /onsetIndex/);
  assert.throws(() => analyze(x, 16000, { onsetIndex: 0, integrationEnd: 0 }), /integrationEnd/);
  assert.throws(() => analyze(x, 16000, { onsetIndex: 0, noiseStart: 100, noiseEnd: 100 }), /noise window/);
  assert.throws(() => analyze(x, 0, { onsetIndex: 0 }), /sampleRate/);
});

test("synthesized noisy decay recovers T60 within tolerance", () => {
  const t60 = 1.0;
  const { sampleRate, samples } = synthesize({ type: "noisy-decay", t60, noiseSnrDb: 55, seed: 3, durationSec: 3 });
  const r = analyze(samples, sampleRate, { onsetIndex: 0 });
  assert.ok(r.t30.value !== null && Math.abs(r.t30.value - t60) / t60 < 0.1, `T30=${r.t30.value}`);
});

test("decay curve and residuals are finite and bounded", () => {
  const x = pureDecay(16000, 1.2, 2.0);
  const r = analyze(x, 16000, { onsetIndex: 0 });
  assert.ok(r.decayCurve.length > 0 && r.decayCurve.length <= 1000);
  assert.ok(r.residuals.length > 0 && r.residuals.length <= 500);
  for (const p of r.residuals) assert.ok(Number.isFinite(p.residualDb));
  const maxAbsRes = Math.max(...r.residuals.map((p) => Math.abs(p.residualDb)));
  assert.ok(maxAbsRes < 1.0, `max residual ${maxAbsRes} dB`);
});
