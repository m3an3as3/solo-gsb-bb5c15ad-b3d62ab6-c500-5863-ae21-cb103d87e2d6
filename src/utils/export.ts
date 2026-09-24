import type { Chapter } from '../types';
import type { ChapterLoudness, LoudnessThresholds } from '../audio/loudness';
import { formatVttTime } from './time';

export function toWebVTT(chapters: Chapter[]): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const cues = sorted.map((c, i) => {
    const title = c.title.trim() || `Chapter ${i + 1}`;
    return `${i + 1}\n${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${title}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/** Finite dBFS rounded for export; -Infinity / NaN / null become JSON null. */
function db(v: number | null): number | null {
  return v !== null && Number.isFinite(v) ? Number(v.toFixed(1)) : null;
}

export interface JSONExportOptions {
  loudness?: Map<string, ChapterLoudness> | null;
  thresholds?: LoudnessThresholds | null;
}

export function toJSON(chapters: Chapter[], options: JSONExportOptions = {}): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const { loudness, thresholds } = options;
  const data = sorted.map((c, i) => {
    const base = {
      id: c.id,
      index: i + 1,
      title: c.title.trim() || `Chapter ${i + 1}`,
      start: Number(c.start.toFixed(3)),
      end: Number(c.end.toFixed(3)),
      duration: Number((c.end - c.start).toFixed(3)),
    };
    const q = loudness?.get(c.id);
    if (!q) return base;
    return {
      ...base,
      qualityControl: {
        status: q.status,
        meanDbfs: db(q.meanDbfs),
        minDbfs: db(q.minDbfs),
        maxDbfs: db(q.maxDbfs),
        dynamicRangeDb: Number(q.rangeDb.toFixed(1)),
        allSilent: q.allSilent,
        silentCoverage: Number(q.silentCoverage.toFixed(3)),
        quietSeconds: Number(q.quietCoverage.toFixed(3)),
        loudSeconds: Number(q.loudCoverage.toFixed(3)),
        analyzedSeconds: Number(q.analyzedDuration.toFixed(3)),
      },
    };
  });
  const qc =
    loudness && thresholds
      ? {
          windowSeconds: 0.2,
          quietThresholdDb: thresholds.quietDb,
          loudThresholdDb: thresholds.loudDb,
        }
      : undefined;
  return JSON.stringify({ version: 1, qualityControl: qc, chapters: data }, null, 2);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadFile(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: `${mime};charset=utf-8` }));
}
