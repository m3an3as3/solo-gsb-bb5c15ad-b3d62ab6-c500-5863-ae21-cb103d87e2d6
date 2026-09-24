interface SilencePanelProps {
  thresholdDb: number;
  minSilenceSec: number;
  show: boolean;
  candidateCount: number;
  onThresholdDbChange: (v: number) => void;
  onMinSilenceSecChange: (v: number) => void;
  onToggleShow: () => void;
  onApplyAll: () => void;
}

/**
 * Silence-based split suggestions: tunable threshold + minimum silence
 * duration, live candidate count, and one-click apply of all candidates.
 */
export function SilencePanel(props: SilencePanelProps) {
  const { thresholdDb, minSilenceSec, show, candidateCount } = props;
  return (
    <section className="silence-panel">
      <h2>静音切分建议</h2>
      <label className="silence-toggle">
        <input type="checkbox" checked={show} onChange={props.onToggleShow} />
        在波形上预览候选边界
      </label>
      <label className="silence-field">
        <span>
          静音阈值 <b>{thresholdDb} dB</b>
        </span>
        <input
          type="range"
          min={-70}
          max={-20}
          step={1}
          value={thresholdDb}
          onChange={(e) => props.onThresholdDbChange(Number(e.target.value))}
        />
      </label>
      <label className="silence-field">
        <span>
          最短静音 <b>{minSilenceSec.toFixed(1)} s</b>
        </span>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={minSilenceSec}
          onChange={(e) => props.onMinSilenceSecChange(Number(e.target.value))}
        />
      </label>
      <div className="silence-info">
        {candidateCount > 0 ? `${candidateCount} 个候选边界` : '当前参数下没有候选边界'}
      </div>
      <button className="primary" disabled={candidateCount === 0} onClick={props.onApplyAll}>
        应用全部候选（保留已有章节）
      </button>
    </section>
  );
}
