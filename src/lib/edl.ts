import type { FrameRange, Fps, TrackMode } from '../types'
import { framesToTc, isDropFrameCapable } from './timecode'

export interface CutEdlOptions {
  title: string
  /** The clip's name in the media pool, written as FROM CLIP NAME so Resolve can find it. */
  clipName: string
  /** CMX reel name, 8 characters at most. */
  reel: string
  keeps: FrameRange[]
  fps: Fps
  dropFrame: boolean
  /** Source timecode of the file's first frame, in frames. */
  sourceStartFrames: number
  /** Where the first kept span lands on the timeline, in frames. */
  recordStartFrames: number
  tracks: TrackMode
}

/**
 * A CMX3600 cut list: one event per kept span, laid end to end on the record
 * side, so importing it produces the ripple-deleted timeline. Resolve reads the
 * FROM CLIP NAME comment to find the clip in the bin when reel matching is off.
 */
export function buildCutEdl(o: CutEdlOptions): string {
  const df = o.dropFrame && isDropFrameCapable(o.fps)
  const lines: string[] = [`TITLE: ${sanitiseTitle(o.title)}`, `FCM: ${df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, '']
  let rec = o.recordStartFrames
  const width = Math.max(3, String(o.keeps.length).length)
  o.keeps.forEach((k, idx) => {
    const len = k.end - k.start
    const srcIn = framesToTc(o.sourceStartFrames + k.start, o.fps, df)
    const srcOut = framesToTc(o.sourceStartFrames + k.end, o.fps, df)
    const recIn = framesToTc(rec, o.fps, df)
    const recOut = framesToTc(rec + len, o.fps, df)
    lines.push(eventLine(idx + 1, width, o.reel, o.tracks, srcIn, srcOut, recIn, recOut))
    lines.push(`* FROM CLIP NAME: ${o.clipName}`)
    lines.push('')
    rec += len
  })
  return lines.join('\n') + '\n'
}

export const MARKER_COLORS = [
  'Blue',
  'Cyan',
  'Green',
  'Yellow',
  'Red',
  'Pink',
  'Purple',
  'Fuchsia',
  'Rose',
  'Lavender',
  'Sky',
  'Mint',
  'Lemon',
  'Sand',
  'Cocoa',
  'Cream',
] as const
export type MarkerColor = (typeof MARKER_COLORS)[number]

export interface MarkerEdlOptions {
  title: string
  /** The spans to mark, in timeline frames relative to the clip's first frame. */
  gaps: FrameRange[]
  fps: Fps
  dropFrame: boolean
  /** Timeline timecode of the clip's first frame, in frames. */
  recordStartFrames: number
  color: MarkerColor
  namePrefix: string
}

/**
 * The EDL Resolve's "Timeline > Import > Timeline Markers from EDL" reads: one
 * one-frame event per marker, with the colour, name and duration in a
 * pipe-delimited comment. This is the review-first route — the timeline is
 * untouched and every silence is a coloured span to step through.
 */
export function buildMarkerEdl(o: MarkerEdlOptions): string {
  const df = o.dropFrame && isDropFrameCapable(o.fps)
  const lines: string[] = [`TITLE: ${sanitiseTitle(o.title)}`, `FCM: ${df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, '']
  const width = Math.max(3, String(o.gaps.length).length)
  o.gaps.forEach((g, idx) => {
    const at = o.recordStartFrames + g.start
    const tcIn = framesToTc(at, o.fps, df)
    const tcOut = framesToTc(at + 1, o.fps, df)
    const n = String(idx + 1).padStart(width, '0')
    lines.push(eventLine(idx + 1, width, n, 'V', tcIn, tcOut, tcIn, tcOut) + '  ')
    lines.push(` |C:ResolveColor${o.color} |M:${sanitiseMarkerName(`${o.namePrefix} ${idx + 1}`)} |D:${g.end - g.start}`)
    lines.push('')
  })
  return lines.join('\n') + '\n'
}

function eventLine(
  n: number,
  width: number,
  reel: string,
  track: string,
  srcIn: string,
  srcOut: string,
  recIn: string,
  recOut: string,
): string {
  const num = String(n).padStart(width, '0')
  return `${num}  ${reel.padEnd(8)} ${track.padEnd(5)} C        ${srcIn} ${srcOut} ${recIn} ${recOut}`
}

/** CMX reel names are 8 characters of upper-case alphanumerics. */
export function reelFromName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '')
  const cleaned = stem.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return (cleaned || 'AX').slice(0, 8)
}

function sanitiseTitle(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 70) || 'deadair'
}

function sanitiseMarkerName(s: string): string {
  return s.replace(/[|\r\n]+/g, ' ')
}
