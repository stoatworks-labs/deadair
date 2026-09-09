import type { FrameRange, Fps, TrackMode } from '../types'
import { framesToRational, isDropFrameCapable, nominalFps } from './timecode'

export interface FcpxmlOptions {
  projectName: string
  fileName: string
  /** Folder the file lives in, used to build the file:// URL. Empty = filename only. */
  mediaFolder: string
  keeps: FrameRange[]
  /** Total length of the source, in frames. */
  sourceFrames: number
  fps: Fps
  dropFrame: boolean
  sourceStartFrames: number
  recordStartFrames: number
  width: number | null
  height: number | null
  hasVideo: boolean
  hasAudio: boolean
  audioRate: number | null
  audioChannels: number | null
  tracks: TrackMode
}

/**
 * FCPXML 1.10 with one asset and one asset-clip per kept span on the spine.
 * Carries the media path, so an import can relink without a bin search, and it
 * is what Premiere and Final Cut want too. Time values are exact rationals in
 * the frame rate's own units — never decimals, which FCPXML rejects as drift.
 */
export function buildFcpxml(o: FcpxmlOptions): string {
  const fd = `${o.fps.den}/${o.fps.num}s`
  const df = o.dropFrame && isDropFrameCapable(o.fps)
  const tcFormat = df ? 'DF' : 'NDF'
  const size =
    o.width && o.height ? ` width="${o.width}" height="${o.height}"` : o.hasVideo ? ' width="1920" height="1080"' : ''
  const formatName = `FFVideoFormat${o.height ?? 1080}p${nominalFps(o.fps)}`
  const src = fileUrl(o.mediaFolder, o.fileName)
  const wantVideo = o.tracks !== 'AA' && o.hasVideo
  const wantAudio = o.tracks !== 'V' && o.hasAudio
  const audioAttrs = o.hasAudio
    ? ` audioSources="1"${o.audioChannels ? ` audioChannels="${o.audioChannels}"` : ''}${
        o.audioRate ? ` audioRate="${rateToken(o.audioRate)}"` : ''
      }`
    : ''
  const total = o.keeps.reduce((a, k) => a + (k.end - k.start), 0)

  const clips: string[] = []
  let rec = o.recordStartFrames
  o.keeps.forEach((k, idx) => {
    const len = k.end - k.start
    clips.push(
      `        <asset-clip ref="r2" name="${esc(o.fileName)} ${idx + 1}" offset="${framesToRational(rec, o.fps)}" ` +
        `start="${framesToRational(o.sourceStartFrames + k.start, o.fps)}" duration="${framesToRational(len, o.fps)}" ` +
        `format="r1" tcFormat="${tcFormat}"${wantVideo ? '' : ' enabled="0"'}${wantAudio ? ' audioRole="dialogue"' : ''}/>`,
    )
    rec += len
  })

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE fcpxml>\n` +
    `<fcpxml version="1.10">\n` +
    `  <resources>\n` +
    `    <format id="r1" name="${formatName}" frameDuration="${fd}"${size}/>\n` +
    `    <asset id="r2" name="${esc(o.fileName)}" start="${framesToRational(o.sourceStartFrames, o.fps)}" ` +
    `duration="${framesToRational(o.sourceFrames, o.fps)}" hasVideo="${o.hasVideo ? 1 : 0}" hasAudio="${o.hasAudio ? 1 : 0}" ` +
    `format="r1"${audioAttrs}>\n` +
    `      <media-rep kind="original-media" src="${esc(src)}"/>\n` +
    `    </asset>\n` +
    `  </resources>\n` +
    `  <library>\n` +
    `    <event name="deadair">\n` +
    `      <project name="${esc(o.projectName)}">\n` +
    `        <sequence format="r1" duration="${framesToRational(total, o.fps)}" tcStart="${framesToRational(
      o.recordStartFrames,
      o.fps,
    )}" tcFormat="${tcFormat}" audioLayout="stereo" audioRate="${o.audioRate ? rateToken(o.audioRate) : '48k'}">\n` +
    `          <spine>\n` +
    clips.map((c) => '    ' + c).join('\n') +
    `\n          </spine>\n` +
    `        </sequence>\n` +
    `      </project>\n` +
    `    </event>\n` +
    `  </library>\n` +
    `</fcpxml>\n`
  )
}

/** FCPXML spells sample rates as "48k", "44.1k", never as a number. */
export function rateToken(rate: number): string {
  const k = rate / 1000
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
}

export function fileUrl(folder: string, name: string): string {
  const trimmed = folder.trim()
  if (!trimmed) return encodeURIComponent(name)
  const withSlash = trimmed.endsWith('/') || trimmed.endsWith('\\') ? trimmed : trimmed + '/'
  const posix = withSlash.replace(/\\/g, '/')
  const path = posix.startsWith('/') ? posix : '/' + posix
  return 'file://' + path.split('/').map(encodeURIComponent).join('/') + encodeURIComponent(name)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
