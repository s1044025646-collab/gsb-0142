import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/db.js";
import { Repo } from "../db/repo.js";
import { buildApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const dbPath = resolve(projectRoot, "data", "acoustic.sqlite");
const portFile = resolve(projectRoot, "tmp", "server.port");

mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(dirname(portFile), { recursive: true });

const db = openDb(dbPath);
const repo = new Repo(db);
const { handler } = buildApp(repo);
const server = createServer(handler);

// Bind to loopback only. Port 0 => OS assigns an ephemeral (auto) port.
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  writeFileSync(portFile, String(port), "utf8");
  console.log(`acoustic API listening on http://127.0.0.1:${port}`);
  console.log(`db: ${dbPath}`);
  console.log(`port file: ${portFile}`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
