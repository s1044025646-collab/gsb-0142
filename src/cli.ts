#!/usr/bin/env node
// CLI for the IR/reverb backend. All state lives in a local SQLite file.
import fs from "node:fs";
import path from "node:path";
import { openDb, type AppDb } from "./db.ts";
import * as store from "./store.ts";
import { synthesize, type SynthType } from "./synth.ts";
import { createApp } from "./api.ts";

const DEFAULT_DB = path.join(process.cwd(), "data", "ir-reverb.db");

function parseArgs(argv: string[]): { cmd: string; positional: string[]; opts: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, opts };
}

function num(v: string | boolean | undefined, name: string): number | undefined {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function showStatus(app: AppDb, label: string): void {
  const c = store.counts(app);
  console.log(`[status:${label}] points=${c.points} responses=${c.responses} analyses=${c.analyses}`);
}

function metricLine(name: string, m: { value: number | null; flags: string[] }): string {
  const v = m.value === null ? "n/a" : m.value.toFixed(4);
  const f = m.flags.length ? ` [${m.flags.join(",")}]` : "";
  return `  ${name.padEnd(4)} = ${v}${f}`;
}

function printAnalysisSummary(a: ReturnType<typeof store.getAnalysis>): void {
  const r = a.results;
  console.log(`analysis #${a.id} (response ${a.responseId}, paramVersion ${a.paramVersion}, frozen=${a.frozen})`);
  console.log(`  onset=${r.onsetIndex} integrationEnd=${r.integrationEnd} noise=[${r.noiseWindow.start},${r.noiseWindow.end})`);
  if (r.flags.length) console.log(`  flags: ${r.flags.join(", ")}`);
  console.log(metricLine("EDT", r.edt));
  console.log(metricLine("T20", r.t20));
  console.log(metricLine("T30", r.t30));
  console.log(metricLine("C50", r.c50));
  console.log(metricLine("C80", r.c80));
  console.log(metricLine("D50", r.d50));
}

const HELP = [
  "Usage: node src/cli.ts <command> [options]",
  "",
  "  serve [--db PATH]                          Start API on 127.0.0.1 (auto port)",
  "  add-point <alias> [--db PATH]              Create a measurement point",
  "  list-points [--db PATH]",
  "  synth <pointId> --type decay|two-stage|impulse|noisy-decay|zeros",
  "        [--t60 S] [--sr HZ] [--duration S] [--silence S] [--snr DB] [--seed N]",
  "        [--idempotency-key K] [--db PATH]    Generate + import a synthetic IR",
  "  import <pointId> <jsonFile> [--idempotency-key K] [--db PATH]",
  "        jsonFile: {\"sampleRate\": 16000, \"samples\": [...]}",
  "  preview-onset <responseId> [--db PATH]",
  "  analyze <responseId> [--onset N] [--noise-start N] [--noise-end N]",
  "        [--integration-end N] [--db PATH]    Creates a new param version",
  "  analyses <responseId> [--db PATH]",
  "  residuals <analysisId> [--db PATH]",
  "  compare <pointIdA> <pointIdB> [...] [--db PATH]",
  "  export-decay <analysisId> [--step-ms 10] [--out FILE] [--db PATH]",
  "  status [--db PATH]",
  "",
].join("\n");

async function main(): Promise<void> {
  const { cmd, positional, opts } = parseArgs(process.argv.slice(2));
  const dbPath = str(opts.db) ?? DEFAULT_DB;

  if (cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }

  if (cmd === "serve") {
    const app = await createApp({ dbPath });
    console.log(`API listening on http://127.0.0.1:${app.port} (db: ${dbPath})`);
    console.log("Press Ctrl+C to stop.");
    const shutdown = () => {
      app.close().then(() => {
        app.db.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const app = openDb(dbPath);
  try {
    switch (cmd) {
      case "status": {
        showStatus(app, "current");
        break;
      }
      case "add-point": {
        showStatus(app, "before");
        const p = store.createPoint(app, positional[0]);
        console.log(JSON.stringify(p));
        showStatus(app, "after");
        break;
      }
      case "list-points": {
        console.log(JSON.stringify(store.listPoints(app, 1, 200), null, 2));
        break;
      }
      case "synth": {
        const pointId = Number(positional[0]);
        showStatus(app, "before");
        const { sampleRate, samples } = synthesize({
          type: (str(opts.type) ?? "decay") as SynthType,
          t60: num(opts.t60, "t60"),
          sampleRate: num(opts.sr, "sr"),
          durationSec: num(opts.duration, "duration"),
          leadingSilenceSec: num(opts.silence, "silence"),
          noiseSnrDb: num(opts.snr, "snr"),
          seed: num(opts.seed, "seed"),
        });
        const { response, created } = store.importResponse(app, {
          pointId,
          sampleRate,
          samples,
          idempotencyKey: str(opts["idempotency-key"]) ?? null,
        });
        console.log(JSON.stringify({ created, response }));
        showStatus(app, "after");
        break;
      }
      case "import": {
        const pointId = Number(positional[0]);
        const file = positional[1];
        const payload = JSON.parse(fs.readFileSync(file, "utf8"));
        showStatus(app, "before");
        const { response, created } = store.importResponse(app, {
          pointId,
          sampleRate: payload.sampleRate,
          samples: payload.samples,
          idempotencyKey: str(opts["idempotency-key"]) ?? payload.idempotencyKey ?? null,
        });
        console.log(JSON.stringify({ created, response }));
        showStatus(app, "after");
        break;
      }
      case "preview-onset": {
        console.log(JSON.stringify(store.previewOnset(app, Number(positional[0]))));
        break;
      }
      case "analyze": {
        showStatus(app, "before");
        const a = store.runAnalysis(app, Number(positional[0]), {
          onsetIndex: num(opts.onset, "onset"),
          noiseStart: num(opts["noise-start"], "noise-start"),
          noiseEnd: num(opts["noise-end"], "noise-end"),
          integrationEnd: num(opts["integration-end"], "integration-end"),
        });
        printAnalysisSummary(a);
        showStatus(app, "after");
        break;
      }
      case "analyses": {
        console.log(JSON.stringify(store.listAnalyses(app, Number(positional[0]), 1, 200), null, 2));
        break;
      }
      case "residuals": {
        const a = store.getAnalysis(app, Number(positional[0]));
        for (const r of a.results.residuals) {
          console.log(`${r.t.toFixed(4)}\t${r.actualDb.toFixed(3)}\t${r.fittedDb.toFixed(3)}\t${r.residualDb.toFixed(3)}`);
        }
        break;
      }
      case "compare": {
        const ids = positional.map(Number);
        const out = store.comparePoints(app, ids);
        for (const entry of out.points) {
          const p = entry.point as { id: number; alias: string };
          console.log(`point #${p.id} '${p.alias}'`);
          if (entry.analysis) {
            const a = entry.analysis;
            console.log(metricLine("EDT", a.edt));
            console.log(metricLine("T20", a.t20));
            console.log(metricLine("T30", a.t30));
            console.log(metricLine("C50", a.c50));
            console.log(metricLine("C80", a.c80));
            console.log(metricLine("D50", a.d50));
          } else {
            console.log("  (no analysis yet)");
          }
        }
        break;
      }
      case "export-decay": {
        const table = store.decayTable(app, Number(positional[0]), num(opts["step-ms"], "step-ms") ?? 10);
        const csv = ["t_sec,level_db", ...table.rows.map((r) => `${r.t},${r.levelDb ?? ""}`)].join("\n");
        const out = str(opts.out);
        if (out) {
          fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
          fs.writeFileSync(out, csv);
          console.log(`wrote ${table.rows.length} rows to ${out}`);
        } else {
          console.log(csv);
        }
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
