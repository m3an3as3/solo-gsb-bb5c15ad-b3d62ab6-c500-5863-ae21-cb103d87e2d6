import { useState } from 'react';
import type { MuteRegion } from '../audio/muting';
import { formatTime } from '../utils/time';

export interface MuteMergedRange {
  start: number;
  end: number;
}

interface MutePanelProps {
  playhead: number;
  duration: number;
  regions: MuteRegion[];
  /** merged (overlapping/touching) ranges in seconds, for the live summary */
  merged: MuteMergedRange[];
  error: string | null;
  hasResult: boolean;
  /** 处理结果已过期（标记被改动后尚未重新处理） */
  stale: boolean;
  auditioning: boolean;
  onAdd: (start: number, end: number) => void;
  onUpdate: (id: string, start: number, end: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onSeek: (t: number) => void;
  onProcess: () => void;
  onToggleAudition: () => void;
  onDownload: () => void;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : '0.000';
}

/**
 * 敏感片段消音面板：
 * - 用播放头记录消音区间的起 / 止点，也可直接输入秒数（≤0.001s）；
 * - 列出全部区间，可逐条修订秒数、跳转试听、删除，也可一键清空；
 * - 处理结果提供「试听处理后音频」与「下载 16-bit PCM WAV」，二者同源。
 * 载入新音频时由上层清空全部标记与处理结果。
 */
export function MutePanel(props: MutePanelProps) {
  const { playhead, duration, regions, merged } = props;
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const parsedStart = start.trim() === '' ? null : Number(start);
  const parsedEnd = end.trim() === '' ? null : Number(end);
  const ready =
    parsedStart !== null &&
    Number.isFinite(parsedStart) &&
    parsedEnd !== null &&
    Number.isFinite(parsedEnd) &&
    parsedEnd > parsedStart &&
    parsedStart < duration &&
    parsedEnd > 0;

  const submit = () => {
    if (parsedStart === null || parsedEnd === null) return;
    props.onAdd(parsedStart, parsedEnd);
    setStart('');
    setEnd('');
  };

  return (
    <section className="silence-panel mute-panel">
      <h2>敏感片段消音</h2>
      <div className="mute-playhead">
        <span className="mute-playhead-time" title="当前播放头位置">
          播放头 <b>{formatTime(playhead)}</b>
        </span>
        <button type="button" onClick={() => setStart(fmt(playhead))} title="把当前播放头记为消音起点">
          记为起点
        </button>
        <button type="button" onClick={() => setEnd(fmt(playhead))} title="把当前播放头记为消音终点">
          记为终点
        </button>
      </div>
      <div className="mute-inputs">
        <label>
          起点(s)
          <input
            type="number"
            min={0}
            step={0.001}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            placeholder={fmt(playhead)}
          />
        </label>
        <span className="mute-input-sep">→</span>
        <label>
          终点(s)
          <input
            type="number"
            min={0}
            step={0.001}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            placeholder={fmt(playhead)}
          />
        </label>
      </div>
      <div className="mute-add-row">
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={submit}
          title={ready ? '添加该消音区间' : '填写起、止秒数（或先记播放头），起点需早于终点'}
        >
          ＋ 添加消音区间
        </button>
        {regions.length > 0 && (
          <button type="button" className="danger" onClick={props.onClear}>
            全部清除
          </button>
        )}
      </div>
      {props.error && <div className="imp-error-text">{props.error}</div>}
      <div className="mute-list">
        {regions.length === 0 ? (
          <div className="silence-info">
            尚无消音区间：移动播放头后点「记为起点 / 终点」，或直接输入秒数。
          </div>
        ) : (
          regions
            .slice()
            .sort((a, b) => a.start - b.start || a.end - b.end)
            .map((r) => (
              <MuteRow
                key={r.id}
                region={r}
                duration={duration}
                onUpdate={props.onUpdate}
                onRemove={props.onRemove}
                onSeek={props.onSeek}
              />
            ))
        )}
      </div>
      <div className="silence-info">
        {regions.length > 0
          ? `${regions.length} 个标记 · 合并后 ${merged.length} 段消音（重叠 / 相接自动合并，边界各带 ≤20ms 衰减 / 恢复包络）`
          : '处理时区间先裁剪到音频范围，按采样帧合并，起止带 ≤20ms 包络，总时长 / 声道 / 采样率不变。'}
      </div>

      <button
        type="button"
        className="primary"
        disabled={regions.length === 0}
        onClick={props.onProcess}
        title="按当前标记生成消音后的完整音频"
      >
        生成消音音频
      </button>

      <div className="mute-result">
        {!props.hasResult ? (
          <div className="silence-info">尚未生成处理结果。</div>
        ) : (
          <>
            <div className="mute-result-state">
              {props.stale ? '⚠ 标记已修改，试听 / 下载为旧结果，请重新生成' : '✓ 当前试听与下载来自同一处理结果'}
            </div>
            <div className="mute-result-actions">
              <button type="button" onClick={props.onToggleAudition}>
                {props.auditioning ? '⏹ 停止试听' : '▶ 试听处理后音频'}
              </button>
              <button type="button" onClick={props.onDownload} title="下载完整音频的 16-bit PCM WAV（与试听同源）">
                下载 WAV
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

interface MuteRowProps {
  region: MuteRegion;
  duration: number;
  onUpdate: (id: string, start: number, end: number) => void;
  onRemove: (id: string) => void;
  onSeek: (t: number) => void;
}

/** 单条消音区间：起止秒数可修订（失焦 / 回车提交），可跳转与删除。 */
function MuteRow({ region, duration, onUpdate, onRemove, onSeek }: MuteRowProps) {
  const [s, setS] = useState(fmt(region.start));
  const [e, setE] = useState(fmt(region.end));

  const commit = () => {
    const ns = Number(s);
    const ne = Number(e);
    if (Number.isFinite(ns) && Number.isFinite(ne) && ne > ns && ns < duration && ne > 0) {
      onUpdate(region.id, ns, ne);
      setS(fmt(Math.min(Math.max(ns, 0), duration)));
      setE(fmt(Math.min(Math.max(ne, 0), duration)));
    } else {
      // 还原为最后一次有效值
      setS(fmt(region.start));
      setE(fmt(region.end));
    }
  };

  return (
    <div className="mute-row">
      <input
        type="number"
        min={0}
        step={0.001}
        value={s}
        onChange={(ev) => setS(ev.target.value)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
        }}
        title="起点秒（回车或移开焦点后生效，越界 / 倒置会还原）"
      />
      <span className="mute-input-sep">→</span>
      <input
        type="number"
        min={0}
        step={0.001}
        value={e}
        onChange={(ev) => setE(ev.target.value)}
        onBlur={commit}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
        }}
        title="终点秒（回车或移开焦点后生效，越界 / 倒置会还原）"
      />
      <span className="mute-row-len">{(region.end - region.start).toFixed(2)}s</span>
      <button type="button" title={`跳到 ${formatTime(region.start)}`} onClick={() => onSeek(region.start)}>
        ⤧
      </button>
      <button type="button" className="danger" title="删除该区间" onClick={() => onRemove(region.id)}>
        ✕
      </button>
    </div>
  );
}
