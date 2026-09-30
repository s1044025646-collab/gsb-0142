import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb } from "../src/db.ts";
import * as store from "../src/store.ts";
import { synthesize } from "../src/synth.ts";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-reverb-test-"));
  return path.join(dir, "test.db");
}

test("state survives restart (close + reopen)", () => {
  const dbPath = tmpDb();
  const clock = () => new Date("2026-09-30T10:00:00.000Z");
  let analysisId = 0;
  {
    const app = openDb(dbPath, clock);
    const p = store.createPoint(app, "hall-a") as { id: number };
    const { sampleRate, samples } = synthesize({ type: "decay", t60: 1.5, seed: 1 });
    const { response } = store.importResponse(app, {
      pointId: p.id,
      sampleRate,
      samples,
      idempotencyKey: "k1",
    });
    const a = store.runAnalysis(app, (response as { id: number }).id, {});
    analysisId = a.id;
    app.close();
  }
  {
    const app = openDb(dbPath, clock); // migrations re-run: must be idempotent
    assert.deepEqual(store.counts(app), { points: 1, responses: 1, analyses: 1 });
    const a = store.getAnalysis(app, analysisId);
    assert.equal(a.paramVersion, 1);
    assert.equal(a.frozen, true);
    assert.ok(a.results.t30.value !== null && Math.abs(a.results.t30.value - 1.5) < 0.15);
    assert.equal(a.createdAt, "2026-09-30T10:00:00.000Z");
    app.close();
  }
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("transaction rollback leaves no partial writes", () => {
  const app = openDb(":memory:");
  const p = store.createPoint(app, "hall-b") as { id: number };
  const before = store.counts(app);
  assert.throws(() =>
    app.transaction(() => {
      const { sampleRate, samples } = synthesize({ type: "decay", seed: 2 });
      store.importResponse(app, { pointId: p.id, sampleRate, samples, idempotencyKey: "ok-1" });
      store.importResponse(app, { pointId: p.id, sampleRate, samples, idempotencyKey: "ok-1" });
      // second import is idempotent (no throw); force a failure instead:
      throw new Error("simulated failure");
    }),
  );
  assert.deepEqual(store.counts(app), before);
  // And a genuinely failing batch (bad second item) rolls back the first item.
  assert.throws(() =>
    app.transaction(() => {
      const { sampleRate, samples } = synthesize({ type: "decay", seed: 3 });
      store.importResponse(app, { pointId: p.id, sampleRate, samples });
      store.importResponse(app, { pointId: p.id, sampleRate: -5, samples });
    }),
  );
  assert.deepEqual(store.counts(app), before);
  app.close();
});

test("migrations are repeatable on the same handle", () => {
  const app = openDb(":memory:");
  app.migrate();
  app.migrate();
  const v = app.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
  assert.equal(v.c, 1);
  app.close();
});

test("failed analysis does not consume a param version", () => {
  const app = openDb(":memory:");
  const p = store.createPoint(app, "hall-c") as { id: number };
  const { sampleRate, samples } = synthesize({ type: "decay", seed: 4 });
  const { response } = store.importResponse(app, { pointId: p.id, sampleRate, samples });
  const rid = (response as { id: number }).id;
  assert.throws(() => store.runAnalysis(app, rid, { onsetIndex: 10 ** 9 }));
  const a = store.runAnalysis(app, rid, {});
  assert.equal(a.paramVersion, 1);
  app.close();
});
