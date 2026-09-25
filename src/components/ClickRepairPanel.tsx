import { MAX_CLICK_SEC, type ClickEvent } from '../audio/clickRepair';
import { formatVttTime } from '../utils/time';

interface ClickRepairPanelProps {
  /** 最近一次扫描的命中；null 表示当前音频尚未扫描 */
  events: ClickEvent[] | null;
  scanning: boolean;
  error: string | null;
  /** 勾选待修复的爆音 id */
  checked: ReadonlySet<string>;
  numberOfChannels: number;
  hasResult: boolean;
  auditioning: boolean;
  onScan: () => void;
  onToggle: (id: string) => void;
  onToggleAll: (check: boolean) => void;
  onPreview: (ev: ClickEvent) => void;
  onRepair: () => void;
  onToggleAudition: () => void;
  onDownload: () => void;
}

/** 声道序号 → 展示名（单声道 / 左右 / 声道 N）。 */
function channelNames(indices: number[], total: number): string {
  if (total <= 1) return '单声道';
  if (total === 2) {
    return indices.map((i) => (i === 0 ? '左' : i === 1 ? '右' : `声道${i + 1}`)).join('、');
  }
  return indices.map((i) => `声道${i + 1}`).join('、');
}

/**
 * 短促爆音修复面板：
 * - 「扫描爆音」在后台线程按声道扫描原始 PCM，列出不超过 5ms、两端回到
 *   邻域基线的孤立尖峰（持续鼓点不会被列出）；
 * - 每条显示开始时间与受影响声道，可逐处试听（原始音频）并勾选；
 * - 「修复勾选爆音」只在勾选区间的受影响声道内用两端正常采样插值，生成
 *   等长、同声道、同采样率的新音频，试听与下载同源；
 * - 改动勾选或换音频会使旧结果失效（由上层清空）。
 */
export function ClickRepairPanel(props: ClickRepairPanelProps) {
  const { events, scanning, checked } = props;
  const checkedCount = events ? events.filter((e) => checked.has(e.id)).length : 0;
  const allChecked = events !== null && events.length > 0 && checkedCount === events.length;

  return (
    <section className="silence-panel click-panel">
      <h2>短促爆音修复</h2>
      <div className="silence-info">
        按声道扫描原始 PCM，用局部中位数与 MAD 识别不超过 {MAX_CLICK_SEC * 1000}ms、两端回到
        邻域基线的孤立尖峰；持续鼓点 / 音乐瞬态不会被列为爆音。
      </div>
      <button
        type="button"
        className="primary"
        onClick={props.onScan}
        disabled={scanning}
        title="在后台线程按声道扫描整段音频中的短促爆音"
      >
        {scanning ? '正在后台扫描…' : events ? '重新扫描爆音' : '扫描爆音'}
      </button>
      {props.error && <div className="imp-error-text">{props.error}</div>}
      {events !== null && !scanning && (
        <>
          {events.length === 0 ? (
            <div className="silence-info">未发现可疑爆音。</div>
          ) : (
            <>
              <div className="click-toolbar">
                <label className="click-select-all">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => props.onToggleAll(e.target.checked)}
                  />
                  全选
                </label>
                <span>
                  已勾选 {checkedCount} / {events.length} 处
                </span>
              </div>
              <div className="click-list">
                {events.map((ev, i) => (
                  <div key={ev.id} className="click-row">
                    <input
                      type="checkbox"
                      checked={checked.has(ev.id)}
                      onChange={() => props.onToggle(ev.id)}
                      title="勾选后纳入修复"
                    />
                    <span
                      className="click-time"
                      title={`${formatVttTime(ev.start)} → ${formatVttTime(ev.end)}`}
                    >
                      #{i + 1} {formatVttTime(ev.start)}
                    </span>
                    <span className="click-channels">
                      {channelNames(ev.channels, props.numberOfChannels)}
                    </span>
                    <span className="click-len">{((ev.end - ev.start) * 1000).toFixed(1)}ms</span>
                    <button
                      type="button"
                      onClick={() => props.onPreview(ev)}
                      title={`试听该处前后 0.6s（原始音频，从 ${formatVttTime(Math.max(0, ev.start - 0.6))} 起）`}
                    >
                      ▶
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="primary"
                disabled={checkedCount === 0}
                onClick={props.onRepair}
                title="只在勾选区间的受影响声道内，用区间两端正常采样线性插值"
              >
                修复勾选爆音（{checkedCount}）
              </button>
            </>
          )}
        </>
      )}
      <div className="mute-result">
        {!props.hasResult ? (
          <div className="silence-info">
            尚未生成修复结果；改动勾选或换音频会使旧结果失效。
          </div>
        ) : (
          <>
            <div className="mute-result-state">
              ✓ 当前试听与下载来自同一修复结果（等长、同声道、同采样率）
            </div>
            <div className="mute-result-actions">
              <button type="button" onClick={props.onToggleAudition}>
                {props.auditioning ? '⏹ 停止试听' : '▶ 试听修复后音频'}
              </button>
              <button
                type="button"
                onClick={props.onDownload}
                title="下载完整音频的 16-bit PCM WAV（与试听同源）"
              >
                下载 WAV
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
