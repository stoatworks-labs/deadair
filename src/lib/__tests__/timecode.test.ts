import { describe, expect, it } from 'vitest'
import {
  FPS_PRESETS,
  framesToRational,
  framesToTc,
  isDropFrameCapable,
  nearestPreset,
  nominalFps,
  secondsToFrames,
  tcToFrames,
} from '../timecode'

const F25 = FPS_PRESETS['25']
const F2997 = FPS_PRESETS['29.97']
const F5994 = FPS_PRESETS['59.94']
const F23976 = FPS_PRESETS['23.976']

describe('nominal rates', () => {
  it('rounds NTSC rates to their counting base', () => {
    expect(nominalFps(F2997)).toBe(30)
    expect(nominalFps(F23976)).toBe(24)
    expect(nominalFps(F5994)).toBe(60)
    expect(nominalFps(F25)).toBe(25)
  })
  it('only the 30-multiples can drop frames', () => {
    expect(isDropFrameCapable(F2997)).toBe(true)
    expect(isDropFrameCapable(F5994)).toBe(true)
    expect(isDropFrameCapable(F23976)).toBe(false)
    expect(isDropFrameCapable(F25)).toBe(false)
  })
})

describe('non-drop timecode', () => {
  it('formats plain counts', () => {
    expect(framesToTc(0, F25, false)).toBe('00:00:00:00')
    expect(framesToTc(24, F25, false)).toBe('00:00:00:24')
    expect(framesToTc(25, F25, false)).toBe('00:00:01:00')
    expect(framesToTc(90000, F25, false)).toBe('01:00:00:00')
  })
  it('round-trips', () => {
    for (const n of [0, 1, 24, 25, 1499, 1500, 90000, 123456]) {
      expect(tcToFrames(framesToTc(n, F25, false), F25, false)).toBe(n)
    }
  })
  it('ignores the drop flag at 25', () => {
    expect(framesToTc(1500, F25, true)).toBe('00:01:00:00')
  })
})

describe('drop-frame timecode', () => {
  it('skips frames 0 and 1 at the top of a minute at 29.97', () => {
    // Minute 0 carries all 1800 labels; the count 1800 is where ;00 and ;01 are skipped.
    expect(framesToTc(1800, F2997, true)).toBe('00:01:00;02')
    expect(framesToTc(1799, F2997, true)).toBe('00:00:59;29')
    // One wall-clock minute is 1798.2 frames, so the count 1798 is still in minute 0.
    expect(framesToTc(1798, F2997, true)).toBe('00:00:59;28')
  })
  it('does not skip at the tenth minute', () => {
    expect(framesToTc(17982, F2997, true)).toBe('00:10:00;00')
  })
  it('lands on the hour', () => {
    // 107892 frames = 1 hour of 29.97 DF.
    expect(framesToTc(107892, F2997, true)).toBe('01:00:00;00')
  })
  it('drops four at 59.94', () => {
    expect(framesToTc(3600, F5994, true)).toBe('00:01:00;04')
    expect(framesToTc(3599, F5994, true)).toBe('00:00:59;59')
  })
  it('round-trips across the awkward boundaries', () => {
    for (const n of [0, 1, 1797, 1798, 1799, 17981, 17982, 17983, 107891, 107892, 250000]) {
      const tc = framesToTc(n, F2997, true)
      expect(tcToFrames(tc, F2997, true)).toBe(n)
    }
  })
  it('a semicolon forces drop-frame parsing', () => {
    expect(tcToFrames('00:01:00;02', F2997, false)).toBe(1800)
    expect(tcToFrames('00:01:00:02', F2997, false)).toBe(1802)
  })
  it('rejects the frames a DF timecode cannot show', () => {
    expect(tcToFrames('00:01:00:30', F2997, false)).toBeNull()
    expect(tcToFrames('garbage', F25, false)).toBeNull()
  })
})

describe('seconds to frames', () => {
  it('floors and ceils, and snaps floating-point near-misses', () => {
    expect(secondsToFrames(1.0, F25, 'floor')).toBe(25)
    expect(secondsToFrames(0.1 + 0.2, F25, 'floor')).toBe(7)
    expect(secondsToFrames(3 * 0.04, F25, 'floor')).toBe(3) // 0.12000000000000001
    expect(secondsToFrames(0.041, F25, 'ceil')).toBe(2)
    expect(secondsToFrames(1.001, F2997, 'floor')).toBe(30) // exactly 30 frames, not 29.999…
  })
})

describe('presets and rationals', () => {
  it('snaps container rates to presets', () => {
    expect(nearestPreset({ num: 30000, den: 1001 })).toBe('29.97')
    expect(nearestPreset({ num: 12800, den: 512 })).toBe('25')
    expect(nearestPreset({ num: 2997, den: 100 })).toBe('29.97')
    expect(nearestPreset({ num: 17, den: 1 })).toBeNull()
  })
  it('writes exact FCPXML rationals', () => {
    expect(framesToRational(0, F2997)).toBe('0s')
    expect(framesToRational(30, F2997)).toBe('30030/30000s')
    expect(framesToRational(25, F25)).toBe('25/25s')
  })
})
