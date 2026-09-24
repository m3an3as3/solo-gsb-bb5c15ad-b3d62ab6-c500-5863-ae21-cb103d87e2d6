/**
 * Local chapter-file import: parse JSON exported by this tool or a standard
 * WebVTT file, validate every cue against the current audio duration and the
 * existing chapters, then merge the accepted entries as a single step.
 *
 * Pure functions (no DOM, no React) — covered by scripts/test-importChapters.ts.
 */
import type { Chapter } from '../types';
import { MIN_CHAPTER_DURATION } from './chapterOps';
import { uid } from './time';

export type ImportStatus = 'valid' | 'invalid' | 'out-of-bounds' | 'overlap';

export interface ParseResult {
  format: 'vtt' | 'json';
  /** Cues whose timing could be parsed. Unparseable rows carry `error`. */
  entries: ImportCandidate[];
}

/** A parse-time failure is kept as a row so the preview can list it. */
export interface ImportCandidate {
  row: number;
  title: string;
  start: number;
  end: number;
  /** Set when the row itself was unparseable (bad timecode / malformed JSON row). */
  error?: string;
}

export interface ImportPreview {
  format: 'vtt' | 'json';
  entries: PreviewEntry[];
  counts: {
    total: number;
    valid: number;
    invalid: number;
    outOfBounds: number;
    overlap: number;
  };
}

export interface PreviewEntry extends ImportCandidate {
  status: ImportStatus;
  /** Human-readable reason(s); one entry may fail several checks. */
  reasons: string[];
}

const EPS = 1e-6;

/**
 * Parse a WebVTT timestamp token: `HH:MM:SS.mmm` / `MM:SS.mmm`, fraction
 * separated by '.' or ',' with 1–3 digits. Seconds 00–59 (WebVTT rule);
 * hours/minutes may exceed their nominal field width.
 */
export function parseVttTimestamp(token: string): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(token.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  if (min >= 60 || s >= 60) return null;
  const value = h * 3600 + min * 60 + s + frac;
  if (!Number.isFinite(value)) return null;
  return round3(value);
}

function cleanVttTitle(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Parse standard WebVTT content. NOTE/STYLE/REGION blocks and the file header
 * are skipped; cue settings after the arrow are tolerated. Rows with no
 * timing line (e.g. a dangling cue id) are ignored. A bad timing line is kept
 * as an `invalid` candidate so the preview can point at it.
 */
export function parseWebVTT(text: string): ParseResult {
  const entries: ImportCandidate[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  let rowOffset = 0;
  for (const raw of blocks) {
    const lines = raw.split('\n');
    const startRow = rowOffset + 1;
    rowOffset += lines.length + 1; // +1 for the blank separator
    if (lines.length === 0 || lines.every((l) => l.trim() === '')) continue;
    if (/^(?:\uFEFF)?WEBVTT/.test(lines[0])) continue;
    const tag = lines[0].trim().toUpperCase();
    if (tag === 'NOTE' || tag === 'STYLE' || tag === 'REGION') continue;

    // timing line is the first line containing '-->' (an optional cue id may precede it)
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx < 0) continue;
    const timing = lines[timingIdx];
    const beforeArrow = timing.split('-->')[0]?.trim() ?? '';
    const afterArrow = timing.split('-->')[1] ?? '';
    // cue settings follow the end timestamp; the first whitespace-delimited token is it
    const endToken = afterArrow.trim().split(/[\t ]/)[0] ?? '';
    const start = parseVttTimestamp(beforeArrow);
    const end = parseVttTimestamp(endToken);
    const row = startRow + timingIdx;
    if (start === null || end === null) {
      entries.push({
        row,
        title: '',
        start: Number.NaN,
        end: Number.NaN,
        error: '时间码无法解析（应为 HH:MM:SS.mmm --> HH:MM:SS.mmm）',
      });
      continue;
    }
    const title = cleanVttTitle(lines.slice(timingIdx + 1).join(' '));
    entries.push({ row, title, start, end });
  }
  return { format: 'vtt', entries };
}

function parseTimeValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? round3(v) : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? round3(n) : parseVttTimestamp(v);
  }
  return null;
}

/**
 * Parse the JSON format exported by this tool:
 * `{ version, chapters: [{ title, start, end, ... }] }`. A top-level array
 * of chapter objects is accepted as well. Rows with missing/non-numeric
 * timing become `invalid` candidates rather than failing the whole file.
 */
