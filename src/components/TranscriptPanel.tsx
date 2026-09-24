import type { Chapter } from '../types';
import type { ChapterCoverage, TranscriptCue } from '../utils/transcriptCoverage';
import { formatTime } from '../utils/time';

/** A clipped transcript currently loaded for coverage checking. */
export interface LoadedTranscript {
  fileName: string;
  /** cues already clipped to [0, duration] and start-sorted */
  cues: TranscriptCue[];
  /** cues the parser had to skip (bad timing / zero length) */
  parseSkipped: number;
  /** parseable cues dropped because clipping left no part inside the audio */
  outOfRange: number;
}

interface TranscriptPanelProps {
  transcript: LoadedTranscript | null;
  parseError: string | null;
  duration: number;
  /** seconds of the whole audio covered by the merged cue union */
  totalCoveredSeconds: number;
  chapterCount: number;
  selected: Chapter | null;
  selectedCoverage: ChapterCoverage | null;
  onPickFile: () => void;
  onRemove: () => void;
  /** click a cue: seek to its (chapter-clipped) start and play for listening */
  onPreviewAt: (t: number) => void;
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function barClass(ratio: number): string {
  if (ratio >= 0.9) return 'cov-high';
  if (ratio >= 0.5) return 'cov-mid';
  return 'cov-low';
}

/**
 * Transcript coverage panel: load a local WebVTT transcript (cues are used
 * for coverage checking ONLY — they never become chapters), shows the
 * merged union coverage of the whole file and, for the selected chapter,
 * every intersecting cue. Clicking a cue seeks to its start and plays.
 * Coverage is recomputed upstream (useMemo) whenever chapter boundaries
 * change, so the numbers here update live while dragging.
 */
export function TranscriptPanel(props: TranscriptPanelProps) {
  const { transcript, parseError, duration, totalCoveredSeconds, chapterCount } = props;
  const overall = duration > 0 ? Math.min(1, totalCoveredSeconds / duration) : 0;
  const sc = props.selectedCoverage;

  return (
    <section className="silence-panel transcript-panel">
      <h2>逐字稿覆盖核对</h2>
      {!transcript ? (
        <>
          <p className="transcript-hint">
            载入本地 WebVTT 逐字稿，按字幕与章节的时间交集核对每章文字覆盖；字幕仅用于核对，
            <b>不会作为章节导入</b>，跨章节的字幕按相交部分分别计入两章。
          </p>
          <button className="primary" onClick={props.onPickFile}>
            载入 WebVTT 逐字稿
          </button>
          {parseError && <div className="imp-error-text">{parseError}</div>}
        </>
      ) : (
        <>
          <div className="transcript-head">
            <span className="transcript-name" title={transcript.fileName}>
              📄 {transcript.fileName}
            </span>
            <button className="danger transcript-remove" onClick={props.onRemove} title="移除当前逐字稿">
              移除
            </button>
          </div>
          <div className="silence-info">
            {transcript.cues.length} 条字幕参与核对
            {(transcript.parseSkipped > 0 || transcript.outOfRange > 0) &&
              `（跳过 ${transcript.parseSkipped} 条无法解析，${transcript.outOfRange} 条越界裁剪后无剩余）`}
          </div>
          <div className="coverage-line" title={`合并重叠字幕后，全片有文字的秒数：${totalCoveredSeconds.toFixed(1)} / ${duration.toFixed(1)} s`}>
            <span>全片覆盖</span>
            <span className="coverage-track">
              <span className={`coverage-fill ${barClass(overall)}`} style={{ width: `${overall * 100}%` }} />
            </span>
            <b>{pct(overall)}</b>
          </div>

          <div className="transcript-chapter">
            {props.selected ? (
              <>
                <div className="transcript-subtitle">
                  「{props.selected.title || '未命名'}」的相交字幕
                </div>
                {sc && (
                  <div className="coverage-line" title={`该章有文字覆盖的秒数：${sc.coveredSeconds.toFixed(1)} / ${(props.selected.end - props.selected.start).toFixed(1)} s`}>
                    <span>本章覆盖</span>
                    <span className="coverage-track">
                      <span className={`coverage-fill ${barClass(sc.ratio)}`} style={{ width: `${sc.ratio * 100}%` }} />
                    </span>
                    <b>
                      {pct(sc.ratio)}（{sc.coveredSeconds.toFixed(1)}s）
                    </b>
                  </div>
                )}
                <div className="cov-cue-list">
                  {sc && sc.cues.length > 0 ? (
                    sc.cues.map((o) => (
                      <button
                        key={`${o.cue.id}-${o.start.toFixed(3)}`}
                        className="cov-cue"
                        onClick={() => props.onPreviewAt(o.start)}
                        title={`跳转到 ${formatTime(o.start)} 试听（字幕与本章相交部分 ${formatTime(o.start)} → ${formatTime(o.end)}）`}
                      >
                        <span className="cov-cue-time">
                          {formatTime(o.start)} → {formatTime(o.end)}
                        </span>
                        <span className="cov-cue-text">{o.cue.text || '（无文本）'}</span>
                      </button>
                    ))
                  ) : (
                    <div className="silence-info">该章没有相交的字幕。</div>
                  )}
                </div>
              </>
            ) : (
              <div className="silence-info">
                {chapterCount === 0
                  ? '先在波形上创建（或导入）章节，再核对覆盖率。'
                  : '点击左侧章节，查看其覆盖率与相交字幕（点击字幕可跳到该时间试听）。'}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
