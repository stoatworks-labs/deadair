import { DB_FLOOR } from '../types'
import type { DetectParams, DetectResult, Envelope, FrameRange, Fps, Range } from '../types'
import { fpsValue, secondsToFrames } from './timecode'

export const DEFAULT_PARAMS: DetectParams = {
  thresholdDb: -40,
  minSilenceMs: 500,
  preHeadMs: 100,
  postTailMs: 150,
  minKeepMs: 0,
  trimEnds: true,
}

/**
 * Reduce decoded audio to one loudness value per hop. RMS per channel, then the
 * loudest channel wins — a hot mic on one side must count as speech even if the
 * other side is quiet. Runs over 16 kHz audio in well under a second per hour.
 */
export function computeEnvelope(channels: Float32Array[], sampleRate: number, hopMs = 10): Envelope {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  const length = channels[0]?.length ?? 0
  const bins = Math.ceil(length / hop)
  const db = new Float32Array(bins)
  const peak = new Float32Array(bins)
  for (let b = 0; b < bins; b++) {
    const from = b * hop
    const to = Math.min(length, from + hop)
    let bestRms = 0
    let bestPeak = 0
    for (const ch of channels) {
      let sum = 0
      let pk = 0
      for (let i = from; i < to; i++) {
        const v = ch[i]
        sum += v * v
        const a = v < 0 ? -v : v
        if (a > pk) pk = a
      }
      const rms = Math.sqrt(sum / Math.max(1, to - from))
      if (rms > bestRms) bestRms = rms
      if (pk > bestPeak) bestPeak = pk
    }
    db[b] = bestRms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(bestRms)) : DB_FLOOR
    peak[b] = bestPeak
  }
  return {
    hopSec: hop / sampleRate,
    db,
    peak,
    duration: length / sampleRate,
    sampleRate,
    channels: channels.length,
  }
}

/**
 * Find the silences. The steps, in order, because the order is the behaviour:
 *
 *  1. Runs of bins below the threshold.
 *  2. Drop runs shorter than minSilence — a breath between words is not a cut.
 *  3. Shrink each run by postTail at its start and preHead at its end, so the
 *     cut never touches speech. Runs that touch the file edges are only padded
 *     on the side that faces speech.
 *  4. Runs at the edges go entirely if trimEnds is off.
 *  5. Kept islands shorter than minKeep are swallowed by their neighbours, and
 *     the touching silences merge.
 */
export function detectSilence(env: Envelope, p: DetectParams): DetectResult {
  const { db, hopSec, duration } = env
  const n = db.length
  if (n === 0 || duration <= 0) return { silences: [], keeps: [] }

  const minSilence = p.minSilenceMs / 1000
  const preHead = Math.max(0, p.preHeadMs) / 1000
  const postTail = Math.max(0, p.postTailMs) / 1000
  const minKeep = Math.max(0, p.minKeepMs) / 1000

  // 1 + 2: raw quiet runs.
  const raw: Range[] = []
  let i = 0
  while (i < n) {
    if (db[i] >= p.thresholdDb) {
      i++
      continue
    }
    let j = i
    while (j < n && db[j] < p.thresholdDb) j++
    const start = i * hopSec
    const end = j === n ? duration : j * hopSec
    if (end - start >= minSilence) raw.push({ start, end })
    i = j
  }

  // 3 + 4: padding and the edges.
  const eps = hopSec / 2
  let silences: Range[] = []
  for (const r of raw) {
    const atStart = r.start <= eps
    const atEnd = r.end >= duration - eps
    if ((atStart || atEnd) && !p.trimEnds) continue
    const start = atStart ? 0 : r.start + postTail
    const end = atEnd ? duration : r.end - preHead
    if (end - start > eps) silences.push({ start, end })
  }

  // 5: swallow tiny islands.
  if (minKeep > 0 && silences.length > 0) {
    let keeps = complement(silences, duration)
    const before = keeps.length
    keeps = keeps.filter((k) => k.end - k.start >= minKeep)
    if (keeps.length !== before) silences = complement(keeps, duration)
  }

  return { silences, keeps: complement(silences, duration) }
}

/** The gaps between sorted, non-overlapping ranges over [0, duration]. */
export function complement(ranges: Range[], duration: number): Range[] {
  const out: Range[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (cursor < duration) out.push({ start: cursor, end: duration })
  return out
}

/**
 * Seconds -> whole frames, erring on the side of keeping: a kept span starts on
 * the frame containing its start and ends on the frame after its end. Adjacent
 * spans are pushed apart rather than allowed to overlap, and empty ones vanish.
 */
export function quantiseKeeps(keeps: Range[], fps: Fps, duration: number): FrameRange[] {
  const lastFrame = Math.max(1, secondsToFrames(duration, fps, 'ceil'))
  const out: FrameRange[] = []
  let prevEnd = 0
  for (const k of keeps) {
    let start = Math.max(prevEnd, secondsToFrames(k.start, fps, 'floor'))
    let end = Math.min(lastFrame, secondsToFrames(k.end, fps, 'ceil'))
    if (end <= start) continue
    out.push({ start, end })
    prevEnd = end
  }
  return out
}

/** The frame spans between kept spans — what a marker list describes. */
export function frameGaps(keeps: FrameRange[], fps: Fps, duration: number): FrameRange[] {
  const lastFrame = Math.max(1, secondsToFrames(duration, fps, 'ceil'))
  const out: FrameRange[] = []
  let cursor = 0
  for (const k of keeps) {
    if (k.start > cursor) out.push({ start: cursor, end: k.start })
    cursor = k.end
  }
  if (cursor < lastFrame) out.push({ start: cursor, end: lastFrame })
  return out
}

export interface Stats {
  silenceCount: number
  removedSec: number
  keptSec: number
  removedPct: number
}

export function stats(result: DetectResult, duration: number): Stats {
  const removedSec = result.silences.reduce((a, r) => a + (r.end - r.start), 0)
  const keptSec = Math.max(0, duration - removedSec)
  return {
    silenceCount: result.silences.length,
    removedSec,
    keptSec,
    removedPct: duration > 0 ? (100 * removedSec) / duration : 0,
  }
}

export function frameRangeSeconds(r: FrameRange, fps: Fps): Range {
  const v = fpsValue(fps)
  return { start: r.start / v, end: r.end / v }
}
