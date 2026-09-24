/**
 * 连锁移动（Chain Move）纯函数。
 *
 * 开启连锁模式后，拖动一个未锁定章节（或向右缩放其右边缘）时，编辑产生的
 * 边界位移会原样传递给其后的所有未锁定章节——章间间隔与各章时长保持不变，
 * 整体像一串刚性滑块。传递在遇到下列止点时停止，整次操作被钳制在可行范围内：
 *
 *   - 其后第一个锁定章节（其起点即右向边界）；
 *   - 音频结尾；
 *   - 向左则是最近的前序章节末端（锁定/未锁定均不可穿越）或音频开头。
 *
 * 任何情况下结果都不会产生重叠。锁定章节本身不能被移动或缩放（任何模式下）。
 * 关闭连锁模式时 run 只含被编辑章节自身，行为退化为普通单章编辑，但仍复用
 * 同一套钳制与原因判定，以便 UI 统一提示。
 */
import type { Chapter } from '../types';
import { clamp } from './time';
import { MIN_CHAPTER_DURATION, sorted } from './chapterOps';
import { snapToValue } from './snap';

const EPS = 1e-9;
/** 判定“实际位移被钳制”的阈值（秒），低于此视为吸附/浮点误差。 */
const CLIP_EPS = 1e-7;

export type ChainEditKind = 'move' | 'resize-start' | 'resize-end';

export type ChainLimitReason =
  | 'locked-chapter'
  | 'audio-end'
  | 'audio-start'
  | 'neighbor'
  | 'min-duration';

/** 连锁传递的止点。 */
export type ChainStop =
  | { kind: 'locked-chapter'; id: string; title: string }
  | { kind: 'chapter'; id: string; title: string }
  | { kind: 'audio-end' }
  | { kind: 'audio-start' };

export interface ChainEditResult {
  kind: ChainEditKind;
  /** 应用编辑（含连带位移）后的完整章节数组，顺序与输入一致。 */
  chapters: Chapter[];
  /** 实际发生位移的章节 id：被编辑章节 + 被带动的后续章节。 */
  movedIds: string[];
  /** 用户请求的位移（秒，带符号）。 */
  desiredDelta: number;
  /** 钳制后实际生效的位移（秒，带符号）。 */
  delta: number;
  clipped: boolean;
  reason?: ChainLimitReason;
  stop?: ChainStop;
  /** 钳制发生时，止点边界的时间坐标（用于画布上画“墙”）。 */
  limitAt?: number;
}

export interface ChainPlanChapter {
  id: string;
  title: string;
}

export interface ChainPlan {
  kind: ChainEditKind;
  anchor: ChainPlanChapter;
  /** 会被连带移动的后续未锁定章节（按时间顺序）。 */
  followers: ChainPlanChapter[];
  /** 向右最多可位移的秒数。 */
  maxForward: number;
  /** 向左最多可位移的秒数（非负）。 */
  maxBackward: number;
  forwardStop: ChainStop;
  backwardStop: ChainStop;
}

interface Run {
  anchor: Chapter;
  followers: Chapter[];
  runIds: Set<string>;
  runEnd: number;
  prevEnd: number;
  prevStop: ChainStop;
  forwardStop: ChainStop;
  /** 右向止点的时间坐标（锁定/相邻章节起点或音频结尾）。 */
  forwardAt: number;
}

function stopOf(c: Chapter, locked: boolean): ChainStop {
  return locked
    ? { kind: 'locked-chapter', id: c.id, title: c.title }
    : { kind: 'chapter', id: c.id, title: c.title };
}

/**
 * 计算以 anchor 为起点的连锁串。follow=false（非连锁模式）时串内只有 anchor，
 * 右向止点是最近的后续章节（无论锁定与否）。
 */
