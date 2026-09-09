import type { FrameRange, Fps } from '../types'
import { fpsValue } from './timecode'

/**
 * The arithmetic behind the in-browser render, kept apart from WebCodecs so it
 * can be tested in Node. Times here are seconds; the same quantised frames the
 * EDL and the ffmpeg command use, so all three cut identically.
 */

export interface Segment {
  /** Source time the kept span starts at. */
  start: number
  /** Source time it ends at (exclusive). */
  end: number
  /** Where its first frame lands in the output. */
  outOffset: number
}

export function planSegments(keeps: FrameRange[], fps: Fps): Segment[] {
  const v = fpsValue(fps)
  const out: Segment[] = []
  let offset = 0
  for (const k of keeps) {
    const start = k.start / v
    const end = k.end / v
    if (end <= start) continue
    out.push({ start, end, outOffset: offset })
    offset += end - start
  }
  return out
}

export function totalDuration(segments: Segment[]): number {
  return segments.reduce((a, s) => a + (s.end - s.start), 0)
}

/** Source time -> output time within a segment. */
export function remap(seg: Segment, sourceTime: number): number {
  return seg.outOffset + (sourceTime - seg.start)
}

/**
 * Which frames of a decoded audio chunk fall inside a segment. Returns the
 * [from, to) frame range within the chunk, or null when none of it does. A
 * chunk straddling the segment start is trimmed at the front, one straddling
 * the end at the back — that is what keeps the cut on the frame rather than
 * on the nearest AAC packet boundary.
 */
export function audioFramesInSegment(
  chunkTimestamp: number,
  chunkFrames: number,
  sampleRate: number,
  seg: Segment,
): [number, number] | null {
  const chunkEnd = chunkTimestamp + chunkFrames / sampleRate
  if (chunkEnd <= seg.start || chunkTimestamp >= seg.end) return null
  const from = Math.max(0, Math.round((seg.start - chunkTimestamp) * sampleRate))
  const to = Math.min(chunkFrames, Math.round((seg.end - chunkTimestamp) * sampleRate))
  return to > from ? [from, to] : null
}

/** A video frame belongs to a segment when its timestamp is inside it, with half a frame of slack at the start. */
export function videoFrameInSegment(timestamp: number, seg: Segment, fps: Fps): boolean {
  const half = 0.5 / fpsValue(fps)
  return timestamp >= seg.start - half && timestamp < seg.end - half
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

export function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '…'
  if (sec < 60) return `${Math.ceil(sec)} s`
  return `${Math.floor(sec / 60)} min ${String(Math.ceil(sec % 60)).padStart(2, '0')} s`
}
