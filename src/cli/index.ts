#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/db.js";
import { ApiError, Repo } from "../db/repo.js";
import { previewOnset } from "../core/onset.js";
import { runAnalysis } from "../core/service.js";
import { AnalysisReport, FitEstimate } from "../core/acoustics.js";
import { getParams, latestVersion } from "../core/params.js";
import { generateIR } from "../core/generator.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const dbPath = resolve(projectRoot, "data", "acoustic.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const repo = new Repo(db);

function usage(): void {
  console.log(`acoustic CLI (full-band analysis)

Usage:
  point-add <alias> [note]
  point-list [page] [pageSize]
  synth-import <alias> <sampleRate> <t60Seconds> [preSilenceS] [seed] [idempotencyKey]
  import <alias> <jsonFile> [idempotencyKey]
  onset-preview <responseId> [thresholdDb]
  set-window <responseId> <onset> <noiseStart> <noiseEnd> <integrationEnd> [reason]
  windows <responseId>
  analyze <responseId> [windowId] [paramVersion]
  residuals <analysisId>
  compare <analysisIdA> <analysisIdB>
  export-decay <analysisId> <outCsv>
  show <analysisId>
  freeze <analysisId>
  versions
`);
}

function num(x: string | undefined, name: string): number {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new ApiError("BAD_CLI_ARG", `not a number: ${name}`);
  return n;
}

function fmtEst(e: FitEstimate): string {
  return e.value === null
    ? `UNESTIMABLE (${e.reason})`
    : `${e.value.toFixed(4)} s  [fit ${e.fitStartS?.toFixed(4)}..${e.fitEndS?.toFixed(
        4,
      )} s, slope ${e.slopeDbPerS?.toFixed(1)} dB/s, rmse ${e.rmseDb?.toFixed(3)}, r2 ${e.r2?.toFixed(4)}]`;
}

function printReport(r: AnalysisReport): void {
  console.log(`param version : ${r.paramVersion}`);
  console.log(`sample rate   : ${r.sampleRate} Hz`);
  console.log(
    `onset/noise/end: ${r.onsetSample} / [${r.noiseStart},${r.noiseEnd}) / ${r.integrationEnd}`,
  );
  console.log(
    `usable ${r.usableSamples} samples = ${r.durationS.toFixed(4)} s; dynamic range ${r.dynamicRangeDb.toFixed(1)} dB; noise/peak ${r.noiseToPeakDb.toFixed(1)} dB`,
  );
  console.log(`EDT : ${fmtEst(r.EDT)}`);
  console.log(`T20 : ${fmtEst(r.T20)}`);
  console.log(`T30 : ${fmtEst(r.T30)}`);
  console.log(
    `C50 ${r.C50 === null ? "UNDEFINED" : r.C50.toFixed(3) + " dB"}  ` +
      `C80 ${r.C80 === null ? "UNDEFINED" : r.C80.toFixed(3) + " dB"}  ` +
      `D50 ${r.D50 === null ? "UNDEFINED" : r.D50.toFixed(4)}`,
  );
  console.log(`flags: ${r.flags.length ? r.flags.join(", ") : "(none)"}`);
}

function loadReport(analysisId: number): AnalysisReport {
  return JSON.parse(repo.getAnalysis(analysisId).report_json) as AnalysisReport;
}

