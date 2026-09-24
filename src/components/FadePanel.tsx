import { MAX_FADE_SEC, fitFadeTimes, type FadeSettings } from '../audio/fade';

interface FadePanelProps {
  /** resolved settings for the selected chapter (defaults applied) */
  fade: FadeSettings;
  chapterDuration: number;
  onChange: (patch: Partial<FadeSettings>) => void;
}

/**
 * Per-chapter fade preview controls: a master switch plus independent
 * fade-in / fade-out durations (0..5s). The effective durations after
 * proportional compression into the chapter length are shown live.
 */
export function FadePanel({ fade, chapterDuration, onChange }: FadePanelProps) {
  const eff = fitFadeTimes(fade.fadeIn, fade.fadeOut, chapterDuration);
  return (
    <section className="silence-panel fade-panel">
      <h2>淡入淡出试听</h2>
      <label className="silence-toggle">
        <input
          type="checkbox"
          checked={fade.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        预览该章时应用淡入淡出
      </label>
      <label className="silence-field">
        <span>
          淡入时长 <b>{fade.fadeIn.toFixed(1)} s</b>
        </span>
        <input
          type="range"
          min={0}
          max={MAX_FADE_SEC}
          step={0.1}
          value={fade.fadeIn}
          disabled={!fade.enabled}
          onChange={(e) => onChange({ fadeIn: Number(e.target.value) })}
        />
      </label>
      <label className="silence-field">
        <span>
          淡出时长 <b>{fade.fadeOut.toFixed(1)} s</b>
        </span>
        <input
          type="range"
          min={0}
          max={MAX_FADE_SEC}
          step={0.1}
          value={fade.fadeOut}
          disabled={!fade.enabled}
          onChange={(e) => onChange({ fadeOut: Number(e.target.value) })}
        />
      </label>
      <div className="silence-info">
        {fade.enabled
          ? `本章 ${chapterDuration.toFixed(2)}s 内实际生效：淡入 ${eff.fadeIn.toFixed(2)}s · 淡出 ${eff.fadeOut.toFixed(2)}s`
          : '开启后按实际播放区间构建增益包络；关闭即恢复原始预览。'}
      </div>
    </section>
  );
}
