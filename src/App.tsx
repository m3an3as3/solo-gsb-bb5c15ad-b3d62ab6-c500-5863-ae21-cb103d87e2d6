import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine, StaleDecodeError } from './audio/AudioEngine';
import { DEFAULT_FADE, type FadeSettings } from './audio/fade';
import {
  LOUDNESS_WINDOW_SEC,
  computeDbfsWindows,
  evaluateAllChapters,
  findLoudnessSegments,
  type LoudnessThresholds,
} from './audio/loudness';
import { PeaksSupersededError, PeaksWorkerClient } from './audio/PeaksWorkerClient';
import {
  ClickScanSupersededError,
  ClickScanWorkerClient,
} from './audio/ClickScanWorkerClient';
import {
  encodeRepairedWav,
  repairClicks,
  type ClickEvent,
  type RepairedPcm,
} from './audio/clickRepair';
import {
  RepeatSearchSupersededError,
  RepeatSearchWorkerClient,
} from './audio/RepeatSearchWorkerClient';
import type { RepeatHit } from './audio/repeatSearch';
import {
  applyMuting,
  clampMuteRegion,
  encodeMutedWav,
  pcmToAudioBuffer,
  prepareMuteRanges,
  type MuteRegion,
  type MutedPcm,
} from './audio/muting';
import {
  RMS_WINDOW_SEC,
  computeRmsWindows,
  findSilenceSegments,
  splitGapsAtBoundaries,
  suggestSplitBoundaries,
} from './audio/silence';
import { Waveform } from './components/Waveform';
import { ChapterList } from './components/ChapterList';
import { ChainBar } from './components/ChainBar';
import { ClickRepairPanel } from './components/ClickRepairPanel';
import { FadePanel } from './components/FadePanel';
import { ImportDialog } from './components/ImportDialog';
import { LoudnessPanel } from './components/LoudnessPanel';
import { MutePanel } from './components/MutePanel';
import { RepeatSearchPanel } from './components/RepeatSearchPanel';
import { SilencePanel } from './components/SilencePanel';
import { TransportBar } from './components/TransportBar';
import { TranscriptPanel, type LoadedTranscript } from './components/TranscriptPanel';
import { useChapters } from './hooks/useChapters';
import type { Chapter, Peaks } from './types';
import {
  describeLimit,
  describeLockedAnchor,
  type ChainEditResult,
} from './utils/chainOps';
import { downloadBlob, downloadFile, toJSON, toWebVTT } from './utils/export';
import { buildChapterAudioPack } from './utils/audioPack';
import {
  applyImportedChapters,
  buildImportPreview,
  parseChapterFile,
  type ImportPreview,
  type PreviewEntry,
} from './utils/importChapters';
import { formatTime, uid } from './utils/time';
import {
  clipTranscriptCues,
  computeTranscriptCoverage,
  parseTranscriptVtt,
} from './utils/transcriptCoverage';

const NUDGE_FINE = 0.05;
const NUDGE_COARSE = 1;

