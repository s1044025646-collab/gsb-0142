import type { DatabaseSync } from "node:sqlite";
import {
  Clock,
  defaultClock,
  decodeSamples,
  encodeSamples,
  hashSamples,
  Page,
  paginate,
} from "./db.js";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isUnique(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return (
    err?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    /UNIQUE constraint failed/i.test(err?.message ?? "")
  );
}

export interface PointRow {
  id: number;
  alias: string;
  note: string;
  created_at_ms: number;
}

export interface ResponseRow {
  id: number;
  point_id: number;
  sample_rate: number;
  sample_count: number;
  sha256: string;
  idempotency_key: string | null;
  imported_at_ms: number;
}

export interface WindowRow {
  id: number;
  response_id: number;
  onset: number;
  noise_start: number;
  noise_end: number;
  integration_end: number;
  set_at_ms: number;
  revised_reason: string;
}

export interface AnalysisRow {
  id: number;
  response_id: number;
  window_id: number;
  param_version: string;
  report_json: string;
  frozen: number;
  created_at_ms: number;
}

export class Repo {
  constructor(
    private db: DatabaseSync,
    private clock: Clock = defaultClock,
  ) {}

  createPoint(alias: string, note = ""): PointRow {
    if (typeof alias !== "string" || !/^[A-Za-z0-9_.\-]{1,64}$/.test(alias)) {
      throw new ApiError("INVALID_ALIAS", "alias must be 1-64 chars [A-Za-z0-9_.-]");
    }
    try {
      const r = this.db
        .prepare("INSERT INTO points(alias,note,created_at_ms) VALUES(?,?,?)")
        .run(alias, note, this.clock.nowMs());
      return this.getPoint(Number(r.lastInsertRowid));
    } catch (e: unknown) {
      if (isUnique(e)) {
        throw new ApiError("ALIAS_EXISTS", `alias already exists: ${alias}`, 409);
      }
      throw e;
    }
  }

  getPoint(id: number): PointRow {
    const r = this.db.prepare("SELECT * FROM points WHERE id=?").get(id) as
      | PointRow
      | undefined;
    if (!r) throw new ApiError("POINT_NOT_FOUND", `point ${id} not found`, 404);
    return r;
  }

  findPointByAlias(alias: string): PointRow | undefined {
    return this.db.prepare("SELECT * FROM points WHERE alias=?").get(alias) as unknown as
      | PointRow
      | undefined;
  }

  listPoints(page: number, pageSize: number): Page<PointRow> {
    const rows = this.db.prepare("SELECT * FROM points ORDER BY id").all() as unknown as PointRow[];
    return paginate(rows, page, pageSize);
  }

