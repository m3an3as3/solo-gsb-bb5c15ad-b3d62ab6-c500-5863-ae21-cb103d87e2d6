import type { LoudnessStatus, LoudnessThresholds } from '../audio/loudness';

interface LoudnessPanelProps {
  thresholds: LoudnessThresholds;
  show: boolean;
  /** per-chapter QC statuses */
  statuses: LoudnessStatus[];
  available: boolean;
  onQuietDbChange: (v: number) => void;
  onLoudDbChange: (v: number) => void;
  onToggleShow: () => void;
}

/**
 * Chapter loudness QC controls. Threshold changes only re-run the
 * classification over cached window dBFS — the PCM is never re-decoded.
 */
export function LoudnessPanel(props: LoudnessPanelProps) {
  const { thresholds, show, statuses, available } = props;
  const quietCount = statuses.filter((s) => s === 'quiet').length;
  const loudCount = statuses.filter((s) => s === 'loud').length;
  const okCount = statuses.filter((s) => s === 'ok').length;

  return (
    <section className="silence-panel loudness-panel">
      <h2>章节音量一致性质检</h2>
      <label className="silence-toggle">
        <input type="checkbox" checked={show} onChange={props.onToggleShow} disabled={!available} />
        在波形上标记异常区间
      </label>
      <label className="silence-field">
        <span>
          过轻阈值 <b>{thresholds.quietDb} dBFS</b>
        </span>
        <input
          type="range"
          min={-70}
          max={-10}
          step={1}
          value={thresholds.quietDb}
          disabled={!available}
          onChange={(e) => props.onQuietDbChange(Number(e.target.value))}
        />
      </label>
      <label className="silence-field">
        <span>
          过响阈值 <b>{thresholds.loudDb} dBFS</b>
        </span>
        <input
          type="range"
          min={-60}
          max={0}
          step={1}
          value={thresholds.loudDb}
          disabled={!available}
          onChange={(e) => props.onLoudDbChange(Number(e.target.value))}
        />
      </label>
      <div className="loudness-legend">
        <span>
          <i className="dot dot-quiet" /> 过轻
        </span>
        <span>
          <i className="dot dot-loud" /> 过响
        </span>
      </div>
      {available ? (
        <div className="silence-info">
          {statuses.length === 0
            ? '尚无章节，质检指标在创建章节后显示。'
            : `${okCount} 章正常 · ${quietCount} 章过轻 · ${loudCount} 章过响（点击标记或列表状态可从该处预览）`}
        </div>
      ) : (
        <div className="silence-info">导入音频后自动分析（200ms 窗口，仅分析一次）。</div>
      )}
    </section>
  );
}