/** 比较两组消音标记是否逐 id 相同（用于判断处理结果是否过期）。 */
function regionsEqual(a: MuteRegion[], b: MuteRegion[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((r) => [r.id, r]));
  return a.every((r) => {
    const o = byId.get(r.id);
    return o && o.start === r.start && o.end === r.end;
  });
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  // 波形峰值在独立 Web Worker 中计算，长音频不阻塞界面；Worker 随 App 单例
  const peaksClientRef = useRef<PeaksWorkerClient | null>(null);
  if (!peaksClientRef.current) peaksClientRef.current = new PeaksWorkerClient();
  const peaksClient = peaksClientRef.current;

  // 重复录制搜索同样在独立 Web Worker 中进行；连续搜索只保留最新一次
  const repeatClientRef = useRef<RepeatSearchWorkerClient | null>(null);
  if (!repeatClientRef.current) repeatClientRef.current = new RepeatSearchWorkerClient();
  const repeatClient = repeatClientRef.current;

  // 爆音扫描也在独立 Web Worker 中进行；连续扫描只保留最新一次
  const clickClientRef = useRef<ClickScanWorkerClient | null>(null);
  if (!clickClientRef.current) clickClientRef.current = new ClickScanWorkerClient();
  const clickClient = clickClientRef.current;

  const [fileName, setFileName] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(50);
  const [follow, setFollow] = useState(true);
  // 载入阶段：解码 / Worker 计算峰值；峰值失败可重试（原 buffer 仍保留）
  const [loadPhase, setLoadPhase] = useState<'idle' | 'decoding' | 'peaks'>('idle');
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [peaksError, setPeaksError] = useState<string | null>(null);
  /** 当前已解码、且峰值阶段正在使用的 AudioBuffer（保留供播放 / 质检 / 重试） */
  const currentBufferRef = useRef<AudioBuffer | null>(null);
  /** 当前载入任务 token；连续切换时只有最新任务可写波形 */
  const loadTokenRef = useRef(0);

  // silence-split suggestions
  const [rmsWindows, setRmsWindows] = useState<Float32Array | null>(null);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-40);
  const [minSilenceSec, setMinSilenceSec] = useState(0.5);
  const [showSuggestions, setShowSuggestions] = useState(true);

  // chapter loudness QC (200ms dBFS windows computed once at import)
  const [dbfsWindows, setDbfsWindows] = useState<Float32Array | null>(null);
  const [loudnessThresholds, setLoudnessThresholds] = useState<LoudnessThresholds>({
    quietDb: -30,
    loudDb: -6,
  });
  const [showLoudness, setShowLoudness] = useState(true);

  // per-chapter fade preview settings — UI-only state, keyed by chapter id;
  // never part of chapter data or exports
  const [fades, setFades] = useState<Record<string, FadeSettings>>({});
  /** what the current playback is: a chapter preview started at `from` */
  const previewRef = useRef<{ chapterId: string; from: number } | null>(null);

  const chaptersApi = useChapters(duration);
  const { chapters, selected, selectedId, reset: resetChapters } = chaptersApi;

  // 连锁移动：拖拽/缩放中的实时摘要 + 钳制原因提示（toast 按原因去重，避免每帧刷屏）
  const [liveEdit, setLiveEdit] = useState<ChainEditResult | null>(null);
  const liveAnchorIdRef = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeKeyRef = useRef<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  // 本地章节文件导入（JSON / WebVTT）：文件解析后的预览状态
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  // 每次选文件自增，避免快速连选两个文件时先返回的旧解析覆盖新预览
  const importTokenRef = useRef(0);
  // 应用时按此快照合并，保证“预览所见即应用所得”，失败不写任何内容
  const previewExistingRef = useRef<Chapter[]>([]);
  const previewDurationRef = useRef(0);

  // ---- 本地 WebVTT 逐字稿覆盖核对（字幕不导入为章节，仅统计时间交集）----
  const transcriptFileInputRef = useRef<HTMLInputElement | null>(null);
  const [transcript, setTranscript] = useState<LoadedTranscript | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  // 连续选择两个逐字稿时，先完成读取的旧文件不得覆盖新选择
  const transcriptTokenRef = useRef(0);

  // ---- 敏感片段消音：用户标记（秒）+ 处理结果（试听与下载同源）----
  const [muteRegions, setMuteRegions] = useState<MuteRegion[]>([]);
  const [muteError, setMuteError] = useState<string | null>(null);
  /** 最近一次「生成消音音频」的结果 PCM；标记再变动即作废（与 stale 配套） */
  const mutedPcmRef = useRef<MutedPcm | null>(null);
  const [mutedResult, setMutedResult] = useState<MutedPcm | null>(null);
  /** 处理结果是否相对当前标记已过期 */
  const [muteStale, setMuteStale] = useState(false);
  /** 试听用的处理后 AudioBuffer（与 mutedPcmRef 同一份 PCM） */
  const mutedBufferRef = useRef<AudioBuffer | null>(null);
  const [auditioning, setAuditioning] = useState(false);
  /** 停止试听并切回原始缓冲（供载入新音频等场景复用） */
  const stopAuditionRef = useRef<(restoreOriginal?: boolean) => void>(() => {});

  // ---- 重复录制定位：以选中章节为样本在整段录音中查找重复片段 ----
  const [repeatHits, setRepeatHits] = useState<RepeatHit[] | null>(null);
  const [repeatSearching, setRepeatSearching] = useState(false);
  const [repeatError, setRepeatError] = useState<string | null>(null);
  /** 单调递增 token：连续搜索 / 样本变化时，旧搜索的结果一律作废 */
  const repeatTokenRef = useRef(0);

  // ---- 短促爆音修复：扫描结果 + 勾选 + 修复结果（试听与下载同源）----
  const [clickEvents, setClickEvents] = useState<ClickEvent[] | null>(null);
  const [clickScanning, setClickScanning] = useState(false);
  const [clickError, setClickError] = useState<string | null>(null);
  const [clickChecked, setClickChecked] = useState<ReadonlySet<string>>(new Set());
  /** 单调递增 token：连续扫描 / 换音频时，旧扫描的结果一律作废 */
  const clickTokenRef = useRef(0);
  /** 最近一次「修复勾选爆音」的结果 PCM；勾选再变动即作废 */
  const repairedPcmRef = useRef<RepairedPcm | null>(null);
  const [repairedResult, setRepairedResult] = useState<RepairedPcm | null>(null);
  /** 试听用的修复后 AudioBuffer（与 repairedPcmRef 同一份 PCM） */
  const repairedBufferRef = useRef<AudioBuffer | null>(null);
  const [clickAuditioning, setClickAuditioning] = useState(false);

  /** 弹出一条临时提示；同一手势内相同 key 的提示不重复弹出。 */
  const showNotice = useCallback((msg: string, key: string, durationMs = 2200) => {
    if (noticeKeyRef.current === key) return;
    noticeKeyRef.current = key;
    setNotice(msg);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeKeyRef.current = null;
      noticeTimerRef.current = null;
    }, durationMs);
  }, []);

  /**
   * 章节编辑（拖动 / 缩放 / 键盘微调）反馈：钳制时提示原因。
   * null 表示手势结束（鼠标松开）：清空实时摘要与去重键，下一手势可再次提示。
   */
  const reportEdit = useCallback(
    (r: ChainEditResult | 'locked' | null) => {
      if (r === null) {
        setLiveEdit(null);
        liveAnchorIdRef.current = null;
        noticeKeyRef.current = null;
        return;
      }
      if (r === 'locked') {
        showNotice(describeLockedAnchor(), 'locked-attempt');
        return;
      }
      if (liveAnchorIdRef.current === null) {
        liveAnchorIdRef.current = r.movedIds[0] ?? null;
      }
      setLiveEdit(r);
      if (r.clipped && r.reason) {
        showNotice(describeLimit(r.reason, r.stop), `clip:${r.reason}`);
      }
    },
    [showNotice],
  );

  /** 直接在锁定章节上按下拖拽手柄 / 尝试键盘编辑时的提示。 */
  const reportLockedAttempt = useCallback(
    (id: string) => {
      const c = chapters.find((x) => x.id === id);
      showNotice(describeLockedAnchor(c?.title), `locked:${id}`);
    },
    [chapters, showNotice],
  );

  // drop fade settings of removed chapters (and of the previous file)
  useEffect(() => {
    setFades((prev) => {
      const ids = new Set(chapters.map((c) => c.id));
      const entries = Object.entries(prev).filter(([id]) => ids.has(id));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
  }, [chapters]);

  // 重复录制定位：样本是「当前选中章节」。换选章节、修改样本边界（或删除 /
  // 换音频导致选中清空）都会改变此 key —— 旧命中与进行中的搜索一并作废。
  // 重命名不改变 key，旧结果保留。
  const repeatSampleKey = selected ? `${selected.id}|${selected.start}|${selected.end}` : null;
  useEffect(() => {
    repeatTokenRef.current += 1;
    repeatClient.cancel();
    setRepeatHits(null);
    setRepeatError(null);
    setRepeatSearching(false);
  }, [repeatSampleKey, repeatClient]);

  // recompute candidates whenever params or chapters change
  const suggestions = useMemo(() => {
    if (!rmsWindows || duration <= 0) return [];
    const thresholdLinear = Math.pow(10, silenceThresholdDb / 20);
    const segments = findSilenceSegments(
      rmsWindows,
      RMS_WINDOW_SEC,
      thresholdLinear,
      minSilenceSec,
      duration,
    );
    return suggestSplitBoundaries(segments, chapters, duration);
  }, [rmsWindows, silenceThresholdDb, minSilenceSec, chapters, duration]);

  const applyAllSuggestions = useCallback(() => {
    const ranges = splitGapsAtBoundaries(chapters, suggestions, duration);
    chaptersApi.addMany(ranges);
  }, [chapters, suggestions, duration, chaptersApi]);

  // Loudness QC: thresholds/chapters only re-run the classification over the
  // cached 200ms dBFS windows — the decoded PCM is never scanned again.
  const chapterLoudness = useMemo(() => {
    if (!dbfsWindows) return null;
    return evaluateAllChapters(
      chapters,
      dbfsWindows,
      LOUDNESS_WINDOW_SEC,
      duration,
      loudnessThresholds,
    );
  }, [dbfsWindows, chapters, duration, loudnessThresholds]);

  const loudnessSegments = useMemo(() => {
    if (!dbfsWindows || !showLoudness) return [];
    return findLoudnessSegments(dbfsWindows, LOUDNESS_WINDOW_SEC, duration, loudnessThresholds);
  }, [dbfsWindows, showLoudness, duration, loudnessThresholds]);

  const changeQuietThreshold = useCallback((v: number) => {
    setLoudnessThresholds((t) => ({ ...t, quietDb: Math.min(v, t.loudDb - 1) }));
  }, []);
  const changeLoudThreshold = useCallback((v: number) => {
    setLoudnessThresholds((t) => ({ ...t, loudDb: Math.max(v, t.quietDb + 1) }));
  }, []);

  // playback clock
  useEffect(() => {
    engine.onEnded = () => {
      previewRef.current = null;
      setPlaying(false);
      setAuditioning((a) => {
        if (a) {
          engine.setPlaybackBuffer(null);
          return false;
        }
        return a;
      });
      setClickAuditioning((a) => {
        if (a) {
          engine.setPlaybackBuffer(null);
          return false;
        }
        return a;
      });
    };
    let raf = 0;
    const tick = () => {
      if (engine.playing) {
        setPlayhead(engine.getTime());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  useEffect(
    () => () => {
      engine.dispose();
      peaksClient.dispose();
      repeatClient.dispose();
      clickClient.dispose();
    },
    [engine, peaksClient, repeatClient, clickClient],
  );

  /**
   * 运行 Worker 峰值任务。失败时不丢弃已解码 buffer，界面给出可恢复提示，
   * 用户可点「重试」直接用缓存 buffer 重新计算。
   */
  const runPeaks = useCallback(
    async (buffer: AudioBuffer, token: number) => {
      setLoadPhase('peaks');
      setPeaksError(null);
      try {
        const result = await peaksClient.compute(buffer);
        if (token !== loadTokenRef.current) return; // 又切了文件：旧结果作废
        setPeaks(result);
        setLoadPhase('idle');
      } catch (err) {
        if (err instanceof PeaksSupersededError) return;
        if (token !== loadTokenRef.current) return;
        setPeaks(null);
        setPeaksError('波形计算失败（可能是内存不足或 Worker 异常），可点「重试」重新计算。');
        setLoadPhase('idle');
      }
    },
    [peaksClient],
  );

  /**
   * 载入新音频。连续切换时 token 单调递增：过期任务（旧解码 / 旧 Worker
   * 峰值）在每个 await 后都被识别并静默丢弃，只有最新任务能写波形与元数据。
   * 原 AudioBuffer 保留在 engine/currentBufferRef 中供播放、质检与峰值重试。
   */
  const loadFile = useCallback(
    async (file: File) => {
      const token = ++loadTokenRef.current;
      setDecodeError(null);
      setPeaksError(null);
      setLoadPhase('decoding');
      try {
        const buffer = await engine.decode(file);
        if (token !== loadTokenRef.current) return; // 已被更新的选择取代
        resetChapters();
        previewRef.current = null;
        // 载入新音频：清空消音标记与处理结果（标记是按旧缓冲记录的，不跨文件保留）
        stopAuditionRef.current?.(false);
        mutedPcmRef.current = null;
        mutedFromRegionsRef.current = null;
        mutedBufferRef.current = null;
        setMuteRegions([]);
        setMuteError(null);
        setMutedResult(null);
        setMuteStale(false);
        setAuditioning(false);
        // 重复定位结果按旧缓冲计算：与进行中的搜索一并作废
        repeatTokenRef.current += 1;
        repeatClient.cancel();
        setRepeatHits(null);
        setRepeatError(null);
        setRepeatSearching(false);
        // 爆音扫描与修复结果按旧缓冲计算：与进行中的扫描一并作废
        clickTokenRef.current += 1;
        clickClient.cancel();
        setClickEvents(null);
        setClickChecked(new Set());
        setClickError(null);
        setClickScanning(false);
        repairedPcmRef.current = null;
        repairedBufferRef.current = null;
        setRepairedResult(null);
        setClickAuditioning(false);
        currentBufferRef.current = buffer;
        // 复用同一份解码 PCM 做静音与音量质检（不重新解码）
        setRmsWindows(computeRmsWindows(buffer));
        setDbfsWindows(computeDbfsWindows(buffer));
        setDuration(buffer.duration);
        setFileName(file.name);
        setPlayhead(0);
        setPlaying(false);
        await runPeaks(buffer, token);
      } catch (err) {
        if (token !== loadTokenRef.current) return;
        if (err instanceof StaleDecodeError) return;
        setDecodeError('无法解码该音频文件，请换用常见格式（MP3 / WAV / M4A / OGG）。');
        setLoadPhase('idle');
      }
    },
    [engine, resetChapters, runPeaks, repeatClient, clickClient],
  );

  /** 峰值计算失败后的恢复入口：复用保留的 AudioBuffer，不再重新解码。 */
  const retryPeaks = useCallback(() => {
    const buffer = currentBufferRef.current;
    if (!buffer || loadPhase !== 'idle') return;
    const token = ++loadTokenRef.current;
    void runPeaks(buffer, token);
  }, [loadPhase, runPeaks]);

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void loadFile(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void loadFile(f);
  };

  // ---- 本地章节文件导入（本工具导出的 JSON / 标准 WebVTT）----
  const closeImportDialog = useCallback(() => {
    importTokenRef.current += 1; // discard any in-flight file read
    setImportPreview(null);
    setImportError(null);
    setImportFileName('');
  }, []);

  const onImportFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const token = ++importTokenRef.current;
    setImportFileName(f.name);
    setImportError(null);
    setImportPreview(null);
    f.text()
      .then((text) => {
        if (token !== importTokenRef.current) return; // a newer file was chosen
        const parsed = parseChapterFile(text);
        // snapshot the validation context so apply matches the preview even
        // if chapters change while the dialog is open
        previewExistingRef.current = chaptersApi.sortedChapters;
        previewDurationRef.current = duration;
        setImportPreview(buildImportPreview(parsed, previewExistingRef.current, duration));
      })
      .catch((err: unknown) => {
        if (token !== importTokenRef.current) return;
        setImportError(err instanceof Error ? err.message : '文件无法读取或解析。');
      });
  };

  const applyImport = useCallback(
    (entries: PreviewEntry[]) => {
      if (!importPreview) return;
      try {
        // build the full next list up-front; the final guard throws on any
        // overlap/out-of-range so replaceAll never performs a partial write
        const next = applyImportedChapters(
          importPreview,
          previewExistingRef.current,
          previewDurationRef.current,
          new Set(entries.map((e) => e.row)),
        );
        chaptersApi.replaceAll(next);
        showNotice(`已导入 ${entries.length} 个章节（可用撤销还原）。`, `import:${Date.now()}`);
        closeImportDialog();
      } catch (err) {
        setImportError(err instanceof Error ? err.message : '导入失败，未写入任何更改。');
      }
    },
    [importPreview, chaptersApi, showNotice, closeImportDialog],
  );

  // a new audio file invalidates any open import preview AND the loaded
  // transcript: cues clipped against the old duration never carry over
  useEffect(() => {
    previewExistingRef.current = [];
    setImportPreview(null);
    setImportError(null);
    transcriptTokenRef.current += 1;
    setTranscript(null);
    setTranscriptError(null);
  }, [fileName]);

  // ---- 逐字稿：读取本地 WebVTT 并按当前时长裁剪；不会产生任何章节 ----
  const onTranscriptFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const token = ++transcriptTokenRef.current;
    setTranscriptError(null);
    f.text()
      .then((text) => {
        if (token !== transcriptTokenRef.current) return; // 又选了更新的文件
        try {
          const { cues: rawCues, skipped } = parseTranscriptVtt(text);
          const clipped = clipTranscriptCues(rawCues, duration);
          const outOfRange = rawCues.length - clipped.length;
          if (clipped.length === 0) {
            setTranscript(null);
            setTranscriptError(
              `逐字稿中没有时间落在当前音频（0 ~ ${duration.toFixed(1)}s）内的有效字幕。`,
            );
            return;
          }
          setTranscript({
            fileName: f.name,
            cues: clipped,
            parseSkipped: skipped,
            outOfRange,
          });
        } catch (err) {
          setTranscript(null);
          setTranscriptError(err instanceof Error ? err.message : '逐字稿解析失败。');
        }
      })
      .catch(() => {
        if (token !== transcriptTokenRef.current) return;
        setTranscriptError('文件无法读取。');
      });
  };

  /** 移除当前逐字稿；进行中的旧读取一并作废。 */
  const removeTranscript = useCallback(() => {
    transcriptTokenRef.current += 1;
    setTranscript(null);
    setTranscriptError(null);
  }, []);

  // 章节边界编辑（移动 / 缩放 / 增删 / 撤销重做）后即时重算：只依赖章节与逐字稿
  const transcriptCoverage = useMemo(
    () => (transcript ? computeTranscriptCoverage(chapters, transcript.cues) : null),
    [transcript, chapters],
  );

  /** 停止试听并切回原始缓冲；restoreOriginal=false 时只停声、不切缓冲（载入新文件场景）。 */
  const stopAudition = useCallback(
    (restoreOriginal = true) => {
      engine.stop();
      if (restoreOriginal) engine.setPlaybackBuffer(null);
      setAuditioning(false);
      setClickAuditioning(false);
    },
    [engine],
  );
  stopAuditionRef.current = stopAudition;

  const seek = useCallback(
    (t: number) => {
      // 试听处理后音频时点波形：停止试听、切回原始缓冲，再按普通逻辑跳转
      stopAudition();
      const wasPlaying = engine.playing;
      engine.stop();
      previewRef.current = null;
      setPlayhead(t);
      if (wasPlaying) {
        engine.play(t);
        setPlaying(true);
      } else {
        setPlaying(false);
      }
    },
    [engine, stopAudition],
  );

  const togglePlay = useCallback(() => {
    if (!engine.hasBuffer) return;
    previewRef.current = null;
    if (auditioning) {
      // 试听中按主播放键：停止试听并切回原始音频，从当前位置播放
      const t = engine.getTime();
      stopAudition();
      engine.play(t);
      setPlayhead(t);
      setPlaying(true);
      return;
    }
    if (engine.playing) {
      const t = engine.pause();
      setPlayhead(t);
      setPlaying(false);
    } else {
      engine.play(playhead >= duration - 0.05 ? 0 : playhead);
      setPlaying(true);
    }
  }, [engine, playhead, duration, auditioning, stopAudition]);

  /**
   * Preview a chapter interval. When fades are enabled for the chapter, the
   * gain envelope is fitted to the ACTUAL playback range [from, chapter.end].
   * play() always stops the previous source first, so repeated previews
   * rebuild the curve instead of layering sound.
   */
  const previewChapter = useCallback(
    (c: Chapter, from?: number) => {
      if (!engine.hasBuffer) return;
      stopAudition();
      const start = from ?? c.start;
      const fade = fades[c.id];
      previewRef.current = { chapterId: c.id, from: start };
      if (fade?.enabled) {
        engine.play(start, c.end, { fadeIn: fade.fadeIn, fadeOut: fade.fadeOut });
      } else {
        engine.play(start, c.end);
      }
      setPlayhead(start);
      setPlaying(true);
    },
    [engine, fades, stopAudition],
  );

  const previewSelection = useCallback(() => {
    if (selected) previewChapter(selected);
  }, [selected, previewChapter]);

  /** Change fade settings; a playing preview of that chapter is rebuilt. */
  const updateFade = useCallback(
    (id: string, patch: Partial<FadeSettings>) => {
      const next = { ...DEFAULT_FADE, ...fades[id], ...patch };
      setFades((prev) => ({ ...prev, [id]: { ...DEFAULT_FADE, ...prev[id], ...patch } }));
      // Param change while this chapter is being previewed: stop the old
      // source and rebuild the curve immediately (never layered on top).
      const p = previewRef.current;
      if (p && p.chapterId === id && engine.playing) {
        const c = chapters.find((x) => x.id === id);
        if (c) {
          if (next.enabled) {
            engine.play(p.from, c.end, { fadeIn: next.fadeIn, fadeOut: next.fadeOut });
          } else {
            engine.play(p.from, c.end);
          }
        }
      }
    },
    [engine, fades, chapters],
  );

  /** Preview starting at a point (clicking an abnormal band). */
  const previewFrom = useCallback(
    (t: number) => {
      if (!engine.hasBuffer) return;
      stopAudition();
      previewRef.current = null;
      engine.play(t);
      setPlayhead(t);
      setPlaying(true);
    },
    [engine, stopAudition],
  );

  // ---- 重复录制定位 ----
  /**
   * 以当前选中章节为样本搜索整段录音。计算在 Worker 中进行；token 单调
   * 递增，连续搜索 / 样本变化时旧结果在每个 await 后被静默丢弃，只有
   * 最新一次搜索能写入命中列表。
   */
  const runRepeatSearch = useCallback(async () => {
    const buffer = currentBufferRef.current;
    const sample = selected;
    if (!buffer || !sample) return;
    const token = ++repeatTokenRef.current;
    setRepeatSearching(true);
    setRepeatError(null);
    setRepeatHits(null);
    try {
      const hits = await repeatClient.search(buffer, { start: sample.start, end: sample.end });
      if (token !== repeatTokenRef.current) return; // 已有更新的搜索或样本已变
      setRepeatHits(hits);
      setRepeatSearching(false);
    } catch (err) {
      if (err instanceof RepeatSearchSupersededError) return;
      if (token !== repeatTokenRef.current) return;
      setRepeatHits(null);
      setRepeatSearching(false);
      setRepeatError(err instanceof Error ? err.message : '重复录制搜索失败。');
    }
  }, [repeatClient, selected]);

  /** 试听命中片段：播放该命中区间（到点自动停止）。 */
  const previewRepeatHit = useCallback(
    (hit: RepeatHit) => {
      if (!engine.hasBuffer) return;
      stopAudition();
      previewRef.current = null;
      engine.play(hit.start, hit.end);
      setPlayhead(hit.start);
      setPlaying(true);
    },
    [engine, stopAudition],
  );

  /** From the list status pill: preview the chapter from its first issue. */
  const previewChapterIssue = useCallback(
    (c: Chapter) => {
      if (!engine.hasBuffer) return;
      const q = chapterLoudness?.get(c.id);
      previewChapter(c, q?.firstIssueAt ?? c.start);
    },
    [engine, chapterLoudness, previewChapter],
  );

  // ---- 敏感片段消音 ----
  /**
   * 标记发生任何增删改：保留原始 AudioBuffer 与现有章节不动，仅作废已生成的
   * 处理结果（试听停止、结果进入过期态，等待重新「生成消音音频」）。
   */
  const invalidateMuteResult = useCallback(() => {
    engine.stop();
    engine.setPlaybackBuffer(null);
    setAuditioning(false);
    setClickAuditioning(false);
    mutedPcmRef.current = null;
    mutedFromRegionsRef.current = null;
    mutedBufferRef.current = null;
    setMutedResult(null);
    setMuteStale(false);
  }, [engine]);

  const addMuteRegion = useCallback(
    (start: number, end: number) => {
      const clipped = clampMuteRegion(start, end, duration);
      if (!clipped) {
        setMuteError('消音区间无效：需为有限秒数，且起点早于终点（并落在音频范围内）。');
        return;
      }
      setMuteError(null);
      invalidateMuteResult();
      setMuteRegions((prev) => [...prev, { id: uid(), start: clipped.start, end: clipped.end }]);
    },
    [duration, invalidateMuteResult],
  );

  const updateMuteRegion = useCallback(
    (id: string, start: number, end: number) => {
      const clipped = clampMuteRegion(start, end, duration);
      if (!clipped) return;
      setMuteError(null);
      invalidateMuteResult();
      setMuteRegions((prev) =>
        prev.map((r) => (r.id === id ? { ...r, start: clipped.start, end: clipped.end } : r)),
      );
    },
    [duration, invalidateMuteResult],
  );

  const removeMuteRegion = useCallback(
    (id: string) => {
      invalidateMuteResult();
      setMuteRegions((prev) => prev.filter((r) => r.id !== id));
    },
    [invalidateMuteResult],
  );

  const clearMuteRegions = useCallback(() => {
    invalidateMuteResult();
    setMuteRegions([]);
    setMuteError(null);
  }, [invalidateMuteResult]);

  /** 生成消音后的完整音频：一次计算，试听与下载共用这同一份 PCM。 */
  const processMuting = useCallback(() => {
    const buffer = currentBufferRef.current;
    if (!buffer) {
      setMuteError('尚未导入音频，无法处理消音区间。');
      return;
    }
    try {
      const snapshot = muteRegions.map((r) => ({ ...r }));
      const pcm = applyMuting(buffer, muteRegions);
      const audioBuffer = pcmToAudioBuffer(pcm, engine.getContext());
      mutedPcmRef.current = pcm;
      mutedFromRegionsRef.current = snapshot;
      mutedBufferRef.current = audioBuffer;
      setMutedResult(pcm);
      setMuteStale(false);
      setMuteError(null);
    } catch (err) {
      setMutedResult(null);
      mutedPcmRef.current = null;
      mutedFromRegionsRef.current = null;
      mutedBufferRef.current = null;
      setMuteError(err instanceof Error ? err.message : '消音处理失败。');
    }
  }, [engine, muteRegions]);

  /** 试听处理后的完整音频（与下载同源）；再点一次停止。 */
  const toggleAudition = useCallback(() => {
    if (!mutedBufferRef.current) return;
    if (auditioning) {
      stopAudition();
      return;
    }
    previewRef.current = null;
    setClickAuditioning(false); // 爆音修复试听若在进行，随缓冲切换一并结束
    engine.setPlaybackBuffer(mutedBufferRef.current);
    const from = playhead >= mutedBufferRef.current.duration - 0.05 ? 0 : playhead;
    setPlayhead(from);
    engine.play(from);
    setPlaying(true);
    setAuditioning(true);
  }, [engine, auditioning, playhead, stopAudition]);

  /** 下载处理后完整音频的 16-bit PCM WAV（总时长 / 声道 / 采样率不变）。 */
  const downloadMutedWav = useCallback(() => {
    const pcm = mutedPcmRef.current;
    if (!pcm) return;
    try {
      const wav = encodeMutedWav(pcm);
      const name = (fileName ?? 'podcast').replace(/\.[^.]+$/, '');
      downloadBlob(
        `${name}.muted.wav`,
        new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }),
      );
    } catch (err) {
      setMuteError(err instanceof Error ? err.message : 'WAV 编码失败，未下载文件。');
    }
  }, [fileName]);

  // 标记生成后又被改动：当前标记与生成时的快照不同即过期，需重新生成。
  // 用快照比较（而非「刚处理完」标志），不受渲染 / effect 时机影响。
  const mutedFromRegionsRef = useRef<MuteRegion[] | null>(null);
  useEffect(() => {
    const from = mutedFromRegionsRef.current;
    setMuteStale(from !== null && !regionsEqual(muteRegions, from));
  }, [muteRegions]);

  /** 波形叠加用：合并后的消音区间（秒），供画布着色。 */
  const muteMergedRanges = useMemo(() => {
    const buffer = currentBufferRef.current;
    if (!buffer) return [];
    const prepared = prepareMuteRanges(muteRegions, buffer);
    return prepared.map((r) => ({
      start: r.startFrame / buffer.sampleRate,
      end: r.endFrame / buffer.sampleRate,
    }));
  }, [muteRegions, duration]);

  // ---- 短促爆音修复 ----
  /**
   * 勾选发生任何变动 / 重新扫描：保留原始 AudioBuffer 与现有章节不动，仅作废
   * 已生成的修复结果（试听停止、结果清空，等待重新「修复勾选爆音」）。
   */
  const invalidateClickResult = useCallback(() => {
    engine.stop();
    engine.setPlaybackBuffer(null);
    setAuditioning(false);
    setClickAuditioning(false);
    repairedPcmRef.current = null;
    repairedBufferRef.current = null;
    setRepairedResult(null);
  }, [engine]);

  /**
   * 按声道扫描原始 PCM 中的短促爆音。计算在 Worker 中进行；token 单调
   * 递增，连续扫描 / 换音频时旧结果在每个 await 后被静默丢弃，只有最新
   * 一次扫描能写入命中列表。扫描完成后默认全部勾选。
   */
  const runClickScan = useCallback(async () => {
    const buffer = currentBufferRef.current;
    if (!buffer) return;
    const token = ++clickTokenRef.current;
    invalidateClickResult();
    setClickScanning(true);
    setClickError(null);
    setClickEvents(null);
    setClickChecked(new Set());
    try {
      const events = await clickClient.scan(buffer);
      if (token !== clickTokenRef.current) return; // 已有更新的扫描或已换音频
      setClickEvents(events);
      setClickChecked(new Set(events.map((e) => e.id)));
      setClickScanning(false);
    } catch (err) {
      if (err instanceof ClickScanSupersededError) return;
      if (token !== clickTokenRef.current) return;
      setClickEvents(null);
      setClickScanning(false);
      setClickError(err instanceof Error ? err.message : '爆音扫描失败。');
    }
  }, [clickClient, invalidateClickResult]);

  const toggleClickChecked = useCallback(
    (id: string) => {
      invalidateClickResult();
      setClickChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [invalidateClickResult],
  );

  const setAllClickChecked = useCallback(
    (check: boolean) => {
      invalidateClickResult();
      setClickChecked(check ? new Set((clickEvents ?? []).map((e) => e.id)) : new Set());
    },
    [clickEvents, invalidateClickResult],
  );

  /** 试听某处爆音：播放原始音频中该处前后 0.6s（到点自动停止）。 */
  const previewClickEvent = useCallback(
    (ev: ClickEvent) => {
      if (!engine.hasBuffer) return;
      stopAudition();
      previewRef.current = null;
      const from = Math.max(0, ev.start - 0.6);
      engine.play(from, Math.min(duration, ev.end + 0.6));
      setPlayhead(from);
      setPlaying(true);
    },
    [engine, stopAudition, duration],
  );

  /** 生成修复后的完整音频：一次计算，试听与下载共用这同一份 PCM。 */
  const repairCheckedClicks = useCallback(() => {
    const buffer = currentBufferRef.current;
    if (!buffer) {
      setClickError('尚未导入音频，无法修复爆音。');
      return;
    }
    try {
      const selected = (clickEvents ?? []).filter((e) => clickChecked.has(e.id));
      const pcm = repairClicks(buffer, selected);
      const audioBuffer = pcmToAudioBuffer(pcm, engine.getContext());
      repairedPcmRef.current = pcm;
      repairedBufferRef.current = audioBuffer;
      setRepairedResult(pcm);
      setClickError(null);
    } catch (err) {
      repairedPcmRef.current = null;
      repairedBufferRef.current = null;
      setRepairedResult(null);
      setClickError(err instanceof Error ? err.message : '爆音修复失败。');
    }
  }, [engine, clickEvents, clickChecked]);

  /** 试听修复后的完整音频（与下载同源）；再点一次停止。 */
  const toggleClickAudition = useCallback(() => {
    const buf = repairedBufferRef.current;
    if (!buf) return;
    if (clickAuditioning) {
      stopAudition();
      return;
    }
    stopAudition(); // 停掉进行中的播放 / 其他试听并切回原始缓冲
    previewRef.current = null;
    engine.setPlaybackBuffer(buf);
    const from = playhead >= buf.duration - 0.05 ? 0 : playhead;
    setPlayhead(from);
    engine.play(from);
    setPlaying(true);
    setClickAuditioning(true);
  }, [engine, clickAuditioning, playhead, stopAudition]);

  /** 下载修复后完整音频的 16-bit PCM WAV（总时长 / 声道 / 采样率不变）。 */
  const downloadRepairedWav = useCallback(() => {
    const pcm = repairedPcmRef.current;
    if (!pcm) return;
    try {
      const wav = encodeRepairedWav(pcm);
      const name = (fileName ?? 'podcast').replace(/\.[^.]+$/, '');
      downloadBlob(
        `${name}.repaired.wav`,
        new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }),
      );
    } catch (err) {
      setClickError(err instanceof Error ? err.message : 'WAV 编码失败，未下载文件。');
    }
  }, [fileName]);

  const addAtPlayhead = useCallback(() => {
    chaptersApi.createAtPlayhead(playhead);
  }, [chaptersApi, playhead]);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      if (!peaks) return;
      // while the chapter import dialog is open, let it own the keyboard
      // (Esc cancels; no background chapter shortcuts fire through it)
      if (importPreview || importError) return;
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE_FINE;
      const sel = chaptersApi.selected;
      let handled = true;

      // undo/redo work outside of text fields; inside them the browser's
      // native text undo is left alone
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) chaptersApi.redo();
        else chaptersApi.undo();
      } else if (e.key === ' ') {
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!sel) return;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        let r: ReturnType<typeof chaptersApi.move> | ReturnType<typeof chaptersApi.resize>;
        if (e.altKey) {
          r = chaptersApi.resize(sel.id, 'start', sel.start + dir * step, 0);
        } else if (e.ctrlKey || e.metaKey) {
          r = chaptersApi.resize(sel.id, 'end', sel.end + dir * step, 0);
        } else {
          r = chaptersApi.move(sel.id, sel.start + dir * step, 0);
        }
        if (r === 'locked') reportLockedAttempt(sel.id);
        else if (r && r.clipped && r.reason) showNotice(describeLimit(r.reason, r.stop), `clip:${r.reason}`);
      } else if (e.key === 'n' || e.key === 'N') {
        addAtPlayhead();
      } else if (e.key === 'p' || e.key === 'P') {
        previewSelection();
      } else if (e.key === 'l' || e.key === 'L') {
        if (sel) chaptersApi.toggleLock(sel.id);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        chaptersApi.remove(sel.id);
      } else if (e.key === 'Escape') {
        chaptersApi.select(null);
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    peaks,
    chaptersApi,
    togglePlay,
    previewSelection,
    addAtPlayhead,
    reportLockedAttempt,
    showNotice,
    importPreview,
    importError,
  ]);

  const baseName = (fileName ?? 'podcast').replace(/\.[^.]+$/, '');

  /**
   * 章节音频包导出：点击时刻读取最新章节边界与当前已解码 AudioBuffer
   *（二者来自同一次导入；切换音频后 currentBufferRef 指向新 buffer、
   * 章节同时被重置，绝不会沿用旧数据）。全部 WAV 与 ZIP 编码成功后才
   * 触发下载，失败 / 无有效片段只提示原因，不下载半成品。
   */
  const exportAudioPack = useCallback(() => {
    const buffer = currentBufferRef.current;
    if (!buffer) {
      showNotice('尚未导入音频，无法导出章节音频包。', 'audiopack:nobuffer', 4000);
      return;
    }
    try {
      const pack = buildChapterAudioPack(chapters, buffer);
      // pack.zip 是新建的精确尺寸 Uint8Array，其 buffer 即完整 ZIP 字节
      downloadBlob(
        `${baseName}.chapters.zip`,
        new Blob([pack.zip.buffer as ArrayBuffer], { type: 'application/zip' }),
      );
      showNotice(
        `已导出 ${pack.fileNames.length} 个章节音频（16-bit PCM WAV 打包为 ZIP）` +
          (pack.skipped > 0 ? `，跳过 ${pack.skipped} 个越界 / 零长度章节` : '') +
          '。',
        `audiopack:ok:${Date.now()}`,
      );
    } catch (err) {
      showNotice(
        err instanceof Error ? err.message : '章节音频包导出失败，未下载任何文件。',
        'audiopack:fail',
        4000,
      );
    }
  }, [chapters, baseName, showNotice]);

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="app-header">
        <h1>播客章节标注工作台</h1>
        <label className="file-button">
          导入音频
          <input type="file" accept="audio/*" onChange={onFileInput} hidden />
        </label>
        {fileName && <span className="file-name">{fileName}</span>}
        <span className="spacer" />
        <button
          disabled={!peaks}
          title={peaks ? '从本工具导出的 JSON 或标准 WebVTT 文件导入章节' : '请先导入音频，以便按时长校验章节'}
          onClick={() => importFileInputRef.current?.click()}
        >
          导入章节
        </button>
        <input
          ref={importFileInputRef}
          type="file"
          accept=".vtt,.json,text/vtt,application/json"
          onChange={onImportFileInput}
          hidden
        />
        {/* 逐字稿载入入口在右侧「逐字稿覆盖核对」面板内；字幕不作为章节导入 */}
        <input
          ref={transcriptFileInputRef}
          type="file"
          accept=".vtt,text/vtt"
          onChange={onTranscriptFileInput}
          hidden
        />
        <button
          disabled={chapters.length === 0}
          onClick={() => downloadFile(`${baseName}.vtt`, toWebVTT(chapters), 'text/vtt')}
        >
          导出 WebVTT
        </button>
        <button
          disabled={chapters.length === 0}
          onClick={() =>
            downloadFile(
              `${baseName}.chapters.json`,
              toJSON(chapters, { loudness: chapterLoudness, thresholds: loudnessThresholds }),
              'application/json',
            )
          }
        >
          导出 JSON
        </button>
        <button
          disabled={chapters.length === 0}
          title="按当前章节起止时间从已解码音频截取，保留原声道与采样率编码为 16-bit PCM WAV，打成单个 ZIP"
          onClick={exportAudioPack}
        >
          导出章节音频包
        </button>
      </header>

      {decodeError && <div className="error-banner">{decodeError}</div>}
      {notice && <div className="chain-notice">{notice}</div>}

      {!peaks ? (
        <div className="drop-zone">
          {loadPhase === 'decoding' ? (
            '正在解码音频…'
          ) : loadPhase === 'peaks' ? (
            '正在后台线程计算波形峰值，长音频请稍候…'
          ) : peaksError ? (
            <div className="drop-error">
              <span>{peaksError}</span>
              <span className="drop-error-actions">
                <button onClick={retryPeaks}>重试计算波形</button>
                <label className="file-button">
                  重新选择音频
                  <input type="file" accept="audio/*" onChange={onFileInput} hidden />
                </label>
              </span>
            </div>
          ) : (
            '点击「导入音频」或将音频文件拖入页面'
          )}
        </div>
      ) : (
        <>
          <TransportBar
            loaded
            playing={playing}
            playhead={playhead}
            duration={duration}
            pxPerSec={pxPerSec}
            follow={follow}
            hasSelection={selected !== null}
            onTogglePlay={togglePlay}
            onPreviewSelection={previewSelection}
            onAddAtPlayhead={addAtPlayhead}
            onUndo={chaptersApi.undo}
            onRedo={chaptersApi.redo}
            canUndo={chaptersApi.canUndo}
            canRedo={chaptersApi.canRedo}
            onZoom={setPxPerSec}
            onToggleFollow={() => setFollow((f) => !f)}
          />
          <ChainBar
            enabled={chaptersApi.chainMode}
            lockedCount={chaptersApi.lockedIds.size}
            chapterCount={chapters.length}
            live={liveEdit}
            anchorTitle={
              liveEdit
                ? chapters.find((c) => c.id === liveEdit.movedIds[0])?.title
                : undefined
            }
            onToggle={chaptersApi.toggleChainMode}
            onUnlockAll={chaptersApi.unlockAll}
          />
          <Waveform
            peaks={peaks}
            chapters={chapters}
            selectedId={selectedId}
            playhead={playhead}
            pxPerSec={pxPerSec}
            follow={follow && playing}
            suggestions={showSuggestions ? suggestions : []}
            loudnessSegments={loudnessSegments}
            muteRanges={muteMergedRanges}
            lockedIds={chaptersApi.lockedIds}
            onZoom={setPxPerSec}
            onSeek={seek}
            onPreviewSegment={previewFrom}
            onSelect={chaptersApi.select}
            onCreateFromDrag={chaptersApi.createFromDrag}
            onMove={chaptersApi.move}
            onResize={chaptersApi.resize}
            onLockedAttempt={reportLockedAttempt}
            onEditFeedback={reportEdit}
          />
          <div className="main-body">
            <ChapterList
              chapters={chapters}
              selectedId={selectedId}
              loudness={chapterLoudness}
              coverage={transcriptCoverage?.byChapter ?? null}
              lockedIds={chaptersApi.lockedIds}
              chainEnabled={chaptersApi.chainMode}
              onSelect={(id) => {
                chaptersApi.select(id);
                const c = chapters.find((x) => x.id === id);
                if (c) seek(c.start);
              }}
              onPreview={previewChapter}
              onPreviewIssue={previewChapterIssue}
              onRename={chaptersApi.rename}
              onToggleLock={chaptersApi.toggleLock}
              onRemove={(id) => {
                if (previewRef.current?.chapterId === id) previewRef.current = null;
                chaptersApi.remove(id);
              }}
            />
            <aside className="detail-panel">
              <TranscriptPanel
                transcript={transcript}
                parseError={transcriptError}
                duration={duration}
                totalCoveredSeconds={transcriptCoverage?.totalCoveredSeconds ?? 0}
                chapterCount={chapters.length}
                selected={selected}
                selectedCoverage={selected ? transcriptCoverage?.byChapter.get(selected.id) ?? null : null}
                onPickFile={() => transcriptFileInputRef.current?.click()}
                onRemove={removeTranscript}
                onPreviewAt={previewFrom}
              />
              <SilencePanel
                thresholdDb={silenceThresholdDb}
                minSilenceSec={minSilenceSec}
                show={showSuggestions}
                candidateCount={suggestions.length}
                onThresholdDbChange={setSilenceThresholdDb}
                onMinSilenceSecChange={setMinSilenceSec}
                onToggleShow={() => setShowSuggestions((s) => !s)}
                onApplyAll={applyAllSuggestions}
              />
              <LoudnessPanel
                thresholds={loudnessThresholds}
                show={showLoudness}
                available={dbfsWindows !== null}
                statuses={chapters.map((c) => chapterLoudness?.get(c.id)?.status ?? 'unknown')}
                onQuietDbChange={changeQuietThreshold}
                onLoudDbChange={changeLoudThreshold}
                onToggleShow={() => setShowLoudness((s) => !s)}
              />
              <MutePanel
                playhead={playhead}
                duration={duration}
                regions={muteRegions}
                merged={muteMergedRanges}
                error={muteError}
                hasResult={mutedResult !== null}
                stale={muteStale}
                auditioning={auditioning}
                onAdd={addMuteRegion}
                onUpdate={updateMuteRegion}
                onRemove={removeMuteRegion}
                onClear={clearMuteRegions}
                onSeek={seek}
                onProcess={processMuting}
                onToggleAudition={toggleAudition}
                onDownload={downloadMutedWav}
              />
              <RepeatSearchPanel
                sample={selected}
                hits={repeatHits}
                searching={repeatSearching}
                error={repeatError}
                onSearch={runRepeatSearch}
                onPreview={previewRepeatHit}
              />
              <ClickRepairPanel
                events={clickEvents}
                scanning={clickScanning}
                error={clickError}
                checked={clickChecked}
                numberOfChannels={currentBufferRef.current?.numberOfChannels ?? 0}
                hasResult={repairedResult !== null}
                auditioning={clickAuditioning}
                onScan={runClickScan}
                onToggle={toggleClickChecked}
                onToggleAll={setAllClickChecked}
                onPreview={previewClickEvent}
                onRepair={repairCheckedClicks}
                onToggleAudition={toggleClickAudition}
                onDownload={downloadRepairedWav}
              />
              {selected ? (
                <>
                  <h2>选中章节</h2>
                  <label>
                    标题
                    <input
                      value={selected.title}
                      onChange={(e) => chaptersApi.rename(selected.id, e.target.value)}
                    />
                  </label>
                  <div className="detail-times">
                    <span>开始 {formatTime(selected.start)}</span>
                    <span>结束 {formatTime(selected.end)}</span>
                    <span>时长 {(selected.end - selected.start).toFixed(2)}s</span>
                  </div>
                  <FadePanel
                    fade={fades[selected.id] ?? DEFAULT_FADE}
                    chapterDuration={selected.end - selected.start}
                    onChange={(patch) => updateFade(selected.id, patch)}
                  />
                  {(() => {
                    const q = chapterLoudness?.get(selected.id);
                    if (!q) return null;
                    const mean = q.meanDbfs === null ? '-∞' : `${q.meanDbfs.toFixed(1)} dBFS`;
                    return (
                      <div className={`qc-detail qc-${q.status}`}>
                        <span>
                          质检状态：
                          {q.status === 'ok'
                            ? '正常'
                            : q.status === 'quiet'
                              ? '过轻'
                              : q.status === 'loud'
                                ? '过响'
                                : '区间过短'}
                          {q.allSilent ? '（全静音）' : ''}
                        </span>
                        <span>
                          平均 {mean} · 动态范围 {q.rangeDb.toFixed(1)} dB
                          {q.minDbfs !== null && q.maxDbfs !== null
                            ? `（${q.minDbfs.toFixed(1)} ~ ${q.maxDbfs.toFixed(1)} dBFS）`
                            : ''}
                        </span>
                        {(q.quietCoverage > 0 || q.loudCoverage > 0) && (
                          <button
                            onClick={() => previewChapterIssue(selected)}
                            title="从首个异常窗口开始播放"
                          >
                            ⚠ 从异常处预览
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  <button className="primary" onClick={previewSelection}>
                    ▶ 预览该章节
                  </button>
                </>
              ) : (
                <p className="empty-hint">点击波形中的章节或列表项以编辑。</p>
              )}
              <div className="shortcut-help">
                <h3>快捷键</h3>
                <ul>
                  <li><kbd>空格</kbd> 播放 / 暂停</li>
                  <li><kbd>N</kbd> 播放头处新建章节</li>
                  <li><kbd>P</kbd> 预览选中章节</li>
                  <li>
                    <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> 撤销，
                    <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做
                  </li>
                  <li><kbd>←</kbd><kbd>→</kbd> 移动选中章节（±0.05s，<kbd>Shift</kbd> ±1s）</li>
                  <li><kbd>Alt</kbd>+<kbd>←</kbd><kbd>→</kbd> 调整起点</li>
                  <li><kbd>Ctrl</kbd>+<kbd>←</kbd><kbd>→</kbd> 调整终点</li>
                  <li><kbd>L</kbd> 锁定 / 解锁选中章节（连锁移动的固定止点，仅当前会话）</li>
                  <li><kbd>Delete</kbd> 删除选中章节</li>
                  <li>滚轮：缩放波形；拖拽空白：创建章节</li>
                </ul>
              </div>
            </aside>
          </div>
        </>
      )}
      <ImportDialog
        preview={importPreview}
        fileName={importFileName}
        parseError={importError}
        duration={duration}
        onApply={applyImport}
        onClose={closeImportDialog}
      />
    </div>
  );
}
