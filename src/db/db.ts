import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export interface Clock {
  nowMs(): number;
}

export const defaultClock: Clock = { nowMs: () => Date.now() };

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** Idempotent migrations: safe to run repeatedly on every startup. */
export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const row = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  db.exec("BEGIN");
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('version',?)").run(
        String(v + 1),
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  void SCHEMA_VERSION;
}

export function encodeSamples(samples: Float64Array | number[]): Buffer {
  const arr = samples instanceof Float64Array ? samples : Float64Array.from(samples);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function decodeSamples(blob: Buffer | Uint8Array): Float64Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float64Array(ab);
}

export function hashSamples(samples: Float64Array | number[], sampleRate: number): string {
  const h = createHash("sha256");
  h.update(encodeSamples(samples));
  h.update(`|${sampleRate}`);
  return h.digest("hex");
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(
  all: T[],
  page: number,
  pageSize: number,
): Page<T> {
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    page: p,
    pageSize,
    total,
    totalPages,
  };
}