function buildRun(
  chapters: Chapter[],
  locked: ReadonlySet<string>,
  anchor: Chapter,
  duration: number,
  follow: boolean,
): Run {
  const list = sorted(chapters);
  let prev: Chapter | null = null;
  for (const c of list) {
    if (c.id === anchor.id) break;
    if (c.end <= anchor.start + EPS) prev = c;
  }
  const followers: Chapter[] = [];
  let forwardStop: ChainStop = { kind: 'audio-end' };
  let forwardAt = duration;
  let hitLock = false;
  for (const c of list) {
    if (c.start < anchor.end - EPS || c.id === anchor.id) continue;
    if (follow) {
      // 第一个锁定章节之后的未锁定章节也不参与连锁
      if (hitLock) break;
      if (locked.has(c.id)) {
        forwardStop = { kind: 'locked-chapter', id: c.id, title: c.title };
        forwardAt = c.start;
        hitLock = true;
        break;
      }
      followers.push(c);
    } else {
      forwardStop = stopOf(c, locked.has(c.id));
      forwardAt = c.start;
      break;
    }
  }
  const last = followers[followers.length - 1];
  const runEnd = last ? last.end : anchor.end;
  const runIds = new Set<string>([anchor.id, ...followers.map((c) => c.id)]);
  return {
    anchor,
    followers,
    runIds,
    runEnd,
    prevEnd: prev ? prev.end : 0,
    prevStop: prev ? stopOf(prev, locked.has(prev.id)) : { kind: 'audio-start' },
    forwardStop,
    forwardAt,
  };
}

/** 静态吸附目标：音频首尾 + 所有不随本次操作移动的章节边界。 */
function staticTargets(
  chapters: Chapter[],
  runIds: Set<string>,
  duration: number,
): number[] {
  const targets = [0, duration];
  for (const c of chapters) {
    if (runIds.has(c.id)) continue;
    targets.push(c.start, c.end);
  }
  return targets;
}

function forwardReason(stop: ChainStop): ChainLimitReason {
  return stop.kind === 'locked-chapter'
    ? 'locked-chapter'
    : stop.kind === 'audio-end'
      ? 'audio-end'
      : 'neighbor';
}

function backwardReason(stop: ChainStop): ChainLimitReason {
  return stop.kind === 'locked-chapter'
    ? 'locked-chapter'
    : stop.kind === 'audio-start'
      ? 'audio-start'
      : 'neighbor';
}

function shiftChapter(c: Chapter, delta: number): Chapter {
  return { ...c, start: c.start + delta, end: c.end + delta };
}

/** 把按 id 计算好的位移应用回原数组（保持数组顺序与未涉及章节引用不变）。 */
function applyShifts(
  chapters: Chapter[],
  shifts: Map<string, number>,
): Chapter[] {
  return chapters.map((c) => (shifts.has(c.id) ? shiftChapter(c, shifts.get(c.id)!) : c));
}

/**
 * 应用一次“整串平移”结果：锚点与所有被带动章节统一加 delta。
 * resize-end 时锚点起点固定（只有终点变化），其余情况锚点整体平移。
 */
function resultFromDelta(
  kind: ChainEditKind,
  chapters: Chapter[],
  run: Run,
  desiredDelta: number,
  delta: number,
  minDelta: number,
  maxDelta: number,
): ChainEditResult {
  const shifts = new Map<string, number>();
  if (kind !== 'resize-end') shifts.set(run.anchor.id, delta);
  for (const f of run.followers) shifts.set(f.id, delta);
  let out = applyShifts(chapters, shifts);
  if (kind === 'resize-end') {
    // 锚点起点不动，终点跟随 delta
    out = out.map((c) =>
      c.id === run.anchor.id ? { ...c, start: run.anchor.start, end: run.anchor.end + delta } : c,
    );
  }
  const clipped = Math.abs(delta - desiredDelta) > CLIP_EPS;
  let reason: ChainLimitReason | undefined;
  let stop: ChainStop | undefined;
  let limitAt: number | undefined;
  if (clipped) {
    if (delta >= maxDelta - CLIP_EPS) {
      reason = forwardReason(run.forwardStop);
      stop = run.forwardStop;
      limitAt = run.forwardAt;
    } else if (delta <= minDelta + CLIP_EPS) {
      reason = backwardReason(run.prevStop);
      stop = run.prevStop;
      limitAt = run.prevEnd;
    }
  }
  return {
    kind,
    chapters: out,
    movedIds: [run.anchor.id, ...run.followers.map((c) => c.id)],
    desiredDelta,
    delta,
    clipped,
    reason,
    stop,
    limitAt,
  };
}

/**
 * 移动整章（保持时长）。follow=true 时连带其后未锁定章节整体平移。
 * 锚点章节被锁定或不存在时返回 null（调用方据此提示“章节已锁定”）。
 */
