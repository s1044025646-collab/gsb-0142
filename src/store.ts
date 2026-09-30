import crypto from "node:crypto";
import { AppDb } from "./db.ts";
import { analyze, detectOnset, ValidationError, type AnalysisResult, type WindowParams } from "./acoustics.ts";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function pageArgs(query: URLSearchParams): { page: number; pageSize: number } {
  const page = Number(query.get("page") ?? "1");
  const pageSize = Number(query.get("pageSize") ?? "20");
  if (!Number.isInteger(page) || page < 1) throw new ApiError(400, "VALIDATION_ERROR", "page must be an integer >= 1");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new ApiError(400, "VALIDATION_ERROR", "pageSize must be an integer in [1, 200]");
  }
  return { page, pageSize };
}

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export function createPoint(app: AppDb, alias: unknown) {
  if (typeof alias !== "string" || !ALIAS_RE.test(alias)) {
    throw new ApiError(400, "VALIDATION_ERROR", "alias must be 1-64 chars: letters, digits, space, _ . -");
  }
  const existing = app.db.prepare("SELECT id FROM points WHERE alias = ?").get(alias) as { id: number } | undefined;
  if (existing) throw new ApiError(409, "DUPLICATE_ALIAS", `alias '${alias}' already exists`);
  const info = app.db
    .prepare("INSERT INTO points (alias, created_at) VALUES (?, ?)")
    .run(alias, app.now());
  return getPoint(app, Number(info.lastInsertRowid));
}

export function getPoint(app: AppDb, id: number) {
  const p = app.db.prepare("SELECT id, alias, created_at AS createdAt FROM points WHERE id = ?").get(id);
  if (!p) throw new ApiError(404, "NOT_FOUND", `point ${id} not found`);
  return p;
}

export function listPoints(app: AppDb, page: number, pageSize: number): Page<unknown> {
  const total = (app.db.prepare("SELECT COUNT(*) AS c FROM points").get() as { c: number }).c;
  const items = app.db
    .prepare("SELECT id, alias, created_at AS createdAt FROM points ORDER BY id LIMIT ? OFFSET ?")
    .all(pageSize, (page - 1) * pageSize);
  return { items, total, page, pageSize };
}

function encodeSamples(samples: number[]): Buffer {
  const f32 = new Float32Array(samples);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeSamples(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

export interface ImportInput {
  pointId: number;
  sampleRate: unknown;
  samples: unknown;
  idempotencyKey?: unknown;
}

export function validateImport(input: ImportInput): {
  sampleRate: number;
  samples: number[];
  idempotencyKey: string | null;
} {
  const { sampleRate, samples, idempotencyKey } = input;
  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) {
    throw new ApiError(400, "VALIDATION_ERROR", "sampleRate must be a number in [1000, 384000]");
  }
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 5_000_000) {
    throw new ApiError(400, "VALIDATION_ERROR", "samples must be an array of 1..5,000,000 numbers");
  }
  for (let i = 0; i < samples.length; i++) {
    if (typeof samples[i] !== "number" || !Number.isFinite(samples[i])) {
      throw new ApiError(400, "VALIDATION_ERROR", `samples[${i}] must be a finite number`);
    }
  }
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new ApiError(400, "VALIDATION_ERROR", "idempotencyKey must be a string of 1..128 chars");
    }
  }
  return { sampleRate, samples: samples as number[], idempotencyKey: (idempotencyKey as string) ?? null };
}

