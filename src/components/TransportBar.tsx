import { formatTime } from '../utils/time';

interface TransportBarProps {
  loaded: boolean;
  playing: boolean;
  playhead: number;
  duration: number;
  pxPerSec: number;
  follow: boolean;
  hasSelection: boolean;
  onTogglePlay: () => void;
  onPreviewSelection: () => void;
  onAddAtPlayhead: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onZoom: (pxPerSec: number) => void;
  onToggleFollow: () => void;
}

const ZOOMS = [2, 5, 10, 25, 50, 100, 200, 400, 800];

export function TransportBar(props: TransportBarProps) {
  const {
    loaded,
    playing,
    playhead,
    duration,
    pxPerSec,
    follow,
    hasSelection,
    onTogglePlay,
    onPreviewSelection,
    onAddAtPlayhead,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onZoom,
    onToggleFollow,
  } = props;

  return (
    <div className="transport">
      <button onClick={onTogglePlay} disabled={!loaded} className="primary" title="空格">
        {playing ? '⏸ 暂停' : '▶ 播放'}
      </button>
      <button onClick={onPreviewSelection} disabled={!loaded || !hasSelection} title="预览选中章节 (P)">
        ▶| 预览章节
      </button>
      <button onClick={onAddAtPlayhead} disabled={!loaded} title="在播放头处新建章节 (N)">
        ＋ 播放头处建章节
      </button>
      <button onClick={onUndo} disabled={!loaded || !canUndo} title="撤销 (Ctrl/Cmd+Z)">
        ↶ 撤销
      </button>
      <button
        onClick={onRedo}
        disabled={!loaded || !canRedo}
        title="重做 (Ctrl/Cmd+Shift+Z)"
      >
        ↷ 重做
      </button>
      <span className="time-display">
        {formatTime(playhead)} / {formatTime(duration)}
      </span>
      <span className="spacer" />
      <label className="follow-toggle">
        <input type="checkbox" checked={follow} onChange={onToggleFollow} /> 跟随播放
      </label>
      <label className="zoom-label">缩放</label>
      <input
        type="range"
        min={0}
        max={ZOOMS.length - 1}
        step={1}
        value={nearestZoomIndex(pxPerSec)}
        onChange={(e) => onZoom(ZOOMS[Number(e.target.value)])}
        disabled={!loaded}
        className="zoom-slider"
      />
      <span className="zoom-value">{Math.round(pxPerSec)} px/s</span>
    </div>
  );
}

function nearestZoomIndex(pxPerSec: number): number {
  let best = 0;
  let bestDist = Infinity;
  ZOOMS.forEach((z, i) => {
    const d = Math.abs(Math.log(z / pxPerSec));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}
