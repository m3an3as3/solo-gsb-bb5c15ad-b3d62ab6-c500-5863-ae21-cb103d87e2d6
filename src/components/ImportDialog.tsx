import { useEffect, useMemo, useState } from 'react';
import type { ImportPreview, PreviewEntry } from '../utils/importChapters';
import { formatTime } from '../utils/time';

interface ImportDialogProps {
  preview: ImportPreview | null;
  fileName: string;
  parseError: string | null;
  duration: number;
  onApply: (entries: PreviewEntry[]) => void;
  onClose: () => void;
}

const STATUS_META: Record<
  PreviewEntry['status'],
  { label: string; className: string }
> = {
  valid: { label: '新增', className: 'imp-status-valid' },
  invalid: { label: '无法解析', className: 'imp-status-invalid' },
  'out-of-bounds': { label: '时间越界', className: 'imp-status-bounds' },
  overlap: { label: '重叠', className: 'imp-status-overlap' },
};

type FilterKey = 'all' | 'valid' | 'problem';

/**
 * Chapter-file import preview: every parsed cue with a per-row status
 * (新增 / 时间越界 / 重叠 / 无法解析). Only `valid` rows are selectable;
 * applying writes the selected rows in one undoable step. Esc cancels.
 */
export function ImportDialog(props: ImportDialogProps) {
  const { preview, parseError, onApply, onClose } = props;
  const [filter, setFilter] = useState<FilterKey>('all');
  // selection follows the latest preview shown (all valid rows pre-checked)
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    setFilter('all');
    setSelectedRows(new Set(preview?.entries.filter((e) => e.status === 'valid').map((e) => e.row) ?? []));
  }, [preview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const validEntries = useMemo(
    () => preview?.entries.filter((e) => e.status === 'valid') ?? [],
    [preview],
  );
  const checkedValid = validEntries.filter((e) => selectedRows.has(e.row));

  if (!preview && !parseError) return null;

  const visible = (preview?.entries ?? []).filter((e) => {
    if (filter === 'valid') return e.status === 'valid';
    if (filter === 'problem') return e.status !== 'valid';
    return true;
  });

  const toggleRow = (e: PreviewEntry) => {
    if (e.status !== 'valid') return;
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(e.row)) next.delete(e.row);
      else next.add(e.row);
      return next;
    });
  };

  const allValidSelected = validEntries.length > 0 && checkedValid.length === validEntries.length;
  const toggleAllValid = () => {
    setSelectedRows(allValidSelected ? new Set() : new Set(validEntries.map((e) => e.row)));
  };

  return (
    <div className="imp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="imp-dialog" role="dialog" aria-modal="true" aria-label="章节导入预览">
        <div className="imp-header">
          <h2>导入章节预览</h2>
          <button className="imp-close" title="取消（Esc）" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="imp-sub">
          {parseError ? (
            <span className="imp-error-text">
              「{props.fileName}」无法解析：{parseError}
            </span>
          ) : (
            preview && (
              <>
                <span className="imp-file-name" title={props.fileName}>
                  {props.fileName}
                </span>
                <span className={preview.format === 'vtt' ? 'imp-badge' : 'imp-badge imp-json'}>
                  {preview.format === 'vtt' ? 'WebVTT' : 'JSON'}
                </span>
                <span className="imp-sub-sep">·</span>
                <span>当前音频时长 {formatTime(props.duration)}</span>
                <span className="imp-sub-sep">·</span>
                <span>
                  共 {preview.counts.total} 条：
                  <b className="imp-status-valid"> 新增 {preview.counts.valid}</b>
                  {preview.counts.outOfBounds > 0 && (
                    <b className="imp-status-bounds"> 越界 {preview.counts.outOfBounds}</b>
                  )}
                  {preview.counts.overlap > 0 && (
                    <b className="imp-status-overlap"> 重叠 {preview.counts.overlap}</b>
                  )}
                  {preview.counts.invalid > 0 && (
                    <b className="imp-status-invalid"> 无法解析 {preview.counts.invalid}</b>
                  )}
                </span>
              </>
            )
          )}
        </div>

        {preview && (
          <>
            <div className="imp-filters">
              {(['all', 'valid', 'problem'] as FilterKey[]).map((f) => (
                <button
                  key={f}
                  className={filter === f ? 'imp-filter active' : 'imp-filter'}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? `全部（${preview.counts.total}）` : f === 'valid' ? `可导入（${preview.counts.valid}）` : `问题条目（${preview.counts.invalid + preview.counts.outOfBounds + preview.counts.overlap}）`}
                </button>
              ))}
              <span className="spacer" />
              <label className="imp-select-all">
                <input
                  type="checkbox"
                  checked={allValidSelected}
                  disabled={validEntries.length === 0}
                  onChange={toggleAllValid}
                />
                全选有效条目
              </label>
            </div>

            <div className="imp-table-wrap">
              <table className="imp-table">
                <thead>
                  <tr>
                    <th className="imp-col-check">导入</th>
                    <th className="imp-col-row">#</th>
                    <th className="imp-col-time">开始</th>
                    <th className="imp-col-time">结束</th>
                    <th>标题 / 说明</th>
                    <th className="imp-col-status">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e) => {
                    const meta = STATUS_META[e.status];
                    const checked = selectedRows.has(e.row);
                    return (
                      <tr
                        key={e.row}
                        className={e.status === 'valid' ? (checked ? 'imp-row-checked' : '') : 'imp-row-problem'}
                      >
                        <td className="imp-col-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={e.status !== 'valid'}
                            onChange={() => toggleRow(e)}
                          />
                        </td>
                        <td className="imp-col-row">{e.row}</td>
                        <td className="imp-col-time">{Number.isFinite(e.start) ? formatTime(e.start) : '—'}</td>
                        <td className="imp-col-time">{Number.isFinite(e.end) ? formatTime(e.end) : '—'}</td>
                        <td className="imp-col-title">
                          <span className="imp-title-text">{e.title || <span className="imp-muted">（空标题，按序号补全）</span>}</span>
                          {e.reasons.length > 0 && (
                            <span className="imp-reasons">
                              {e.reasons.map((r) => (
                                <span key={r} className="imp-reason">
                                  {r}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="imp-col-status">
                          <span className={`imp-pill ${meta.className}`}>{meta.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={6} className="imp-empty">
                        该筛选下没有条目。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="imp-footer">
              <span className="imp-footer-hint">
                仅应用勾选的有效条目；现有章节保持不变，结果按时间排序且不重叠。整次导入可用撤销一次还原。
              </span>
              <span className="spacer" />
              <button onClick={onClose}>全部取消</button>
              <button
                className="primary"
                disabled={checkedValid.length === 0}
                onClick={() => onApply(validEntries.filter((e) => selectedRows.has(e.row)))}
              >
                应用 {checkedValid.length > 0 ? `选中的 ${checkedValid.length} 条` : ''}
              </button>
            </div>
          </>
        )}

        {parseError && (
          <div className="imp-footer">
            <span className="spacer" />
            <button className="primary" onClick={onClose}>
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