export function importResponse(app: AppDb, input: ImportInput): { response: unknown; created: boolean } {
  const { sampleRate, samples, idempotencyKey } = validateImport(input);
  getPoint(app, input.pointId);
  if (idempotencyKey) {
    const dup = app.db
      .prepare("SELECT id FROM responses WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: number } | undefined;
    if (dup) return { response: getResponse(app, dup.id), created: false };
  }
  const blob = encodeSamples(samples);
  const sha = crypto.createHash("sha256").update(blob).digest("hex");
  const info = app.db
    .prepare(
      `INSERT INTO responses (point_id, sample_rate, sample_count, samples, sha256, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.pointId, sampleRate, samples.length, blob, sha, idempotencyKey, app.now());
  return { response: getResponse(app, Number(info.lastInsertRowid)), created: true };
}

export function getResponse(app: AppDb, id: number) {
  const r = app.db
    .prepare(
      `SELECT id, point_id AS pointId, sample_rate AS sampleRate, sample_count AS sampleCount,
              sha256, idempotency_key AS idempotencyKey, created_at AS createdAt
       FROM responses WHERE id = ?`,
    )
    .get(id);
  if (!r) throw new ApiError(404, "NOT_FOUND", `response ${id} not found`);
  return r;
}

export function getResponseSamples(app: AppDb, id: number): { sampleRate: number; samples: Float32Array } {
  const r = app.db.prepare("SELECT sample_rate AS sr, samples FROM responses WHERE id = ?").get(id) as
    | { sr: number; samples: Buffer }
    | undefined;
  if (!r) throw new ApiError(404, "NOT_FOUND", `response ${id} not found`);
  return { sampleRate: r.sr, samples: decodeSamples(r.samples) };
}

export function listResponses(app: AppDb, pointId: number, page: number, pageSize: number): Page<unknown> {
  getPoint(app, pointId);
  const total = (
    app.db.prepare("SELECT COUNT(*) AS c FROM responses WHERE point_id = ?").get(pointId) as { c: number }
  ).c;
  const items = app.db
    .prepare(
      `SELECT id, point_id AS pointId, sample_rate AS sampleRate, sample_count AS sampleCount,
              sha256, created_at AS createdAt
       FROM responses WHERE point_id = ? ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(pointId, pageSize, (page - 1) * pageSize);
  return { items, total, page, pageSize };
}

export function previewOnset(app: AppDb, responseId: number) {
  const { sampleRate, samples } = getResponseSamples(app, responseId);
  const index = detectOnset(samples);
  return { responseId, onsetIndex: index, onsetTimeSec: index / sampleRate, sampleRate };
}

export interface AnalyzeInput {
  onsetIndex?: unknown;
  noiseStart?: unknown;
  noiseEnd?: unknown;
  integrationEnd?: unknown;
}

function optIndex(v: unknown, name: string): number | null {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 0) {
    throw new ApiError(400, "VALIDATION_ERROR", `${name} must be a non-negative integer`);
  }
  return v as number;
}

// Manual onset/window changes create a NEW analysis (new param_version);
// raw samples are never modified.
export function runAnalysis(app: AppDb, responseId: number, input: AnalyzeInput) {
  const { sampleRate, samples } = getResponseSamples(app, responseId);
  const onsetIndex = optIndex(input.onsetIndex, "onsetIndex") ?? detectOnset(samples);
  const params: WindowParams = {
    onsetIndex,
    noiseStart: optIndex(input.noiseStart, "noiseStart"),
    noiseEnd: optIndex(input.noiseEnd, "noiseEnd"),
    integrationEnd: optIndex(input.integrationEnd, "integrationEnd"),
  };
  let results: AnalysisResult;
  try {
    results = analyze(samples, sampleRate, params);
  } catch (err) {
    if (err instanceof ValidationError) throw new ApiError(400, "VALIDATION_ERROR", err.message);
    throw err;
  }
  const storedParams = {
    band: "full",
    onsetIndex: params.onsetIndex,
    noiseStart: params.noiseStart ?? results.noiseWindow.start,
    noiseEnd: params.noiseEnd ?? results.noiseWindow.end,
    integrationEnd: params.integrationEnd ?? results.integrationEnd,
  };
  return app.transaction(() => {
    const v = (
      app.db
        .prepare("SELECT COALESCE(MAX(param_version), 0) + 1 AS v FROM analyses WHERE response_id = ?")
        .get(responseId) as { v: number }
    ).v;
    const info = app.db
      .prepare(
        `INSERT INTO analyses (response_id, param_version, params, results, frozen, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(responseId, v, JSON.stringify(storedParams), JSON.stringify(results), app.now());
    return getAnalysis(app, Number(info.lastInsertRowid));
  });
}

export function getAnalysis(app: AppDb, id: number) {
  const a = app.db
    .prepare(
      `SELECT id, response_id AS responseId, param_version AS paramVersion, params, results,
              frozen, created_at AS createdAt
       FROM analyses WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number;
        responseId: number;
        paramVersion: number;
        params: string;
        results: string;
        frozen: number;
        createdAt: string;
      }
    | undefined;
  if (!a) throw new ApiError(404, "NOT_FOUND", `analysis ${id} not found`);
  return {
    id: a.id,
    responseId: a.responseId,
    paramVersion: a.paramVersion,
    params: JSON.parse(a.params),
    results: JSON.parse(a.results) as AnalysisResult,
    frozen: a.frozen === 1,
    createdAt: a.createdAt,
  };
}

export function listAnalyses(app: AppDb, responseId: number, page: number, pageSize: number): Page<unknown> {
  getResponse(app, responseId);
  const total = (
    app.db.prepare("SELECT COUNT(*) AS c FROM analyses WHERE response_id = ?").get(responseId) as { c: number }
  ).c;
  const rows = app.db
    .prepare(
      `SELECT id, param_version AS paramVersion, params, frozen, created_at AS createdAt
       FROM analyses WHERE response_id = ? ORDER BY param_version LIMIT ? OFFSET ?`,
    )
    .all(responseId, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
  return {
    items: rows.map((r) => ({ ...r, params: JSON.parse(r.params as string), frozen: r.frozen === 1 })),
    total,
    page,
    pageSize,
  };
}

function latestAnalysisForPoint(app: AppDb, pointId: number) {
  const row = app.db
    .prepare(
      `SELECT a.id FROM analyses a
       JOIN responses r ON r.id = a.response_id
       WHERE r.point_id = ? ORDER BY a.id DESC LIMIT 1`,
    )
    .get(pointId) as { id: number } | undefined;
  return row ? getAnalysis(app, row.id) : null;
}

export function comparePoints(app: AppDb, pointIds: number[]) {
  const entries = pointIds.map((pid) => {
    const point = getPoint(app, pid);
    const analysis = latestAnalysisForPoint(app, pid);
    return { point, analysis: analysis ? summarizeAnalysis(analysis) : null };
  });
  return { points: entries };
}

export function summarizeAnalysis(a: ReturnType<typeof getAnalysis>) {
  const r = a.results;
  return {
    analysisId: a.id,
    responseId: a.responseId,
    paramVersion: a.paramVersion,
    createdAt: a.createdAt,
    flags: r.flags,
    edt: r.edt,
    t20: r.t20,
    t30: r.t30,
    c50: r.c50,
    c80: r.c80,
    d50: r.d50,
  };
}

export function decayTable(app: AppDb, analysisId: number, stepMs: number) {
  const a = getAnalysis(app, analysisId);
  const curve = a.results.decayCurve;
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "stepMs must be a positive number");
  }
  const stepSec = stepMs / 1000;
  const rows: Array<{ t: number; levelDb: number | null }> = [];
  let next = 0;
  for (const p of curve) {
    if (p.t >= next - 1e-12) {
      rows.push(p);
      next = p.t + stepSec;
    }
  }
  return { analysisId, stepMs, rows };
}

export function counts(app: AppDb) {
  const c = (t: string) => (app.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return { points: c("points"), responses: c("responses"), analyses: c("analyses") };
}