export function chainMoveChapter(
  chapters: Chapter[],
  locked: ReadonlySet<string>,
  id: string,
  desiredStart: number,
  duration: number,
  snapThreshold: number,
  follow: boolean,
): ChainEditResult | null {
  const anchor = chapters.find((c) => c.id === id);
  if (!anchor || locked.has(id)) return null;
  const run = buildRun(chapters, locked, anchor, duration, follow);

  // 吸附串的左右边缘（与普通 move 一致：哪边近吸哪边），再做可行域钳制
  const runLen = run.runEnd - anchor.start;
  const targets = staticTargets(chapters, run.runIds, duration);
  let start = desiredStart;
  const snappedStart = snapToValue(start, targets, snapThreshold);
  const snappedEndRaw = snapToValue(start + runLen, targets, snapThreshold);
  const startSnapped = snappedStart !== start;
  const endSnapped = snappedEndRaw !== start + runLen;
  if (startSnapped || endSnapped) {
    const snappedEnd = snappedEndRaw - runLen;
    const dStart = startSnapped ? Math.abs(snappedStart - start) : Infinity;
    const dEnd = endSnapped ? Math.abs(snappedEnd - start) : Infinity;
    start = dStart <= dEnd ? snappedStart : snappedEnd;
  }
  const desiredDelta = start - anchor.start;
  const maxDelta = run.forwardAt - run.runEnd;
  const minDelta = run.prevEnd - anchor.start;
  const delta = clamp(desiredDelta, minDelta, maxDelta);
  return resultFromDelta('move', chapters, run, desiredDelta, delta, minDelta, maxDelta);
}

/**
 * 调整章节边缘。
 * - edge='end'：右边缘的位移按 follow 传递给后续未锁定章节（间隔/时长不变）；
 * - edge='start'：只移动本章节起点，任何模式下都不产生向后的连带
 *   （后随间隔的保持由右边缘连锁负责；移动起点会改变与前序章节的间隔）。
 */
export function chainResizeChapter(
  chapters: Chapter[],
  locked: ReadonlySet<string>,
  id: string,
  edge: 'start' | 'end',
  desired: number,
  duration: number,
  snapThreshold: number,
  follow: boolean,
): ChainEditResult | null {
  const anchor = chapters.find((c) => c.id === id);
  if (!anchor || locked.has(id)) return null;

  if (edge === 'start') {
    // 起点调整始终只作用于本章节：不跨越前序章节，不短于最小时长。
    // 无 follow 串，右向“止点”即本章节最小时长起点。
    const list = sorted(chapters);
    let prev: Chapter | null = null;
    for (const c of list) {
      if (c.id === id) break;
      if (c.end <= anchor.start + EPS) prev = c;
    }
    const prevEnd = prev ? prev.end : 0;
    const prevStop: ChainStop = prev
      ? stopOf(prev, locked.has(prev.id))
      : { kind: 'audio-start' };
    const targets = staticTargets(chapters, new Set([id]), duration);
    const snapped = snapToValue(desired, targets, snapThreshold);
    const minStart = prevEnd;
    const maxStart = anchor.end - MIN_CHAPTER_DURATION;
    const start = clamp(snapped, minStart, maxStart);
    const desiredDelta = desired - anchor.start;
    const delta = start - anchor.start;
    const clipped = Math.abs(delta - desiredDelta) > CLIP_EPS;
    let reason: ChainLimitReason | undefined;
    let stop: ChainStop | undefined;
    let limitAt: number | undefined;
    if (clipped) {
      if (snapped > maxStart + CLIP_EPS) {
        // 吸附后仍想越过最短时长边界（无论该边界是否也贴着前序章节）
        reason = 'min-duration';
        limitAt = maxStart;
      } else {
        reason = backwardReason(prevStop);
        stop = prevStop;
        limitAt = prevEnd;
      }
    }
    return {
      kind: 'resize-start',
      chapters: chapters.map((c) => (c.id === id ? { ...c, start } : c)),
      movedIds: [id],
      desiredDelta,
      delta,
      clipped,
      reason,
      stop,
      limitAt,
    };
  }

  // edge='end'：锚点起点固定，右边缘位移连带后续未锁定章节
  const run = buildRun(chapters, locked, anchor, duration, follow);
  const targets = staticTargets(chapters, run.runIds, duration);
  const runTail = run.runEnd - anchor.end; // 锚点末端到串末端的距离
  const snappedEnd = snapToValue(desired, targets, snapThreshold);
  const snappedTailRaw = snapToValue(desired + runTail, targets, snapThreshold);
  const endSnapped = snappedEnd !== desired;
  const tailSnapped = snappedTailRaw !== desired + runTail;
  let desiredDelta = desired - anchor.end;
  if (endSnapped || tailSnapped) {
    const dEnd = endSnapped ? Math.abs(snappedEnd - desired) : Infinity;
    const dTail = tailSnapped ? Math.abs(snappedTailRaw - runTail - desired) : Infinity;
    desiredDelta = dEnd <= dTail ? snappedEnd - anchor.end : snappedTailRaw - runTail - anchor.end;
  }
  // 锚点可缩到最短；串末端可推到止点
  const maxDelta = run.forwardAt - run.runEnd;
  const minDelta = -(anchor.end - anchor.start - MIN_CHAPTER_DURATION);
  const delta = clamp(desiredDelta, minDelta, maxDelta);
  const r = resultFromDelta('resize-end', chapters, run, desiredDelta, delta, minDelta, maxDelta);
  // 吸附后仍想继续缩短时，下边界是最短时长而非“前序章节”
  if (r.clipped && desiredDelta <= minDelta + CLIP_EPS) {
    r.reason = 'min-duration';
    r.stop = undefined;
    r.limitAt = run.anchor.start + MIN_CHAPTER_DURATION;
  }
  return r;
}

