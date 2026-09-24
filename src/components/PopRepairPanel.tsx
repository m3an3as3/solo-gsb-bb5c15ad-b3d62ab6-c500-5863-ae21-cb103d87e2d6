import type { PopEvent } from '../audio/popRepair';
import { formatTime } from '../utils/time';

interface PopRepairPanelProps {
  /** 当前音频声道数（用于声道标签：单 / L / R / CHn） */
  channelCount: number;
  /** 最近一次扫描结果；null 表示当前音频尚未扫描 */
  events: PopEvent[] | null;
  scanning: boolean;
  error: string | null;
  /** 勾选待修复的事件 id 集合 */
  checkedIds: ReadonlySet<string>;
  onToggleChecked: (id: string) => void;
  onSelectAll: (checked: boolean) => void;
  onScan: () => void;
  /** 在原始音频上试听该处附近片段（不改动任何数据） */
  onPreviewEvent: (ev: PopEvent) => void;
  hasResult: boolean;
  /** 修复结果已过期（勾选变化或重新扫描后尚未重新生成） */
  stale: boolean;
  auditioning: boolean;
  onRepair: () => void;
  onToggleAudition: () => void;
  onDownload: () => void;
}

/** 受影响声道的短标签：单声道显示「单」，双声道显示 L / R，其余按序号。 */
function channelLabel(ch: number, total: number): string {
  if (total === 1) return '单';
  if (total === 2) return ch === 0 ? 'L' : 'R';
  return `CH${ch + 1}`;
}

/**
 * 短促爆音修复面板：
 * - 扫描原始 PCM，按局部中位数 + MAD 找出 ≤5ms、两端回到邻域基线的
 *   孤立尖峰（持续鼓点不会入选）；跨声道同时间命中合并为一处展示；
 * - 列表显示时间与受影响声道，可逐处试听（原始音频）并勾选修复；
 * - 修复只在勾选区间的受影响声道内做两端插值，输出等长 / 同声道 /
 *   同采样率的新音频供试听与 WAV 下载；
 * - 改动勾选或换音频会使旧结果失效；原始缓冲与章节导出不受影响。
 */
export function PopRepairPanel(props: PopRepairPanelProps) {
  const { events, scanning, error } = props;
  const checkedCount = events ? events.filter((e) => props.checkedIds.has(e.id)).length : 0;
  const allChecked = events !== null && events.length > 0 && checkedCount === events.length;
  const totalChannels = Math.max(1, props.channelCount);

  return (
    <section className="silence-panel pop-panel">
      <h2>短促爆音修复</h2>
      <div className="silence-info">
        按声道扫描原始 PCM，用局部中位数与中位绝对偏差找出不超过 5ms、
        两端回到邻域基线的孤立尖峰；持续鼓点等长异常不会被列为爆音。
      </div>
      <button
        type="button"
        className="primary"
        disabled={scanning}
        onClick={props.onScan}
        title="在后台线程逐声道扫描整段录音"
      >
        {scanning
          ? '正在后台扫描…'
          : events === null
            ? '扫描爆音'
            : '重新扫描'}
      </button>
      {error && <div className="imp-error-text">{error}</div>}

      {events !== null && !scanning && (
        <>
          {events.length === 0 ? (
            <div className="silence-info">未发现短促爆音。</div>
          ) : (
            <>
              <label className="pop-checkall">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => props.onSelectAll(e.target.checked)}
                />
                全选（{checkedCount}/{events.length} 处勾选）
              </label>
              <div className="pop-list">
                {events.map((ev) => {
                  const checked = props.checkedIds.has(ev.id);
                  return (
                    <div
                      key={ev.id}
                      className={`pop-row${checked ? ' pop-row-checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => props.onToggleChecked(ev.id)}
                        title="勾选后该处在生成修复音频时用两端正常采样插值"
                      />
                      <button
                        type="button"
                        className="pop-preview"
                        onClick={() => props.onPreviewEvent(ev)}
                        title="从该处前 0.2s 起试听原始音频（约 0.7s）"
                      >
                        ▶
                      </button>
                      <span className="pop-time">
                        {formatTime(ev.start)}
                        <span className="pop-dur">
                          {' '}
                          · {((ev.end - ev.start) * 1000).toFixed(1)}ms
                        </span>
                      </span>
                      <span className="pop-channels" title="受影响声道（修复只作用于这些声道）">
                        {ev.channels.map((ch) => (
                          <span key={ch} className="pop-channel-tag">
                            {channelLabel(ch, totalChannels)}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="silence-info">
                相邻异常采样已合并为一处；跨声道同时间命中合并展示。
                点击 ▶ 试听原始片段，勾选后生成修复音频。
              </div>
            </>
          )}

          <button
            type="button"
            className="primary"
            disabled={checkedCount === 0}
            onClick={props.onRepair}
            title="只在勾选区间的受影响声道内用两端正常采样插值，输出等长新音频"
          >
            生成修复音频{checkedCount > 0 ? `（${checkedCount} 处）` : ''}
          </button>

          <div className="mute-result">
            {!props.hasResult ? (
              <div className="silence-info">尚未生成修复结果。</div>
            ) : (
              <>
                <div className="mute-result-state">
                  {props.stale
                    ? '⚠ 勾选已变化，试听 / 下载为旧结果，请重新生成'
                    : '✓ 当前试听与下载来自同一修复结果'}
                </div>
                <div className="mute-result-actions">
                  <button type="button" onClick={props.onToggleAudition}>
                    {props.auditioning ? '⏹ 停止试听' : '▶ 试听修复后音频'}
                  </button>
                  <button
                    type="button"
                    onClick={props.onDownload}
                    title="下载完整音频的 16-bit PCM WAV（与试听同源，等长 / 同声道 / 同采样率）"
                  >
                    下载 WAV
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
