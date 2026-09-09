import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny'
import type { InputAudioTrack, InputVideoTrack, Quality } from 'mediabunny'
import type { FrameRange, Fps } from '../types'
import { fpsValue } from './timecode'
import { audioFramesInSegment, planSegments, totalDuration, videoFrameInSegment } from './rendermath'
import type { Segment } from './rendermath'

/**
 * The in-browser render: the same kept spans the EDL describes, decoded with
 * the browser's own codecs, re-encoded with its hardware encoder, and muxed to
 * an MP4 that streams straight to disk. No wasm, no 30 MB download, and a
 * 30-minute file takes minutes rather than the hour x264-in-wasm would want.
 *
 * What it cannot do is decode what the browser cannot: ProRes in Chromium,
 * MXF anywhere. Those still go through the ffmpeg command.
 */

export type RenderQuality = 'medium' | 'high' | 'very-high'

export interface RenderProgress {
  /** 0..1 of the kept duration processed. */
  fraction: number
  /** Seconds of kept material processed so far. */
  processedSec: number
  totalSec: number
  /** Kept frames encoded per wall-clock second, once there is enough data to say. */
  fps: number | null
  stage: string
}

export interface RenderOptions {
  file: File
  keeps: FrameRange[]
  fps: Fps
  wantVideo: boolean
  wantAudio: boolean
  quality: RenderQuality
  /** A stream to write to (File System Access), or null to build the file in memory. */
  writable: WritableStream | null
  onProgress: (p: RenderProgress) => void
  signal: AbortSignal
}

export interface RenderResult {
  /** The whole file, when it was built in memory. Null when it streamed to disk. */
  blob: Blob | null
  bytes: number
  durationSec: number
  wallSec: number
  video: string | null
  audio: string | null
}

export class RenderUnsupported extends Error {}

const QUALITIES: Record<RenderQuality, Quality> = {
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  'very-high': QUALITY_VERY_HIGH,
}

export interface Probe {
  video: { codec: string | null; width: number; height: number; decodable: boolean } | null
  audio: { codec: string | null; sampleRate: number; channels: number; decodable: boolean } | null
  canEncodeVideo: boolean
  canEncodeAudio: boolean
  reason: string | null
}

/** What the browser can do with this file, before anyone presses Render. */
export async function probeRender(file: File): Promise<Probe> {
  if (typeof VideoDecoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    return { video: null, audio: null, canEncodeVideo: false, canEncodeAudio: false, reason: 'This browser has no WebCodecs. Chrome, Edge or a recent Safari can render here; otherwise use the ffmpeg command.' }
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    if (!(await input.canRead())) {
      return { video: null, audio: null, canEncodeVideo: false, canEncodeAudio: false, reason: 'The container is not one the browser render can read (MP4, MOV, MKV, WebM, WAV, MP3, FLAC, AAC). Use the ffmpeg command.' }
    }
    const v = await input.getPrimaryVideoTrack()
    const a = await input.getPrimaryAudioTrack()
    const probe: Probe = {
      video: v ? { codec: v.codec, width: v.displayWidth, height: v.displayHeight, decodable: await v.canDecode() } : null,
      audio: a ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.numberOfChannels, decodable: await a.canDecode() } : null,
      canEncodeVideo: await canEncodeVideo('avc'),
      canEncodeAudio: await canEncodeAudio('aac'),
      reason: null,
    }
    if (!probe.video && !probe.audio) probe.reason = 'No video or audio track the browser can see.'
    else if (probe.video && !probe.video.decodable) probe.reason = `The browser cannot decode this video (${probe.video.codec ?? 'unknown codec'} — ProRes and DNx are the usual reasons). Use the ffmpeg command.`
    else if (probe.audio && !probe.audio.decodable) probe.reason = `The browser cannot decode this audio (${probe.audio.codec ?? 'unknown codec'}). Use the ffmpeg command.`
    else if (probe.video && !probe.canEncodeVideo) probe.reason = 'The browser has no H.264 encoder available.'
    else if (probe.audio && !probe.canEncodeAudio) probe.reason = 'The browser has no AAC encoder available.'
    return probe
  } finally {
    input.dispose()
  }
}