export function parseJSONChapters(text: string): ParseResult {
  const entries: ImportCandidate[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : '文件不是合法 JSON'}`);
  }
  let rows: unknown[];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === 'object' && Array.isArray((data as { chapters?: unknown }).chapters)) {
    rows = (data as { chapters: unknown[] }).chapters;
  } else {
    throw new Error('JSON 结构不被识别：需要包含 chapters 数组的对象，或章节对象数组。');
  }
  rows.forEach((item, i) => {
    const row = i + 1;
    if (!item || typeof item !== 'object') {
      entries.push({ row, title: '', start: Number.NaN, end: Number.NaN, error: '条目不是对象' });
      return;
    }
    const o = item as { title?: unknown; start?: unknown; end?: unknown };
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const start = parseTimeValue(o.start);
    const end = parseTimeValue(o.end);
    if (start === null || end === null) {
      entries.push({
        row,
        title,
        start: start ?? Number.NaN,
        end: end ?? Number.NaN,
        error: '缺少合法的 start / end 秒数',
      });
      return;
    }
    entries.push({ row, title, start, end });
  });
  return { format: 'json', entries };
}

/** Detect the format by content (WEBVTT signature wins) and parse it. */
export function parseChapterFile(text: string): ParseResult {
  if (text.trim() === '') throw new Error('文件为空。');
  if (/^(?:\uFEFF)?WEBVTT/.test(text)) return parseWebVTT(text);
  return parseJSONChapters(text);
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS;
}

/**
 * Validate parsed cues against the audio duration and the existing chapters.
 * Entries are examined in file order; a cue is `valid` only when it is a
 * positive-length interval inside [0, duration] and overlaps neither an
 * existing chapter nor an earlier accepted (valid) cue. Earlier-vs-later
 * overlap is therefore blamed on the later cue, which also guarantees the
 * valid set is pairwise non-overlapping.
 */
export function buildImportPreview(
  parsed: ParseResult,
  existing: Chapter[],
  duration: number,
): ImportPreview {
  const accepted: { start: number; end: number }[] = [];
  const entries: PreviewEntry[] = parsed.entries.map((e) => {
    const reasons: string[] = [];
    let status: ImportStatus = 'valid';

    if (e.error) {
      reasons.push(e.error);
      status = 'invalid';
    }
    if (!e.error && (e.end - e.start < -EPS)) {
      reasons.push('结束时间早于开始时间');
      status = 'invalid';
    }
    if (!e.error && Math.abs(e.end - e.start) <= EPS) {
      reasons.push('时长为 0');
      status = 'invalid';
    }
    if (
      !e.error &&
      e.end - e.start > EPS &&
      e.end - e.start + EPS < MIN_CHAPTER_DURATION
    ) {
      reasons.push(`短于最小章节时长 ${MIN_CHAPTER_DURATION}s`);
      status = 'invalid';
    }

    if (status === 'valid') {
      if (e.start < -EPS) reasons.push(`开始时间早于音频起点（${e.start.toFixed(3)}s）`);
      if (e.end > duration + EPS) {
        reasons.push(`结束时间超出音频时长（${e.end.toFixed(3)}s > ${duration.toFixed(3)}s）`);
      }
      if (e.start > duration + EPS) {
        reasons.push(`开始时间超出音频时长（${e.start.toFixed(3)}s > ${duration.toFixed(3)}s）`);
      }
      if (reasons.length > 0) status = 'out-of-bounds';
    }

    if (status === 'valid') {
      for (const c of existing) {
        if (overlaps(e, c)) {
          reasons.push(`与现有章节「${c.title.trim() || '未命名'}」重叠`);
          break;
        }
      }
      if (reasons.length === 0) {
        for (const a of accepted) {
          if (overlaps(e, a)) {
            reasons.push('与文件中较早的导入条目重叠');
            break;
          }
        }
      }
      if (reasons.length > 0) status = 'overlap';
    }

    if (status === 'valid' && e.title === '') {
      // not a failure: note the fallback the app will use
      reasons.push('标题为空，应用时按序号补全');
    }

    if (status === 'valid') accepted.push({ start: e.start, end: e.end });
    return { ...e, status, reasons };
  });

  const counts = {
    total: entries.length,
    valid: 0,
    invalid: 0,
    outOfBounds: 0,
    overlap: 0,
  };
  for (const e of entries) {
    if (e.status === 'valid') counts.valid += 1;
    else if (e.status === 'invalid') counts.invalid += 1;
    else if (e.status === 'out-of-bounds') counts.outOfBounds += 1;
    else counts.overlap += 1;
  }
  return { format: parsed.format, entries, counts };
}

/**
 * Merge the `valid` preview entries with the existing chapters. Existing
 * chapters keep their ids; imported ids are freshly generated. The result is
 * sorted by start and re-checked as a whole — if any entry is invalid or the
 * set overlaps, the function throws and the caller must not write anything
 * (all-or-nothing). Empty imported titles are numbered after sorting.
 *
 * `selectedRows` optionally restricts the import to a subset of valid rows
 * (the preview dialog's checkboxes, keyed by `PreviewEntry.row`).
 */
export function applyImportedChapters(
  preview: ImportPreview,
  existing: Chapter[],
  duration: number,
  selectedRows?: ReadonlySet<number>,
): Chapter[] {
  const good = preview.entries.filter(
    (e) => e.status === 'valid' && (!selectedRows || selectedRows.has(e.row)),
  );
  const imported: Chapter[] = good.map((e) => ({
    id: uid(),
    title: e.title,
    start: e.start,
    end: e.end,
  }));
  const merged = [...existing, ...imported].sort((a, b) => a.start - b.start);

  for (const c of merged) {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end)) {
      throw new Error('导入失败：存在非法时间码，未写入任何更改。');
    }
    if (c.start < -EPS || c.end > duration + EPS || c.end - c.start + EPS < MIN_CHAPTER_DURATION) {
      throw new Error('导入失败：存在越界或过短条目，未写入任何更改。');
    }
  }
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].start < merged[i - 1].end - EPS) {
      throw new Error('导入失败：合并后章节重叠，未写入任何更改。');
    }
  }

  return merged.map((c, i) =>
    c.title.trim() === '' ? { ...c, title: `章节 ${i + 1}` } : c,
  );
}

function round3(v: number): number {
  return Number(v.toFixed(3));
}