/**
 * 连锁预览方案（不落盘任何修改）：供 UI 在拖拽前/拖拽中显示
 * “将带动哪些章节、止点是什么、两侧各有多少空间”。
 */
export function planChainEdit(
  chapters: Chapter[],
  locked: ReadonlySet<string>,
  id: string,
  duration: number,
  kind: ChainEditKind,
): ChainPlan | null {
  const anchor = chapters.find((c) => c.id === id);
  if (!anchor || locked.has(id)) return null;
  const follow = kind !== 'resize-start';
  const run = buildRun(chapters, locked, anchor, duration, follow);
  const maxForward = Math.max(0, run.forwardAt - run.runEnd);
  const maxBackward =
    kind === 'resize-end'
      ? anchor.end - anchor.start - MIN_CHAPTER_DURATION
      : Math.max(0, anchor.start - run.prevEnd);
  return {
    kind,
    anchor: { id: anchor.id, title: anchor.title },
    followers: run.followers.map((c) => ({ id: c.id, title: c.title })),
    maxForward,
    maxBackward,
    forwardStop: run.forwardStop,
    backwardStop: run.prevStop,
  };
}

/** 止点的人类可读描述。 */
export function stopLabel(stop: ChainStop): string {
  switch (stop.kind) {
    case 'locked-chapter':
      return `锁定章节「${stop.title}」`;
    case 'chapter':
      return `章节「${stop.title}」`;
    case 'audio-end':
      return '音频结尾';
    case 'audio-start':
      return '音频开头';
  }
}

/** 钳制原因的提示文案。 */
export function describeLimit(reason: ChainLimitReason, stop?: ChainStop): string {
  switch (reason) {
    case 'locked-chapter':
      return `已到达${stop ? stopLabel(stop) : '锁定章节'}边界，连锁移动到此为止，未产生重叠`;
    case 'audio-end':
      return '已到达音频结尾，操作已限制在可行范围内';
    case 'audio-start':
      return '已到达音频开头，操作已限制在可行范围内';
    case 'neighbor':
      return stop && (stop.kind === 'chapter' || stop.kind === 'locked-chapter')
        ? `已到达相邻章节「${stop.title}」边界，继续会产生重叠`
        : '继续移动会与相邻章节重叠，操作已限制在可行范围内';
    case 'min-duration':
      return `章节时长不能短于 ${MIN_CHAPTER_DURATION.toFixed(1)} 秒`;
  }
}

/** 锁定章节自身被尝试编辑时的提示。 */
export function describeLockedAnchor(title?: string): string {
  return title
    ? `章节「${title}」已锁定，请先解锁再移动或调整边界`
    : '该章节已锁定，请先解锁再移动或调整边界';
}
