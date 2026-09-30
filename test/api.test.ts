import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { buildApp } from "../src/server/app.js";
import { generateIR } from "../src/core/generator.js";

let server: Server;
let base: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "acoustic-api-"));
  const db = openDb(join(dir, "t.sqlite"));
  const repo = new Repo(db);
  const app = buildApp(repo);
  server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may briefly retain the SQLite file; cleanup is best effort.
  }
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("health and param versions", async () => {
  const h = await call("GET", "/api/health");
  assert.equal(h.status, 200);
  const v = await call("GET", "/api/param-versions");
  assert.equal(v.json.data.latest, "1.0.0");
  const bad = await call("GET", "/api/param-versions/9.9.9");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "PARAM_VERSION_UNKNOWN");
});

test("404 has error code", async () => {
  const r = await call("GET", "/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
});

test("end-to-end: point, import (idempotent), window, analyze, freeze", async () => {
  const created = await call("POST", "/api/points", { alias: "ROOM1", note: "lab" });
  assert.equal(created.status, 200);
  const pointId = created.json.data.id;

  const dupAlias = await call("POST", "/api/points", { alias: "ROOM1" });
  assert.equal(dupAlias.status, 409);
  assert.equal(dupAlias.json.error.code, "ALIAS_EXISTS");

  const g = generateIR({ sampleRate: 1000, t1S: 0.4, durationS: 1.4 });
  const payload = {
    sampleRate: 1000,
    samples: Array.from(g.samples),
    idempotencyKey: "e2e-1",
  };
  const imp1 = await call("POST", `/api/points/${pointId}/responses`, payload);
  const imp2 = await call("POST", `/api/points/${pointId}/responses`, payload);
  assert.equal(imp1.json.data.id, imp2.json.data.id);
  assert.equal(imp2.json.data.duplicated, true);
  const rid = imp1.json.data.id;

  const badBody = await call("POST", `/api/points/${pointId}/responses`, { sampleRate: 1000 });
  assert.equal(badBody.json.error.code, "INVALID_BODY");

  const prev = await call("GET", `/api/responses/${rid}/onset-preview`);
  assert.equal(prev.status, 200);
  assert.ok(typeof prev.json.data.suggestedOnset === "number");

  const win = await call("POST", `/api/responses/${rid}/windows`, {
    onset: 0,
    noiseStart: 0,
    noiseEnd: 0,
    integrationEnd: g.samples.length,
  });
  assert.equal(win.status, 200);
  const wid = win.json.data.id;

  const badWin = await call("POST", `/api/responses/${rid}/windows`, {
    onset: 0,
    noiseStart: 0,
    noiseEnd: 5,
    integrationEnd: 10,
  });
  assert.equal(badWin.json.error.code, "INVALID_NOISE_WINDOW");

  const an = await call("POST", `/api/responses/${rid}/analyses`, { windowId: wid });
  assert.equal(an.status, 200);
  assert.ok(Math.abs(an.json.data.report.T30.value - 0.4) < 0.03);
  const aid = an.json.data.analysisId;

  const anAgain = await call("POST", `/api/responses/${rid}/analyses`, { windowId: wid });
  assert.equal(anAgain.json.data.analysisId, aid);
  assert.equal(anAgain.json.data.duplicated, true);

  const fr = await call("POST", `/api/analyses/${aid}/freeze`);
  assert.equal(fr.json.data.frozen, true);

  const list = await call("GET", `/api/responses/${rid}/analyses?page=1&pageSize=10`);
  assert.equal(list.json.data.total, 1);
});

test("invalid pagination rejected", async () => {
  const r = await call("GET", "/api/points?page=0");
  assert.equal(r.json.error.code, "INVALID_PAGINATION");
});

