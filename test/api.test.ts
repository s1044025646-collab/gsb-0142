import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, type RunningApp } from "../src/api.ts";
import { synthesize } from "../src/synth.ts";

let app: RunningApp;
let base: string;
const FIXED_NOW = new Date("2026-09-30T08:00:00.000Z");

before(async () => {
  app = await createApp({ dbPath: ":memory:", clock: () => FIXED_NOW });
  base = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  await app.close();
  app.db.close();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json as Record<string, unknown> };
}

test("health and injected clock", async () => {
  const r = await api("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test("point validation, duplicate alias, pagination", async () => {
  assert.equal((await api("POST", "/points", { alias: "!!bad!!" })).status, 400);
  const bad = await api("POST", "/points", { alias: "" });
  assert.equal(bad.status, 400);
  assert.equal((bad.body.error as { code: string }).code, "VALIDATION_ERROR");

  for (const alias of ["stage-left", "stage-right", "balcony"]) {
    const r = await api("POST", "/points", { alias });
    assert.equal(r.status, 201);
    assert.equal(r.body.createdAt, FIXED_NOW.toISOString());
  }
  const dup = await api("POST", "/points", { alias: "stage-left" });
  assert.equal(dup.status, 409);
  assert.equal((dup.body.error as { code: string }).code, "DUPLICATE_ALIAS");

  const page1 = await api("GET", "/points?page=1&pageSize=2");
  assert.equal(page1.body.total, 3);
  assert.equal((page1.body.items as unknown[]).length, 2);
  const page2 = await api("GET", "/points?page=2&pageSize=2");
  assert.equal((page2.body.items as unknown[]).length, 1);
  assert.equal((await api("GET", "/points?page=0")).status, 400);
  assert.equal((await api("GET", "/points/999")).status, 404);
});

test("import validation and idempotent re-submit", async () => {
  const missing = await api("POST", "/points/1/responses", { samples: [0, 1] });
  assert.equal(missing.status, 400); // sampleRate missing
  const badSr = await api("POST", "/points/1/responses", { sampleRate: 10, samples: [0, 1] });
  assert.equal(badSr.status, 400);
  const badSample = await api("POST", "/points/1/responses", { sampleRate: 16000, samples: [0, NaN] });
  assert.equal(badSample.status, 400);
  const notFound = await api("POST", "/points/999/responses", { sampleRate: 16000, samples: [0, 1] });
  assert.equal(notFound.status, 404);

  const { sampleRate, samples } = synthesize({ type: "decay", t60: 1.0, seed: 11 });
  const first = await api("POST", "/points/1/responses", {
    sampleRate,
    samples,
    idempotencyKey: "imp-001",
  });
  assert.equal(first.status, 201);
  const again = await api("POST", "/points/1/responses", {
    sampleRate,
    samples,
    idempotencyKey: "imp-001",
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  const list = await api("GET", "/points/1/responses");
  assert.equal(list.body.total, 1);
});

test("onset preview, analysis versions, residuals, decay table", async () => {
  const { sampleRate, samples } = synthesize({
    type: "decay",
    t60: 1.0,
    leadingSilenceSec: 0.2,
    seed: 5,
  });
  const imp = await api("POST", "/points/2/responses", { sampleRate, samples });
  const rid = imp.body.id as number;

  const preview = await api("POST", `/responses/${rid}/onset-preview`);
  const onset = preview.body.onsetIndex as number;
  assert.ok(Math.abs(onset - 0.2 * sampleRate) <= 2);

  const a1 = await api("POST", `/responses/${rid}/analyze`, {});
  assert.equal(a1.status, 201);
  assert.equal(a1.body.paramVersion, 1);
  assert.equal(a1.body.frozen, true);
  const t30a = (a1.body.results as { t30: { value: number } }).t30.value;
  assert.ok(Math.abs(t30a - 1.0) < 0.1);

  // Manual onset change -> new param version, raw samples untouched.
  const a2 = await api("POST", `/responses/${rid}/analyze`, { onsetIndex: onset + 10 });
  assert.equal(a2.body.paramVersion, 2);
  const versions = await api("GET", `/responses/${rid}/analyses`);
  assert.equal(versions.body.total, 2);

  const aid = a1.body.id as number;
  const residuals = await api("GET", `/analyses/${aid}/residuals`);
  assert.ok((residuals.body.residuals as unknown[]).length > 0);

  const table = await api("GET", `/analyses/${aid}/decay-table?stepMs=20`);
  const rows = table.body.rows as Array<{ t: number; levelDb: number | null }>;
  assert.ok(rows.length > 10);
  assert.ok(rows[0].t < rows[1].t);
  const csv = await fetch(`${base}/analyses/${aid}/decay-table?format=csv`);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.ok((await csv.text()).startsWith("t_sec,level_db"));

  // Version reproducibility: identical params -> identical results.
  const a3 = await api("POST", `/responses/${rid}/analyze`, {});
  assert.equal(a3.body.paramVersion, 3);
  assert.deepEqual(a3.body.results, a1.body.results);

  // Bad window rejected with 400, no new version created.
  const bad = await api("POST", `/responses/${rid}/analyze`, { onsetIndex: 99999999 });
  assert.equal(bad.status, 400);
  assert.equal((await api("GET", `/responses/${rid}/analyses`)).body.total, 3);
});

test("compare points and samples pagination", async () => {
  const p1Responses = (await api("GET", "/points/1/responses")).body.items as Array<{ id: number }>;
  await api("POST", `/responses/${p1Responses[0].id}/analyze`, {});
  const { sampleRate, samples } = synthesize({ type: "decay", t60: 2.0, seed: 9 });
  const imp = await api("POST", "/points/3/responses", { sampleRate, samples });
  await api("POST", `/responses/${imp.body.id}/analyze`, {});
  const cmp = await api("GET", "/compare?pointIds=1,3");
  assert.equal(cmp.status, 200);
  const pts = cmp.body.points as Array<{ analysis: { t30: { value: number } } }>;
  assert.ok(Math.abs(pts[0].analysis.t30.value - 1.0) < 0.15);
  assert.ok(Math.abs(pts[1].analysis.t30.value - 2.0) < 0.15);
  assert.equal((await api("GET", "/compare?pointIds=1")).status, 400);

  const s = await api("GET", `/responses/${imp.body.id}/samples?offset=10&limit=5`);
  assert.equal(s.body.count, 5);
  assert.equal((s.body.samples as number[]).length, 5);
});

test("unknown route and malformed JSON", async () => {
  assert.equal((await api("GET", "/nope")).status, 404);
  const res = await fetch(`${base}/points`, { method: "POST", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "INVALID_JSON");
});
