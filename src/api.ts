import http from "node:http";
import { openDb, type AppDb, type Clock, systemClock } from "./db.ts";
import * as store from "./store.ts";
import { ApiError } from "./store.ts";
import { ValidationError } from "./acoustics.ts";

export interface AppOptions {
  dbPath?: string;
  clock?: Clock;
  db?: AppDb;
}

export interface RunningApp {
  server: http.Server;
  port: number;
  db: AppDb;
  close: () => Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024 * 1024) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "body exceeds 256 MB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    send(res, err.status, { error: { code: err.code, message: err.message } });
  } else if (err instanceof ValidationError) {
    send(res, 400, { error: { code: "VALIDATION_ERROR", message: err.message } });
  } else {
    send(res, 500, { error: { code: "INTERNAL_ERROR", message: String(err) } });
  }
}

function idParam(parts: string[], idx: number, name: string): number {
  const v = Number(parts[idx]);
  if (!Number.isInteger(v) || v < 1) throw new ApiError(400, "VALIDATION_ERROR", `${name} must be a positive integer`);
  return v;
}

export async function createApp(opts: AppOptions = {}): Promise<RunningApp> {
  const db = opts.db ?? openDb(opts.dbPath ?? ":memory:", opts.clock ?? systemClock);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, counts: store.counts(db) });
      }

      if (method === "POST" && url.pathname === "/points") {
        const body = (await readBody(req)) as { alias?: unknown };
        return send(res, 201, store.createPoint(db, body.alias));
      }
      if (method === "GET" && url.pathname === "/points") {
        const { page, pageSize } = store.pageArgs(url.searchParams);
        return send(res, 200, store.listPoints(db, page, pageSize));
      }
      if (parts[0] === "points" && parts.length >= 2) {
        const pointId = idParam(parts, 1, "pointId");
        if (method === "GET" && parts.length === 2) return send(res, 200, store.getPoint(db, pointId));
        if (parts[2] === "responses" && method === "POST" && parts.length === 3) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const { response, created } = store.importResponse(db, {
            pointId,
            sampleRate: body.sampleRate,
            samples: body.samples,
            idempotencyKey: body.idempotencyKey,
          });
          return send(res, created ? 201 : 200, response);
        }
        if (parts[2] === "responses" && method === "GET" && parts.length === 3) {
          const { page, pageSize } = store.pageArgs(url.searchParams);
          return send(res, 200, store.listResponses(db, pointId, page, pageSize));
        }
      }

      if (parts[0] === "responses" && parts.length >= 2) {
        const responseId = idParam(parts, 1, "responseId");
        if (method === "GET" && parts.length === 2) return send(res, 200, store.getResponse(db, responseId));
        if (method === "GET" && parts[2] === "samples") {
          const { sampleRate, samples } = store.getResponseSamples(db, responseId);
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
          const limit = Math.min(samples.length - offset, Math.max(1, Number(url.searchParams.get("limit") ?? "10000") || 10000));
          return send(res, 200, {
            responseId,
            sampleRate,
            offset,
            count: limit,
            total: samples.length,
            samples: Array.from(samples.subarray(offset, offset + limit)),
          });
        }
        if (method === "POST" && parts[2] === "onset-preview") {
          return send(res, 200, store.previewOnset(db, responseId));
        }
        if (method === "POST" && parts[2] === "analyze") {
          const body = (await readBody(req)) as store.AnalyzeInput;
          return send(res, 201, store.runAnalysis(db, responseId, body));
        }
        if (method === "GET" && parts[2] === "analyses") {
          const { page, pageSize } = store.pageArgs(url.searchParams);
          return send(res, 200, store.listAnalyses(db, responseId, page, pageSize));
        }
      }

      if (parts[0] === "analyses" && parts.length >= 2) {
        const analysisId = idParam(parts, 1, "analysisId");
        if (method === "GET" && parts.length === 2) return send(res, 200, store.getAnalysis(db, analysisId));
        if (method === "GET" && parts[2] === "residuals") {
          const a = store.getAnalysis(db, analysisId);
          return send(res, 200, { analysisId, residuals: a.results.residuals });
        }
        if (method === "GET" && parts[2] === "decay-table") {
          const stepMs = Number(url.searchParams.get("stepMs") ?? "10");
          const table = store.decayTable(db, analysisId, stepMs);
          if (url.searchParams.get("format") === "csv") {
            const csv = ["t_sec,level_db", ...table.rows.map((r) => `${r.t},${r.levelDb ?? ""}`)].join("\n");
            res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
            return res.end(csv);
          }
          return send(res, 200, table);
        }
      }

      if (method === "GET" && url.pathname === "/compare") {
        const ids = (url.searchParams.get("pointIds") ?? "")
          .split(",")
          .filter(Boolean)
          .map(Number);
        if (ids.length < 2 || ids.some((i) => !Number.isInteger(i) || i < 1)) {
          throw new ApiError(400, "VALIDATION_ERROR", "pointIds must be a comma-separated list of >= 2 ids");
        }
        return send(res, 200, store.comparePoints(db, ids));
      }

      throw new ApiError(404, "NOT_FOUND", `no route for ${method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    db,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
