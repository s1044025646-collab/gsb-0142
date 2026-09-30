import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { makeRepo, tempDbPath } from "./helpers.js";
import { ApiError, Repo } from "../src/db/repo.js";
import { openDb } from "../src/db/db.js";
import { runAnalysis } from "../src/core/service.js";
import { generateIR } from "../src/core/generator.js";
import { mulberryLike } from "./rng.js";

function synth(point: { id: number }, repo: Repo, key = "k1") {
  const g = generateIR({
    sampleRate: 1000,
    t1S: 0.4,
    durationS: 1.4,
    rng: mulberryLike(1),
  });
  const r = repo.importResponse(point.id, 1000, g.samples, key);
  return { ...r, ...g };
}

test("idempotent import: duplicate key returns same row, no new record", () => {
  const { repo } = makeRepo();
  const p = repo.createPoint("A");
  const first = synth(p, repo, "dup-key");
  const second = synth(p, repo, "dup-key");
  assert.equal(first.id, second.id);
  assert.equal(second.duplicated, true);
  assert.equal(repo.listResponses(p.id, 1, 100).total, 1);
});

test("validation error codes", () => {
  const { repo } = makeRepo();
  assert.throws(() => repo.createPoint("bad alias!"), (e: Error) =>
    (e as ApiError).code === "INVALID_ALIAS",
  );
  const p = repo.createPoint("B");
  assert.throws(
    () => repo.importResponse(p.id, 0, [1, 2, 3]),
    (e: Error) => (e as ApiError).code === "INVALID_SAMPLE_RATE",
  );
  assert.throws(
    () => repo.importResponse(p.id, 1000, [1, NaN]),
    (e: Error) => (e as ApiError).code === "NON_FINITE_SAMPLE",
  );
});

test("window revision creates a new window and keeps samples immutable", () => {
  const { repo } = makeRepo();
  const p = repo.createPoint("C");
  const r = synth(p, repo);
  const before = repo.getResponseSamples(r.id).samples;
  const w1 = repo.setWindow(r.id, { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: 1000 });
  const w2 = repo.setWindow(
    r.id,
    { onset: 5, noiseStart: 0, noiseEnd: 5, integrationEnd: 990 },
    "manual re-pick",
  );
  assert.notEqual(w1.id, w2.id);
  assert.equal(repo.listWindows(r.id).length, 2);
  const after = repo.getResponseSamples(r.id).samples;
  assert.deepEqual(Array.from(before), Array.from(after));
});

test("invalid window boundaries rejected with codes", () => {
  const { repo } = makeRepo();
  const p = repo.createPoint("D");
  const r = synth(p, repo);
  assert.throws(
    () => repo.setWindow(r.id, { onset: 0, noiseStart: 0, noiseEnd: 5, integrationEnd: 10 }),
    (e: Error) => (e as ApiError).code === "INVALID_NOISE_WINDOW",
  );
  assert.throws(
    () => repo.setWindow(r.id, { onset: 10, noiseStart: 0, noiseEnd: 5, integrationEnd: 10 }),
    (e: Error) => (e as ApiError).code === "INVALID_INTEGRATION_END",
  );
});

test("re-analysis with same window+version is idempotent and reproduces report", () => {
  const { repo } = makeRepo();
  const p = repo.createPoint("E");
  const r = synth(p, repo);
  repo.setWindow(r.id, { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: r.sample_count });
  const a1 = runAnalysis(repo, r.id);
  const a2 = runAnalysis(repo, r.id);
  assert.equal(a1.analysisId, a2.analysisId);
  assert.equal(a2.duplicated, true);
  assert.equal(a1.report.T30.value, a2.report.T30.value);
  assert.equal(JSON.stringify(a1.report), JSON.stringify(a2.report));
});

test("revised window produces a separate analysis; both frozen/version-pinned", () => {
  const { repo } = makeRepo();
  const p = repo.createPoint("F");
  const r = synth(p, repo);
  repo.setWindow(r.id, { onset: 0, noiseStart: 0, noiseEnd: 0, integrationEnd: r.sample_count });
  const a1 = runAnalysis(repo, r.id);
  repo.setWindow(r.id, { onset: 1, noiseStart: 0, noiseEnd: 1, integrationEnd: r.sample_count });
  const a2 = runAnalysis(repo, r.id);
  assert.notEqual(a1.analysisId, a2.analysisId);
  const frozen = repo.freezeAnalysis(a1.analysisId);
  assert.equal(frozen.frozen, 1);
});

test("transaction rolls back on failure", () => {
  const { repo } = makeRepo();
  assert.throws(() =>
    repo.tx(() => {
      repo.createPoint("TX1");
      throw new Error("boom");
    }),
  );
  assert.equal(repo.findPointByAlias("TX1"), undefined);
});

test("persistence across reopen", () => {
  const path = tempDbPath();
  {
    const db = openDb(path);
    const repo = new Repo(db);
    const p = repo.createPoint("PERSIST");
    const g = generateIR({ sampleRate: 1000, t1S: 0.4, durationS: 1.4 });
    const r = repo.importResponse(p.id, 1000, g.samples, "k");
    repo.setWindow(r.id, {
      onset: 0,
      noiseStart: 0,
      noiseEnd: 0,
      integrationEnd: r.sample_count,
    });
    runAnalysis(repo, r.id);
    db.close();
  }
  assert.ok(existsSync(path));
  {
    const db = openDb(path); // migrations re-run safely
    const repo = new Repo(db);
    const p = repo.findPointByAlias("PERSIST");
    assert.ok(p);
    const list = repo.listResponses(p!.id, 1, 100);
    assert.equal(list.total, 1);
    const analyses = repo.listAnalyses(list.items[0].id, 1, 100);
    assert.equal(analyses.total, 1);
    db.close();
  }
  rmSync(path, { force: true });
});

test("pagination metadata", () => {
  const { repo } = makeRepo();
  for (let i = 0; i < 5; i++) repo.createPoint(`P${i}`);
  const page = repo.listPoints(1, 2);
  assert.equal(page.total, 5);
  assert.equal(page.totalPages, 3);
  assert.equal(page.items.length, 2);
  const last = repo.listPoints(9, 2);
  assert.equal(last.page, 3);
  assert.equal(last.items.length, 1);
});