  importResponse(
    pointId: number,
    sampleRate: number,
    samples: Float64Array | number[],
    idempotencyKey?: string,
  ): ResponseRow & { duplicated: boolean } {
    this.getPoint(pointId);
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 1_000_000) {
      throw new ApiError("INVALID_SAMPLE_RATE", "sampleRate must be an integer in [1,1e6]");
    }
    const arr = samples instanceof Float64Array ? samples : Float64Array.from(samples);
    if (arr.length < 1) throw new ApiError("EMPTY_SAMPLES", "samples must be non-empty");
    if (arr.length > 20_000_000) {
      throw new ApiError("TOO_MANY_SAMPLES", "sample count exceeds 20,000,000 limit");
    }
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) {
        throw new ApiError("NON_FINITE_SAMPLE", `sample[${i}] is not finite`);
      }
    }

    if (idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM responses WHERE point_id=? AND idempotency_key=?")
        .get(pointId, idempotencyKey) as ResponseRow | undefined;
      if (existing) return { ...existing, duplicated: true };
    }

    const blob = encodeSamples(arr);
    const sha = hashSamples(arr, sampleRate);
    try {
      const r = this.db
        .prepare(
          `INSERT INTO responses(point_id,sample_rate,sample_count,samples,sha256,
             idempotency_key,imported_at_ms) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          pointId,
          sampleRate,
          arr.length,
          blob,
          sha,
          idempotencyKey ?? null,
          this.clock.nowMs(),
        );
      return { ...this.getResponse(Number(r.lastInsertRowid)), duplicated: false };
    } catch (e: unknown) {
      if (isUnique(e)) {
        throw new ApiError("IDEMPOTENCY_CONFLICT", "duplicate idempotency key", 409);
      }
      throw e;
    }
  }

  getResponse(id: number): ResponseRow & { duplicated?: boolean } {
    const r = this.db.prepare("SELECT * FROM responses WHERE id=?").get(id) as unknown as
      | ResponseRow
      | undefined;
    if (!r) throw new ApiError("RESPONSE_NOT_FOUND", `response ${id} not found`, 404);
    return r;
  }

  getResponseSamples(id: number): { samples: Float64Array; sampleRate: number } {
    const r = this.db
      .prepare("SELECT samples,sample_rate FROM responses WHERE id=?")
      .get(id) as unknown as { samples: Buffer; sample_rate: number } | undefined;
    if (!r) throw new ApiError("RESPONSE_NOT_FOUND", `response ${id} not found`, 404);
    return { samples: decodeSamples(r.samples), sampleRate: r.sample_rate };
  }

  listResponses(pointId: number, page: number, pageSize: number): Page<ResponseRow> {
    this.getPoint(pointId);
    const rows = this.db
      .prepare(
        `SELECT id,point_id,sample_rate,sample_count,sha256,idempotency_key,
                imported_at_ms FROM responses WHERE point_id=? ORDER BY id`,
      )
      .all(pointId) as unknown as ResponseRow[];
    return paginate(rows, page, pageSize);
  }

  setWindow(
    responseId: number,
    w: { onset: number; noiseStart: number; noiseEnd: number; integrationEnd: number },
    reason = "",
  ): WindowRow {
    const resp = this.getResponse(responseId);
    const N = resp.sample_count;
    const ints = [w.onset, w.noiseStart, w.noiseEnd, w.integrationEnd];
    if (!ints.every(Number.isInteger)) {
      throw new ApiError("INVALID_WINDOW", "window bounds must be integers");
    }
    if (w.noiseStart < 0 || w.noiseEnd < w.noiseStart || w.noiseEnd > w.onset) {
      throw new ApiError(
        "INVALID_NOISE_WINDOW",
        "require 0 <= noiseStart <= noiseEnd <= onset (pre-onset only)",
      );
    }
    if (w.onset < 0 || w.onset >= N) {
      throw new ApiError("INVALID_ONSET", `onset must be in [0,${N - 1}]`);
    }
    if (w.integrationEnd <= w.onset || w.integrationEnd > N) {
      throw new ApiError("INVALID_INTEGRATION_END", `integrationEnd must be in (onset,${N}]`);
    }
    const r = this.db
      .prepare(
        `INSERT INTO windows(response_id,onset,noise_start,noise_end,integration_end,
           set_at_ms,revised_reason) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        responseId,
        w.onset,
        w.noiseStart,
        w.noiseEnd,
        w.integrationEnd,
        this.clock.nowMs(),
        reason,
      );
    return this.getWindow(Number(r.lastInsertRowid));
  }

  getWindow(id: number): WindowRow {
    const r = this.db.prepare("SELECT * FROM windows WHERE id=?").get(id) as unknown as
      | WindowRow
      | undefined;
    if (!r) throw new ApiError("WINDOW_NOT_FOUND", `window ${id} not found`, 404);
    return r;
  }

  latestWindow(responseId: number): WindowRow | undefined {
    return this.db
      .prepare("SELECT * FROM windows WHERE response_id=? ORDER BY id DESC LIMIT 1")
      .get(responseId) as unknown as WindowRow | undefined;
  }

  listWindows(responseId: number): WindowRow[] {
    return this.db
      .prepare("SELECT * FROM windows WHERE response_id=? ORDER BY id")
      .all(responseId) as unknown as WindowRow[];
  }

  upsertAnalysis(
    responseId: number,
    windowId: number,
    paramVersion: string,
    reportJson: string,
  ): AnalysisRow & { duplicated: boolean } {
    const existing = this.db
      .prepare(
        "SELECT * FROM analyses WHERE response_id=? AND window_id=? AND param_version=?",
      )
      .get(responseId, windowId, paramVersion) as unknown as AnalysisRow | undefined;
    if (existing) return { ...existing, duplicated: true };
    const r = this.db
      .prepare(
        `INSERT INTO analyses(response_id,window_id,param_version,report_json,frozen,
           created_at_ms) VALUES(?,?,?,?,0,?)`,
      )
      .run(responseId, windowId, paramVersion, reportJson, this.clock.nowMs());
    return { ...this.getAnalysis(Number(r.lastInsertRowid)), duplicated: false };
  }

  getAnalysis(id: number): AnalysisRow & { duplicated?: boolean } {
    const r = this.db.prepare("SELECT * FROM analyses WHERE id=?").get(id) as unknown as
      | AnalysisRow
      | undefined;
    if (!r) throw new ApiError("ANALYSIS_NOT_FOUND", `analysis ${id} not found`, 404);
    return r;
  }

  freezeAnalysis(id: number): AnalysisRow {
    this.getAnalysis(id);
    this.db.prepare("UPDATE analyses SET frozen=1 WHERE id=?").run(id);
    return this.getAnalysis(id);
  }

  listAnalyses(responseId: number, page: number, pageSize: number): Page<AnalysisRow> {
    const rows = this.db
      .prepare(
        `SELECT id,response_id,window_id,param_version,frozen,created_at_ms,
                report_json FROM analyses WHERE response_id=? ORDER BY id`,
      )
      .all(responseId) as unknown as AnalysisRow[];
    return paginate(rows, page, pageSize);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

