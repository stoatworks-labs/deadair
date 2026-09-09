import type { FrameRange, Fps, TrackMode } from '../types'

export interface FfmpegOptions {
  inputName: string
  keeps: FrameRange[]
  fps: Fps
  hasVideo: boolean
  hasAudio: boolean
  tracks: TrackMode
}

/**
 * The no-NLE route: trim every kept span and concat them. Times are the same
 * quantised frames the EDL uses, expressed as exact fractions of the frame
 * rate, rounded to the microsecond, so ffmpeg and Resolve cut on the same frame. Video is re-encoded because
 * a frame-accurate cut cannot land on a keyframe boundary by luck.
 */
export function buildFfmpegCommand(o: FfmpegOptions): string {
  const wantVideo = o.hasVideo && o.tracks !== 'AA'
  const wantAudio = o.hasAudio && o.tracks !== 'V'
  if (o.keeps.length === 0 || (!wantVideo && !wantAudio)) return ''
  const parts: string[] = []
  const labels: string[] = []
  o.keeps.forEach((k, i) => {
    const start = frac(k.start, o.fps)
    const end = frac(k.end, o.fps)
    if (wantVideo) {
      parts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`)
      labels.push(`[v${i}]`)
    }
    if (wantAudio) {
      parts.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`)
      labels.push(`[a${i}]`)
    }
  })
  const outs = `${wantVideo ? '[v]' : ''}${wantAudio ? '[a]' : ''}`
  parts.push(`${labels.join('')}concat=n=${o.keeps.length}:v=${wantVideo ? 1 : 0}:a=${wantAudio ? 1 : 0}${outs}`)
  const maps = `${wantVideo ? ' -map "[v]"' : ''}${wantAudio ? ' -map "[a]"' : ''}`
  const codecs = `${wantVideo ? ' -c:v libx264 -crf 18 -preset medium' : ''}${wantAudio ? ' -c:a aac -b:a 192k' : ''}`
  const out = outputName(o.inputName, wantVideo)
  return `ffmpeg -i ${q(o.inputName)} -filter_complex ${q(parts.join(';'))}${maps}${codecs} ${q(out)}`
}

/**
 * frames / fps as decimal seconds. trim's start/end are durations, and a
 * duration cannot be an expression — "35/25" is rejected outright. Six
 * decimals is a microsecond, four orders below a frame at any rate here.
 */
export function frac(frames: number, fps: Fps): string {
  const sec = (frames * fps.den) / fps.num
  return sec.toFixed(6).replace(/\.?0+$/, '') || '0'
}

export function outputName(input: string, video: boolean): string {
  const stem = input.replace(/\.[^.]+$/, '') || 'output'
  return `${stem}-stripped.${video ? 'mp4' : 'm4a'}`
}

function q(s: string): string {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`
}
