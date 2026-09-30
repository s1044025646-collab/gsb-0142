// Repeatable end-to-end demo: create points, synthesize IRs, analyze,
// compare, export a decay table. Uses its own db file under ./data.
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.ts";
import * as store from "../src/store.ts";
import { synthesize } from "../src/synth.ts";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "demo.db");
fs.rmSync(dbPath, { force: true });
fs.rmSync(dbPath + "-wal", { force: true });
fs.rmSync(dbPath + "-shm", { force: true });

const app = openDb(dbPath);
const status = (label: string, db = app) => {
  const c = store.counts(db);
  console.log(`[status:${label}] points=${c.points} responses=${c.responses} analyses=${c.analyses}`);
};

status("start");

const hall = store.createPoint(app, "demo-hall") as { id: number };
const room = store.createPoint(app, "demo-room") as { id: number };

const hallIr = synthesize({ type: "noisy-decay", t60: 1.8, noiseSnrDb: 50, seed: 123, durationSec: 4 });
const roomIr = synthesize({ type: "decay", t60: 0.6, leadingSilenceSec: 0.15, seed: 456 });

const r1 = store.importResponse(app, { pointId: hall.id, ...hallIr, idempotencyKey: "demo-hall-ir" });
const r2 = store.importResponse(app, { pointId: room.id, ...roomIr, idempotencyKey: "demo-room-ir" });
console.log("imported responses:", (r1.response as { id: number }).id, (r2.response as { id: number }).id);

// Idempotent re-submit: same key, no new row.
const again = store.importResponse(app, { pointId: hall.id, ...hallIr, idempotencyKey: "demo-hall-ir" });
console.log("idempotent re-import created new row?", again.created);

const rid1 = (r1.response as { id: number }).id;
const rid2 = (r2.response as { id: number }).id;
console.log("onset preview:", store.previewOnset(app, rid1), store.previewOnset(app, rid2));

const a1 = store.runAnalysis(app, rid1, {});
const a2 = store.runAnalysis(app, rid2, {});
// Manual onset tweak -> new param version (raw samples untouched).
const a2b = store.runAnalysis(app, rid2, { onsetIndex: a2.results.onsetIndex + 5 });

status("after import + analyze");

const fmt = (label: string, a: ReturnType<typeof store.getAnalysis>) => {
  const r = a.results;
  const m = (x: { value: number | null }) => (x.value === null ? "  n/a" : x.value.toFixed(3));
  console.log(
    `${label}: EDT=${m(r.edt)} T20=${m(r.t20)} T30=${m(r.t30)} C50=${m(r.c50)} C80=${m(r.c80)} D50=${m(r.d50)}` +
      (r.flags.length ? ` flags=[${r.flags.join(",")}]` : ""),
  );
};
fmt("hall    ", a1);
fmt("room v1 ", a2);
fmt("room v2 ", a2b);

const cmp = store.comparePoints(app, [hall.id, room.id]);
console.log("\ncompare:");
for (const e of cmp.points) {
  const p = e.point as { alias: string };
  console.log(`  ${p.alias}: T30=${e.analysis?.t30.value?.toFixed(3) ?? "n/a"} C80=${e.analysis?.c80.value?.toFixed(2) ?? "n/a"}`);
}

const table = store.decayTable(app, a1.id, 20);
const csvPath = path.join(dataDir, "demo-decay-table.csv");
fs.writeFileSync(csvPath, ["t_sec,level_db", ...table.rows.map((r) => `${r.t},${r.levelDb ?? ""}`)].join("\n"));
console.log(`\ndecay table (${table.rows.length} rows) exported to ${csvPath}`);

app.close();

// Reopen to prove persistence.
const reopened = openDb(dbPath);
status("after restart", reopened);
console.log("persisted T30 for hall:", reopened ? store.getAnalysis(reopened, a1.id).results.t30.value : null);
reopened.close();
console.log("demo done.");
