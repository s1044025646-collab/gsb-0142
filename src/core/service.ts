import { Repo, WindowRow, ApiError } from "../db/repo.js";
import { analyze, AnalysisReport } from "./acoustics.js";
import { getParams, latestVersion } from "./params.js";

export function runAnalysis(
  repo: Repo,
  responseId: number,
  windowId?: number,
  paramVersion?: string,
): { report: AnalysisReport; analysisId: number; duplicated: boolean; window: WindowRow } {
  const version = paramVersion ?? latestVersion();
  getParams(version); // throws PARAM_VERSION_UNKNOWN
  const { samples, sampleRate } = repo.getResponseSamples(responseId);
  const win =
    windowId !== undefined
      ? repo.getWindow(windowId)
      : repo.latestWindow(responseId);
  if (!win) {
    throw new ApiError("WINDOW_NOT_SET", "set an analysis window before analyzing", 409);
  }
  if (win.response_id !== responseId) {
    throw new ApiError("WINDOW_MISMATCH", "window does not belong to response");
  }
  const params = getParams(version);
  const report = analyze({
    samples,
    sampleRate,
    window: {
      onset: win.onset,
      noiseStart: win.noise_start,
      noiseEnd: win.noise_end,
      integrationEnd: win.integration_end,
    },
    params,
  });
  const row = repo.upsertAnalysis(responseId, win.id, version, JSON.stringify(report));
  return {
    report,
    analysisId: row.id,
    duplicated: row.duplicated ?? false,
    window: win,
  };
}
