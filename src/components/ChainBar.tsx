import { type ChainEditResult, stopLabel } from '../utils/chainOps';

interface ChainBarProps {
  enabled: boolean
  lockedCount: number;
  chapterCount: number;
  /** 正在进行的拖拽/缩放结果（含连带），用于实时摘要；null 表示空闲。 */
  live: ChainEditResult | null;
  /** 被编辑章节标题。 */
  anchorTitle?: string;
  onToggle: () => void;
  onUnlockAll: () => void;
}

function deltaText(d: number): string {
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return `${sign}${Math.abs(d).toFixed(2)}s`;
}

const KIND_LABEL = {
  move: '拖动',
  'resize-start': '调整起点',
  'resize-end': '调整终点',
} as const;

export function ChainBar(props: ChainBarProps) {
  const { enabled, lockedCount, chapterCount, live, anchorTitle, onToggle, onUnlockAll } = props;

  let summary: string;
  if (live) {
    const n = Math.max(0, live.movedIds.length - 1);
    const verb = KIND_LABEL[live.kind];
    const who = anchorTitle ? `「${anchorTitle}」` : '章节';
    const clip = live.clipped
      ? `（已钳制${live.stop ? `于${stopLabel(live.stop)}` : ''}）`
      : '';
    summary =
      live.kind === 'resize-start'
        ? `${verb}${who} ${deltaText(live.delta)}，仅移动本章节起点，不连带后续${clip}`
        : `${verb}${who} ${deltaText(live.delta)}` +
          (enabled
            ? `，连锁带动后续 ${n} 个未锁定章节（间隔与时长不变）${clip}`
            : `${clip}`);
  } else if (enabled) {
    summary =
      chapterCount === 0
        ? '连锁移动已开启：拖动或缩放未锁定章节时，位移将传递给其后的未锁定章节。'
        : lockedCount === 0
          ? '连锁移动已开启：暂无锁定章节——整行章节会像滑块串一样整体平移（音频结尾为止）。点击章节上的 🔒 可固定。'
          : `连锁移动已开启：已锁定 ${lockedCount}/${chapterCount} 章；位移传递到锁定章节或音频边界即停止。`;
  } else {
    summary = '连锁移动关闭：每次只编辑一个章节。开启后可锁定章节并让边界位移向后传递。';
  }

  return (
    <div className={`chain-bar${enabled ? ' on' : ''}`}>
      <label className="chain-toggle" title="开启后，拖动/缩放产生的边界位移传递给其后未锁定章节">
        <input type="checkbox" checked={enabled} onChange={onToggle} />
        <span className="chain-name">🔗 连锁移动</span>
      </label>
      {lockedCount > 0 && (
        <button className="chain-unlock" onClick={onUnlockAll} title="解除当前所有章节锁定">
          解锁全部（{lockedCount}）
        </button>
      )}
      <span className={`chain-summary${live?.clipped ? ' clipped' : ''}`}>{summary}</span>
    </div>
  );
}
