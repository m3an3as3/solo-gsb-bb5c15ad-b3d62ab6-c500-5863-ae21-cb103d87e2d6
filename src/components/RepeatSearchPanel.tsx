import { MIN_SAMPLE_SEC, type RepeatHit } from '../audio/repeatSearch';
import type { Chapter } from '../types';
import { formatTime } from '../utils/time';

interface RepeatSearchPanelProps {
  /** 当前选中章节（样本）；null 表示未选中 */
  sample: Chapter | null;
  /** 最近一次搜索的命中；null 表示当前样本尚未搜索 */
  hits: RepeatHit[] | null;
  searching: boolean;
  error: string | null;
  onSearch: () => void;
  onPreview: (hit: RepeatHit) => void;
}

/**
 * 重复录制定位面板：以当前选中章节的原始音频为样本，在整段录音中查找
 * 重复录制位置。命中按相似度排序列出起止时间，点击跳转试听。
 * 更换音频或修改样本章节边界时，旧结果由上层清空。
 */
export function RepeatSearchPanel(props: RepeatSearchPanelProps) {
  const { sample, hits, searching, error } = props;
  const sampleLen = sample ? sample.end - sample.start : 0;
  const canSearch = sample !== null && sampleLen >= MIN_SAMPLE_SEC && !searching;

  return (
    <section className="silence-panel repeat-panel">
      <h2>重复录制定位</h2>
      {sample ? (
        <div className="repeat-sample">
          <span>
            样本章节：<b>{sample.title}</b>
          </span>
          <span>
            {formatTime(sample.start)} → {formatTime(sample.end)}（{sampleLen.toFixed(2)}s）
          </span>
        </div>
      ) : (
        <div className="silence-info">
          在左侧列表或波形中选中一个章节，即以其原始音频为样本，在整段录音中查找重复录制。
        </div>
      )}
      {sample && sampleLen < MIN_SAMPLE_SEC && (
        <div className="silence-info">
          样本章节过短（{sampleLen.toFixed(2)}s &lt; {MIN_SAMPLE_SEC}s），请选用更长的章节。
        </div>
      )}
      <button
        type="button"
        className="primary"
        disabled={!canSearch}
        onClick={props.onSearch}
        title={
          canSearch
            ? '在整段录音中搜索与该章节音频重复的位置（后台线程计算）'
            : '请先选中一个足够长的章节作为样本'
        }
      >
        {searching ? '正在后台搜索…' : '在整段录音中搜索'}
      </button>
      {error && <div className="imp-error-text">{error}</div>}
      {hits !== null && !searching && (
        <>
          {hits.length === 0 ? (
            <div className="silence-info">未发现重复片段（已排除样本自身及与其重叠的区间）。</div>
          ) : (
            <div className="repeat-list">
              {hits.map((h, i) => (
                <button
                  key={`${h.start.toFixed(3)}`}
                  type="button"
                  className="repeat-row"
                  onClick={() => props.onPreview(h)}
                  title={`跳到 ${formatTime(h.start)} 试听该命中片段`}
                >
                  <span className="repeat-rank">#{i + 1}</span>
                  <span className="repeat-time">
                    {formatTime(h.start)} → {formatTime(h.end)}
                  </span>
                  <span className="repeat-score">{(h.score * 100).toFixed(1)}%</span>
                </button>
              ))}
            </div>
          )}
          <div className="silence-info">
            {hits.length > 0
              ? `${hits.length} 处命中 · 按相似度排序，点击跳转试听`
              : '相似度为归一化相关（音量变化不影响排序）。'}
          </div>
        </>
      )}
    </section>
  );
}
