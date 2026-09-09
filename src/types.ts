/**
 * Domain types. Read this first — it is the spec.
 *
 * Times inside the engine are seconds (float) until quantisation, after which
 * they are integer frame counts. Never mix the two in one structure.
 */

/** A frame rate as an exact rational, so 29.97 is 30000/1001 and not 29.97. */
export interface Fps {
  num: number
  den: number
}

export type FpsKey = '23.976' | '24' | '25' | '29.97' | '30' | '48' | '50' | '59.94' | '60'

/** A half-open span in seconds. */
export interface Range {
  start: number
  end: number
}

/** A half-open span in frames: `end` is exclusive, so duration is `end - start`. */
export interface FrameRange {
  start: number
  end: number
}

/**
 * The analysed loudness of a file: one dBFS value per hop. This is all the
 * detector needs, so a decoded file can be dropped as soon as it exists.
 */
export interface Envelope {
  /** Seconds per bin. */
  hopSec: number
  /** RMS level per bin in dBFS, floored at DB_FLOOR. Max across channels. */
  db: Float32Array
  /** Absolute peak per bin (0..1), for the waveform picture only. */
  peak: Float32Array
  /** Total duration in seconds, of the audio actually decoded. */
  duration: number
  sampleRate: number
  channels: number
}

export interface DetectParams {
  /** Below this the bin counts as silent. dBFS, negative. */
  thresholdDb: number
  /** A quiet run shorter than this is not a silence at all. */
  minSilenceMs: number
  /** Keep this much quiet before speech resumes — protects word attacks. */
  preHeadMs: number
  /** Keep this much quiet after speech stops — protects word endings. */
  postTailMs: number
  /** After padding, a kept island shorter than this is dropped into the surrounding cut. 0 = off. */
  minKeepMs: number
  /** Cut the silence at the very start and very end of the file too. */
  trimEnds: boolean
}

export interface DetectResult {
  /** The spans to remove, in seconds. Sorted, non-overlapping, inside [0, duration]. */
  silences: Range[]
  /** The spans to keep. The complement of `silences` over [0, duration]. */
  keeps: Range[]
}

/** What the file's container said about itself, when it is an MP4/MOV. */
export interface MediaMeta {
  /** Frame rate of the first video track, or null for audio-only / unknown. */
  fps: Fps | null
  /** Start timecode from the tmcd track as a frame count at `tcFps`, or null. */
  startTcFrames: number | null
  tcFps: Fps | null
  dropFrame: boolean
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
  audioRate: number | null
  audioChannels: number | null
  /** Length of the video track in seconds, when there is one. Audio and video can differ by a frame or two. */
  videoDuration: number | null
}

export type TrackMode = 'AA/V' | 'V' | 'AA'

export const DB_FLOOR = -100
