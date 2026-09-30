import { IncomingMessage, ServerResponse } from "node:http";
import { Repo, ApiError } from "../db/repo.js";
import { runAnalysis } from "../core/service.js";
import { previewOnset } from "../core/onset.js";
import { getParams, latestVersion, listVersions } from "../core/params.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    m: RegExpExecArray,
    query: URLSearchParams,
  ) => unknown;
}

function parseIntQ(q: URLSearchParams, key: string, def: number): number {
  const v = q.get(key);
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError("INVALID_PAGINATION", `${key} must be a positive integer`);
  }
  return n;
}

function parseReport(id: number, repo: Repo) {
  const a = repo.getAnalysis(id);
  return { ...a, frozen: a.frozen === 1, report: JSON.parse(a.report_json) };
}

export function buildApp(repo: Repo) {
  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handler: () => ({ ok: true }),
    },
    {
      method: "GET",
      pattern: /^\/api\/param-versions$/,
      handler: () => ({ latest: latestVersion(), versions: listVersions() }),
    },
    {
      method: "GET",
      pattern: /^\/api\/param-versions\/([^/]+)$/,
      handler: (_r, _s, _b, m) => getParams(decodeURIComponent(m[1])),
    },
    {
      method: "POST",
      pattern: /^\/api\/points$/,
      handler: (_r, _s, body) => {
        const b = body as { alias?: unknown; note?: unknown };
        return repo.createPoint(String(b.alias ?? ""), b.note === undefined ? "" : String(b.note));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/points$/,
      handler: (_r, _s, _b, _m, q) =>
        repo.listPoints(parseIntQ(q, "page", 1), parseIntQ(q, "pageSize", 20)),
    },
    {
      method: "GET",
      pattern: /^\/api\/points\/(\d+)$/,
      handler: (_r, _s, _b, m) => repo.getPoint(Number(m[1])),
    },
    {
      method: "POST",
      pattern: /^\/api\/points\/(\d+)\/responses$/,
      handler: (_r, _s, body, m) => {
        const b = body as {
          sampleRate?: unknown;
          samples?: unknown;
          idempotencyKey?: unknown;
        };
        if (typeof b.sampleRate !== "number" || !Array.isArray(b.samples)) {
          throw new ApiError("INVALID_BODY", "sampleRate (number) and samples (number[]) required");
        }
        const key = b.idempotencyKey === undefined ? undefined : String(b.idempotencyKey);
        return repo.importResponse(
          Number(m[1]),
          b.sampleRate,
          b.samples as number[],
          key,
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/points\/(\d+)\/responses$/,
      handler: (_r, _s, _b, m, q) =>
        repo.listResponses(
          Number(m[1]),
          parseIntQ(q, "page", 1),
          parseIntQ(q, "pageSize", 20),
        ),
    },
    {
      method: "GET",
      pattern: /^\/api\/responses\/(\d+)$/,
      handler: (_r, _s, _b, m) => repo.getResponse(Number(m[1])),
    },
    {
      method: "GET",
      pattern: /^\/api\/responses\/(\d+)\/onset-preview$/,
      handler: (_r, _s, _b, m, q) => {
        const id = Number(m[1]);
        const { samples } = repo.getResponseSamples(id);
        const thresholdDb = q.get("thresholdDb");
        return previewOnset(samples, {
          thresholdDb: thresholdDb === null ? undefined : Number(thresholdDb),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/responses\/(\d+)\/windows$/,
      handler: (_r, _s, body, m) => {
        const b = body as {
          onset?: unknown;
          noiseStart?: unknown;
          noiseEnd?: unknown;
          integrationEnd?: unknown;
          reason?: unknown;
        };
        const nums = [b.onset, b.noiseStart, b.noiseEnd, b.integrationEnd];
        if (!nums.every((x) => typeof x === "number")) {
          throw new ApiError(
            "INVALID_BODY",
            "onset, noiseStart, noiseEnd, integrationEnd (numbers) required",
          );
        }
        return repo.setWindow(
          Number(m[1]),
          {
            onset: b.onset as number,
            noiseStart: b.noiseStart as number,
            noiseEnd: b.noiseEnd as number,
            integrationEnd: b.integrationEnd as number,
          },
          b.reason === undefined ? "" : String(b.reason),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/responses\/(\d+)\/windows$/,
      handler: (_r, _s, _b, m) => repo.listWindows(Number(m[1])),
    },
    {
      method: "POST",
      pattern: /^\/api\/responses\/(\d+)\/analyses$/,
      handler: (_r, _s, body, m) => {
        const b = (body ?? {}) as { windowId?: unknown; paramVersion?: unknown };
        const out = runAnalysis(
          repo,
          Number(m[1]),
          b.windowId === undefined ? undefined : Number(b.windowId),
          b.paramVersion === undefined ? undefined : String(b.paramVersion),
        );
        return {
          analysisId: out.analysisId,
          duplicated: out.duplicated,
          windowId: out.window.id,
          report: out.report,
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/responses\/(\d+)\/analyses$/,
      handler: (_r, _s, _b, m, q) => {
        const page = repo.listAnalyses(
          Number(m[1]),
          parseIntQ(q, "page", 1),
          parseIntQ(q, "pageSize", 20),
        );
        return {
          ...page,
          items: page.items.map((a) => ({
            ...a,
            frozen: a.frozen === 1,
            report: JSON.parse(a.report_json),
          })),
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/analyses\/(\d+)$/,
      handler: (_r, _s, _b, m) => parseReport(Number(m[1]), repo),
    },
    {
      method: "POST",
      pattern: /^\/api\/analyses\/(\d+)\/freeze$/,
      handler: (_r, _s, _b, m) => parseReport(repo.freezeAnalysis(Number(m[1])).id, repo),
    },
  ];

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 100 * 1024 * 1024) {
        throw new ApiError("PAYLOAD_TOO_LARGE", "body exceeds 100 MiB", 413);
      }
      chunks.push(c as Buffer);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ApiError("INVALID_JSON", "request body must be valid JSON");
    }
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      let body: unknown = {};
      if (req.method === "POST") body = await readBody(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const mm = r.pattern.exec(u.pathname);
        if (!mm) continue;
        const data = await r.handler(req, res, body, mm, u.searchParams);
        if (!res.writableEnded) send(200, { data });
        return;
      }
      send(404, { error: { code: "NOT_FOUND", message: u.pathname } });
    } catch (e) {
      const coded = e as { code?: string; status?: number; message?: string };
      if (e instanceof ApiError || (coded && typeof coded.code === "string")) {
        send(coded.status ?? 400, {
          error: { code: coded.code, message: coded.message ?? "error" },
        });
      } else {
        send(500, {
          error: { code: "INTERNAL", message: (e as Error).message },
        });
      }
    }
  }

  return { handler };
}