async function main(): Promise<void> {
  const [cmd, ...a] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "versions": {
        console.log(`latest: ${latestVersion()}`);
        for (const v of [latestVersion()]) console.log(JSON.stringify(getParams(v), null, 2));
        break;
      }
      case "point-add": {
        const p = repo.createPoint(a[0], a[1] ?? "");
        console.log(`created point #${p.id} alias=${p.alias}`);
        break;
      }
      case "point-list": {
        const page = repo.listPoints(num(a[0] ?? "1", "page"), num(a[1] ?? "20", "pageSize"));
        console.log(`points ${page.page}/${page.totalPages} total=${page.total}`);
        for (const p of page.items) console.log(`#${p.id} ${p.alias} ${p.note}`);
        break;
      }
      case "synth-import": {
        const alias = a[0];
        const sr = Math.round(num(a[1], "sampleRate"));
        const t60 = num(a[2], "t60");
        const pre = num(a[3] ?? "0", "preSilence");
        const seed = a[4] === undefined ? 12345 : parseInt(a[4], 10);
        const key = a[5] ?? `synth-${alias}-${sr}-${t60}-${pre}-${seed}`;
        const point =
          repo.findPointByAlias(alias) ?? repo.createPoint(alias, "synthetic");
        const { samples } = generateIR({
          sampleRate: sr,
          t1S: t60,
          preSilenceS: pre,
          durationS: pre + Math.min(3, t60 * 3) + 0.05,
          rng: (() => {
            let s = seed >>> 0;
            return () => {
              s = (s * 1664525 + 1013904223) >>> 0;
              return s / 4294967296;
            };
          })(),
        });
        const before = repo.listResponses(point.id, 1, 100).total;
        const r = repo.importResponse(point.id, sr, samples, key);
        console.log(
          `responses before=${before} after=${repo.listResponses(point.id, 1, 100).total} ` +
            `response #${r.id} samples=${r.sample_count} duplicated=${r.duplicated}`,
        );
        break;
      }
      case "import": {
        const alias = a[0];
        const file = a[1];
        const key = a[2];
        const point =
          repo.findPointByAlias(alias) ?? repo.createPoint(alias, "imported");
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
          sampleRate: number;
          samples: number[];
        };
        const before = repo.listResponses(point.id, 1, 100).total;
        const r = repo.importResponse(point.id, parsed.sampleRate, parsed.samples, key);
        console.log(
          `responses before=${before} after=${repo.listResponses(point.id, 1, 100).total} ` +
            `response #${r.id} samples=${r.sample_count} duplicated=${r.duplicated}`,
        );
        break;
      }
      case "onset-preview": {
        const rid = Math.round(num(a[0], "responseId"));
        const { samples, sampleRate } = repo.getResponseSamples(rid);
        const pv = previewOnset(samples, { thresholdDb: a[1] === undefined ? -20 : num(a[1], "db") });
        console.log(`response #${rid} N=${samples.length} sr=${sampleRate}`);
        console.log(
          `peak index=${pv.peakIndex} (${(pv.peakIndex / sampleRate).toFixed(4)} s) amp=${pv.peakAmplitude.toExponential(3)}`,
        );
        console.log(
          `suggested onset=${pv.thresholdIndex} (${(pv.thresholdIndex / sampleRate).toFixed(4)} s)`,
        );
        const maxMean = Math.max(...pv.buckets.map((b) => b.meanAbs), 1e-300);
        const bars = pv.buckets
          .map(
            (b) =>
              `${String(b.startSample).padStart(7)} |${"#".repeat(
                Math.round((b.meanAbs / maxMean) * 40),
              )}`,
          )
          .join("\n");
        console.log(bars);
        break;
      }
      case "set-window": {
        const rid = Math.round(num(a[0], "rid"));
        const w = {
          onset: Math.round(num(a[1], "onset")),
          noiseStart: Math.round(num(a[2], "noiseStart")),
          noiseEnd: Math.round(num(a[3], "noiseEnd")),
          integrationEnd: Math.round(num(a[4], "integrationEnd")),
        };
        const beforeCount = repo.listWindows(rid).length;
        const row = repo.setWindow(rid, w, a[5] ?? "");
        const afterCount = repo.listWindows(rid).length;
        console.log(
          `windows before=${beforeCount} after=${afterCount} -> new window #${row.id} (original samples untouched):`,
        );
        console.log(JSON.stringify(w));
        break;
      }
      case "windows": {
        for (const w of repo.listWindows(Math.round(num(a[0], "rid")))) {
          console.log(
            `#${w.id} onset=${w.onset} noise=[${w.noise_start},${w.noise_end}) end=${w.integration_end} reason="${w.revised_reason}"`,
          );
        }
        break;
      }
      case "analyze": {
        const rid = Math.round(num(a[0], "rid"));
        const wid = a[1] === undefined ? undefined : Math.round(num(a[1], "wid"));
        const ver = a[2] ?? latestVersion();
        const out = runAnalysis(repo, rid, wid, ver);
        console.log(
          `analysis #${out.analysisId} window=#${out.window.id} duplicated=${out.duplicated}`,
        );
        printReport(out.report);
        break;
      }
      case "show": {
        printReport(loadReport(Math.round(num(a[0], "id"))));
        break;
      }
      case "freeze": {
        const id = Math.round(num(a[0], "id"));
        repo.freezeAnalysis(id);
        console.log(`analysis #${id} frozen`);
        break;
      }
      case "residuals": {
        const id = Math.round(num(a[0], "id"));
        const r = loadReport(id);
        for (const name of ["EDT", "T20", "T30"] as const) {
          const e = r[name];
          if (e.value === null || e.slopeDbPerS === null) {
            console.log(`${name}: ${e.reason}`);
            continue;
          }
          const { tS, db } = r.schroeder;
          const i0 = tS.findIndex((t) => t >= (e.fitStartS as number) - 1e-12);
          const i1 = tS.findIndex((t) => t > (e.fitEndS as number) + 1e-12);
          const a0 = i0;
          const a1 = i1 === -1 ? tS.length : i1;
          const res: number[] = [];
          for (let i = a0; i < a1; i++) {
            res.push(db[i] - ((e.slopeDbPerS as number) * tS[i] + (e.interceptDb as number)));
          }
          const maxAbs = Math.max(...res.map(Math.abs));
          const mean = res.reduce((s, x) => s + x, 0) / res.length;
          console.log(
            `${name}: n=${res.length} rmse=${e.rmseDb?.toFixed(4)} dB maxAbs=${maxAbs.toFixed(4)} mean=${mean.toExponential(2)} r2=${e.r2?.toFixed(5)}`,
          );
        }
        break;
      }
      case "compare": {
        const A = loadReport(Math.round(num(a[0], "A")));
        const B = loadReport(Math.round(num(a[1], "B")));
        const row = (name: string, x: number | null, y: number | null, unit: string) =>
          console.log(
            `${name.padEnd(4)} ${x === null ? "   n/a   " : x.toFixed(4).padStart(9)}  ` +
              `${y === null ? "   n/a   " : y.toFixed(4).padStart(9)}  ` +
              `delta=${x === null || y === null ? "n/a" : (y - x).toFixed(4)} ${unit}`,
          );
        console.log("metric      A          B");
        row("EDT", A.EDT.value, B.EDT.value, "s");
        row("T20", A.T20.value, B.T20.value, "s");
        row("T30", A.T30.value, B.T30.value, "s");
        row("C50", A.C50, B.C50, "dB");
        row("C80", A.C80, B.C80, "dB");
        row("D50", A.D50 === null ? null : A.D50, B.D50, "");
        console.log(`flags A: ${A.flags.join(",") || "(none)"}`);
        console.log(`flags B: ${B.flags.join(",") || "(none)"}`);
        break;
      }
      case "export-decay": {
        const id = Math.round(num(a[0], "id"));
        const out = resolve(a[1]);
        const r = loadReport(id);
        const lines = ["index,t_seconds,schroeder_db"];
        r.schroeder.tS.forEach((t, i) => lines.push(`${i},${t.toFixed(8)},${r.schroeder.db[i].toFixed(6)}`));
        writeFileSync(out, lines.join("\n"), "utf8");
        console.log(`exported ${r.schroeder.tS.length} rows -> ${out}`);
        break;
      }
      default:
        usage();
        if (cmd) process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`error [${e.code}]: ${e.message}`);
      process.exitCode = 1;
    } else {
      throw e;
    }
  } finally {
    db.close();
  }
}

main();