export async function renderCut(o: RenderOptions): Promise<RenderResult> {
  const segments = planSegments(o.keeps, o.fps)
  const totalSec = totalDuration(segments)
  if (segments.length === 0) throw new RenderUnsupported('Nothing to keep.')
  const t0 = performance.now()

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(o.file) })
  const vTrack = o.wantVideo ? await input.getPrimaryVideoTrack() : null
  const aTrack = o.wantAudio ? await input.getPrimaryAudioTrack() : null
  if (!vTrack && !aTrack) throw new RenderUnsupported('No track to render.')
  if (vTrack && !(await vTrack.canDecode())) throw new RenderUnsupported(`The browser cannot decode this video (${vTrack.codec ?? 'unknown codec'}).`)
  if (aTrack && !(await aTrack.canDecode())) throw new RenderUnsupported(`The browser cannot decode this audio (${aTrack.codec ?? 'unknown codec'}).`)

  const target = o.writable ? new StreamTarget(o.writable, { chunked: true }) : new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target })

  let vSource: VideoSampleSource | null = null
  let aSource: AudioSampleSource | null = null
  if (vTrack) {
    vSource = new VideoSampleSource({
      codec: 'avc',
      bitrate: QUALITIES[o.quality],
      hardwareAcceleration: 'no-preference',
      latencyMode: 'quality',
      keyFrameInterval: 2,
    })
    output.addVideoTrack(vSource, { frameRate: fpsValue(o.fps), rotation: await vTrack.getRotation() })
  }
  if (aTrack) {
    aSource = new AudioSampleSource({ codec: 'aac', bitrate: 192_000 })
    output.addAudioTrack(aSource)
  }

  const abort = () => {
    void output.cancel()
  }
  o.signal.addEventListener('abort', abort, { once: true })
  const throwIfAborted = () => {
    if (o.signal.aborted) throw new DOMException('Render cancelled', 'AbortError')
  }

  let processedSec = 0
  let framesDone = 0
  let lastReport = 0
  const report = (stage: string, extra = 0) => {
    const now = performance.now()
    if (now - lastReport < 120 && extra === 0) return
    lastReport = now
    const wall = (now - t0) / 1000
    o.onProgress({
      fraction: Math.min(1, (processedSec + extra) / totalSec),
      processedSec: processedSec + extra,
      totalSec,
      fps: wall > 1 && framesDone > 0 ? framesDone / wall : null,
      stage,
    })
  }

  try {
    await output.start()
    report('Starting')
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const label = `Span ${i + 1} of ${segments.length}`
      if (vTrack && vSource) {
        framesDone += await copyVideo(vTrack, vSource, seg, o.fps, (done) => report(label, done), throwIfAborted)
      }
      if (aTrack && aSource) {
        await copyAudio(aTrack, aSource, seg, throwIfAborted)
      }
      processedSec += seg.end - seg.start
      report(label, 0)
    }
    report('Finishing the file', 0)
    await output.finalize()
  } catch (e) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => {})
    throw e
  } finally {
    o.signal.removeEventListener('abort', abort)
    input.dispose()
  }

  const blob = target instanceof BufferTarget && target.buffer ? new Blob([target.buffer], { type: 'video/mp4' }) : null
  return {
    blob,
    bytes: blob ? blob.size : bytesWritten(target),
    durationSec: totalSec,
    wallSec: (performance.now() - t0) / 1000,
    video: vTrack ? 'H.264' : null,
    audio: aTrack ? 'AAC 192 kb/s' : null,
  }
}

async function copyVideo(
  track: InputVideoTrack,
  source: VideoSampleSource,
  seg: Segment,
  fps: Fps,
  onDone: (secondsIntoSegment: number) => void,
  throwIfAborted: () => void,
): Promise<number> {
  const sink = new VideoSampleSink(track, { hardwareAcceleration: 'no-preference' })
  const frameDur = 1 / fpsValue(fps)
  let count = 0
  // A little before the start, so a frame whose timestamp is a rounding hair
  // early is still seen; videoFrameInSegment does the real gate.
  for await (const sample of sink.samples(Math.max(0, seg.start - frameDur), seg.end)) {
    try {
      throwIfAborted()
      if (!videoFrameInSegment(sample.timestamp, seg, fps)) continue
      const outTs = seg.outOffset + (sample.timestamp - seg.start)
      sample.setTimestamp(Math.max(0, outTs))
      if (!(sample.duration > 0)) sample.setDuration(frameDur)
      await source.add(sample)
      count++
      if (count % 5 === 0) onDone(sample.timestamp - seg.outOffset)
    } finally {
      sample.close()
    }
  }
  return count
}

async function copyAudio(track: InputAudioTrack, source: AudioSampleSource, seg: Segment, throwIfAborted: () => void): Promise<void> {
  const sink = new AudioSampleSink(track)
  for await (const sample of sink.samples(seg.start, seg.end)) {
    try {
      throwIfAborted()
      const range = audioFramesInSegment(sample.timestamp, sample.numberOfFrames, sample.sampleRate, seg)
      if (!range) continue
      const [from, to] = range
      const piece = from === 0 && to === sample.numberOfFrames ? sample.clone() : sample.trim(from, to)
      try {
        piece.setTimestamp(Math.max(0, seg.outOffset + (piece.timestamp - seg.start)))
        await source.add(piece)
      } finally {
        piece.close()
      }
    } finally {
      sample.close()
    }
  }
}

function bytesWritten(target: StreamTarget | BufferTarget): number {
  const t = target as unknown as { _writer?: { _position?: number }; _bytesWritten?: number }
  return t._bytesWritten ?? t._writer?._position ?? 0
}

/** The output name beside the input, never over it. */
export function renderedName(inputName: string, video: boolean): string {
  const stem = inputName.replace(/\.[^.]+$/, '') || 'output'
  return `${stem}-stripped.${video ? 'mp4' : 'm4a'}`
}

/**
 * Ask for a place to save. Returns the stream, or null when the browser has no
 * picker (the caller falls back to an in-memory file and a download). Throws
 * AbortError when the user cancels the dialog.
 */
export async function pickSaveStream(suggestedName: string): Promise<WritableStream | null> {
  const w = window as unknown as {
    showSaveFilePicker?: (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableStream> }>
  }
  if (!w.showSaveFilePicker) return null
  const handle = await w.showSaveFilePicker({
    suggestedName,
    types: [{ description: suggestedName.endsWith('.m4a') ? 'MPEG-4 audio' : 'MPEG-4 video', accept: { 'video/mp4': ['.mp4', '.m4a'] } }],
  })
  return handle.createWritable()
}
