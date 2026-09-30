import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function openDb(dbPath: string, clock: Clock = systemClock): AppDb {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const app = new AppDb(db, clock);
  app.migrate();
  return app;
}

export class AppDb {
  db: DatabaseSync;
  clock: Clock;

  constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  now(): string {
    return this.clock().toISOString();
  }

  // Idempotent migrations: safe to run any number of times.
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
      .get() as { v: number };
    const migrations: string[] = [
      `
      CREATE TABLE IF NOT EXISTS points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        point_id INTEGER NOT NULL REFERENCES points(id),
        sample_rate REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        samples BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id INTEGER NOT NULL REFERENCES responses(id),
        param_version INTEGER NOT NULL,
        params TEXT NOT NULL,
        results TEXT NOT NULL,
        frozen INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(response_id, param_version)
      );
      `,
    ];
    for (let v = row.v + 1; v <= migrations.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(migrations[v - 1]);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(v, this.now());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
