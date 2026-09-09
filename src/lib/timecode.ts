import type { Fps, FpsKey } from '../types'

export const FPS_PRESETS: Record<FpsKey, Fps> = {
  '23.976': { num: 24000, den: 1001 },
  '24': { num: 24, den: 1 },
  '25': { num: 25, den: 1 },
  '29.97': { num: 30000, den: 1001 },
  '30': { num: 30, den: 1 },
  '48': { num: 48, den: 1 },
  '50': { num: 50, den: 1 },
  '59.94': { num: 60000, den: 1001 },
  '60': { num: 60, den: 1 },
}

export const FPS_KEYS = Object.keys(FPS_PRESETS) as FpsKey[]

export function fpsValue(fps: Fps): number {
  return fps.num / fps.den
}

/** The integer frame count a timecode counts to: 30 for 29.97, 24 for 23.976. */
export function nominalFps(fps: Fps): number {
  return Math.round(fpsValue(fps))
}

/** Drop-frame timecode only exists for the NTSC multiples of 30. */
export function isDropFrameCapable(fps: Fps): boolean {
  return fps.den === 1001 && nominalFps(fps) % 30 === 0
}

/** Frames dropped per minute in drop-frame counting: 2 at 29.97, 4 at 59.94. */
function dropPerMinute(fps: Fps): number {
  return Math.round(fpsValue(fps) * 0.06666666667)
}

/**
 * Snap a rational to the nearest preset, so a container's 30000/1001 and a
 * sloppy 29.970 both land on '29.97'. Returns null if nothing is within 0.5%.
 */
export function nearestPreset(fps: Fps): FpsKey | null {
  const v = fpsValue(fps)
  let best: FpsKey | null = null
  let bestErr = Infinity
  for (const key of FPS_KEYS) {
    const err = Math.abs(fpsValue(FPS_PRESETS[key]) - v) / v
    if (err < bestErr) {
      bestErr = err
      best = key
    }
  }
  return bestErr <= 0.005 ? best : null
}

/**
 * Frame count -> hh:mm:ss:ff. Drop-frame uses ';' before the frames, as EDLs
 * and Resolve do. Negative counts are clamped to zero.
 */
export function framesToTc(frames: number, fps: Fps, dropFrame: boolean): string {
  const nom = nominalFps(fps)
  let f = Math.max(0, Math.round(frames))
  if (dropFrame && isDropFrameCapable(fps)) {
    const drop = dropPerMinute(fps)
    const perMinute = nom * 60 - drop // 1798 at 29.97
    const perTenMinutes = perMinute * 10 + drop // 17982 at 29.97
    const tens = Math.floor(f / perTenMinutes)
    const rem = f % perTenMinutes
    // Minutes 1..9 of every ten drop `drop` frames; minute 0 does not.
    const extraMinutes = rem >= drop ? Math.floor((rem - drop) / perMinute) : 0
    f += drop * 9 * tens + drop * extraMinutes
  }
  const ff = f % nom
  const totalSeconds = Math.floor(f / nom)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600) % 24
  const sep = dropFrame && isDropFrameCapable(fps) ? ';' : ':'
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${sep}${pad2(ff)}`
}

/**
 * hh:mm:ss:ff -> frame count. Accepts ':' or ';' (or '.') before the frames;
 * a ';' forces drop-frame interpretation, otherwise `dropFrame` decides.
 * Returns null for anything that is not a timecode.
 */
export function tcToFrames(tc: string, fps: Fps, dropFrame: boolean): number | null {
  const m = /^\s*(\d{1,2}):(\d{1,2}):(\d{1,2})([:;.])(\d{1,3})\s*$/.exec(tc)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  const ss = Number(m[3])
  const ff = Number(m[5])
  const nom = nominalFps(fps)
  if (mm > 59 || ss > 59 || ff >= nom) return null
  const df = (dropFrame || m[4] === ';') && isDropFrameCapable(fps)
  let frames = ((hh * 60 + mm) * 60 + ss) * nom + ff
  if (df) {
    const drop = dropPerMinute(fps)
    const totalMinutes = hh * 60 + mm
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10))
  }
  return frames
}

export function isValidTc(tc: string, fps: Fps, dropFrame: boolean): boolean {
  return tcToFrames(tc, fps, dropFrame) !== null
}

/** Seconds -> frames, with the rounding the caller asks for. */
export function secondsToFrames(sec: number, fps: Fps, mode: 'floor' | 'ceil' | 'round'): number {
  const exact = sec * fpsValue(fps)
  // Guard against 4.999999998 flooring to 4 when the true value is 5.
  const snapped = Math.abs(exact - Math.round(exact)) < 1e-6 ? Math.round(exact) : exact
  if (mode === 'floor') return Math.floor(snapped)
  if (mode === 'ceil') return Math.ceil(snapped)
  return Math.round(snapped)
}

export function framesToSeconds(frames: number, fps: Fps): number {
  return frames / fpsValue(fps)
}

/** A rational-seconds string of the kind FCPXML wants: "3003/30000s". */
export function framesToRational(frames: number, fps: Fps): string {
  if (frames === 0) return '0s'
  return `${frames * fps.den}/${fps.num}s`
}

/** m:ss.mmm for the human-facing tables. */
export function formatSeconds(sec: number): string {
  const s = Math.max(0, sec)
  const mm = Math.floor(s / 60)
  const rest = s - mm * 60
  return `${mm}:${rest.toFixed(3).padStart(6, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
