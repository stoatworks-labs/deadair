import { describe, expect, it } from 'vitest'
import { DB_FLOOR } from '../../types'
import type { Envelope } from '../../types'
import { DEFAULT_PARAMS, complement, computeEnvelope, detectSilence, frameGaps, quantiseKeeps, stats } from '../detect'
import { FPS_PRESETS } from '../timecode'

const F25 = FPS_PRESETS['25']

/** An envelope from a string: 'S' = speech (-20 dB), '.' = silence (-70 dB), 10 ms per char. */
function env(pattern: string, hopSec = 0.01): Envelope {
  const db = new Float32Array(pattern.length)
  const peak = new Float32Array(pattern.length)
  for (let i = 0; i < pattern.length; i++) {
    db[i] = pattern[i] === 'S' ? -20 : pattern[i] === 'q' ? -45 : -70
    peak[i] = pattern[i] === 'S' ? 0.5 : 0.001
  }
  return { hopSec, db, peak, duration: pattern.length * hopSec, sampleRate: 16000, channels: 1 }
}

const NO_PAD = { ...DEFAULT_PARAMS, preHeadMs: 0, postTailMs: 0, minSilenceMs: 300 }

describe('computeEnvelope', () => {
  it('measures RMS in dBFS and takes the loudest channel', () => {
    const rate = 1000
    const loud = new Float32Array(100).fill(0.5)
    const quiet = new Float32Array(100).fill(0.005)
    const e = computeEnvelope([quiet, loud], rate, 10)
    expect(e.db.length).toBe(10)
    expect(e.hopSec).toBeCloseTo(0.01)
    expect(e.db[0]).toBeCloseTo(20 * Math.log10(0.5), 3)
    expect(e.peak[0]).toBeCloseTo(0.5)
    expect(e.duration).toBeCloseTo(0.1)
  })
  it('floors digital silence', () => {
    const e = computeEnvelope([new Float32Array(50)], 1000, 10)
    expect(e.db[0]).toBe(DB_FLOOR)
  })
})

describe('detectSilence', () => {
  it('finds a run longer than the minimum and ignores a shorter one', () => {
    // 1 s speech, 0.5 s gap, 1 s speech, 0.2 s gap, 1 s speech.
    const e = env('S'.repeat(100) + '.'.repeat(50) + 'S'.repeat(100) + '.'.repeat(20) + 'S'.repeat(100))
    const r = detectSilence(e, NO_PAD)
    expect(r.silences).toEqual([{ start: 1.0, end: 1.5 }])
    expect(r.keeps).toEqual([
      { start: 0, end: 1.0 },
      { start: 1.5, end: 3.7 },
    ])
  })

  it('pads: postTail shrinks the start, preHead shrinks the end', () => {
    const e = env('S'.repeat(100) + '.'.repeat(100) + 'S'.repeat(100))
    const r = detectSilence(e, { ...NO_PAD, postTailMs: 150, preHeadMs: 100 })
    expect(r.silences[0].start).toBeCloseTo(1.15)
    expect(r.silences[0].end).toBeCloseTo(1.9)
  })

  it('drops a silence the padding consumes', () => {
    const e = env('S'.repeat(100) + '.'.repeat(40) + 'S'.repeat(100))
    const r = detectSilence(e, { ...NO_PAD, postTailMs: 250, preHeadMs: 250 })
    expect(r.silences).toEqual([])
    expect(r.keeps).toEqual([{ start: 0, end: 2.4 }])
  })

  it('trims the ends only when asked, and pads them on one side only', () => {
    const e = env('.'.repeat(100) + 'S'.repeat(100) + '.'.repeat(100))
    const on = detectSilence(e, { ...NO_PAD, preHeadMs: 100, postTailMs: 200, trimEnds: true })
    expect(on.silences[0]).toEqual({ start: 0, end: 0.9 })
    expect(on.silences[1].start).toBeCloseTo(2.2)
    expect(on.silences[1].end).toBeCloseTo(3.0)
    const off = detectSilence(e, { ...NO_PAD, trimEnds: false })
    expect(off.silences).toEqual([])
    expect(off.keeps).toEqual([{ start: 0, end: 3.0 }])
  })

  it('the threshold decides whether room tone is silence', () => {
    const e = env('S'.repeat(100) + 'q'.repeat(100) + 'S'.repeat(100))
    expect(detectSilence(e, { ...NO_PAD, thresholdDb: -40 }).silences.length).toBe(1)
    expect(detectSilence(e, { ...NO_PAD, thresholdDb: -50 }).silences.length).toBe(0)
  })

  it('swallows islands shorter than minKeep and merges the silences around them', () => {
    const e = env('S'.repeat(100) + '.'.repeat(50) + 'S'.repeat(10) + '.'.repeat(50) + 'S'.repeat(100))
    const r = detectSilence(e, { ...NO_PAD, minKeepMs: 200 })
    expect(r.silences).toEqual([{ start: 1.0, end: 2.1 }])
    expect(r.keeps.length).toBe(2)
  })

  it('an all-silent file is one silence', () => {
    const e = env('.'.repeat(200))
    const r = detectSilence(e, NO_PAD)
    expect(r.silences).toEqual([{ start: 0, end: 2.0 }])
    expect(r.keeps).toEqual([])
  })

  it('an empty envelope yields nothing', () => {
    expect(detectSilence(env(''), NO_PAD)).toEqual({ silences: [], keeps: [] })
  })
})

describe('complement', () => {
  it('fills the gaps', () => {
    expect(complement([{ start: 1, end: 2 }], 3)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ])
    expect(complement([], 3)).toEqual([{ start: 0, end: 3 }])
    expect(complement([{ start: 0, end: 3 }], 3)).toEqual([])
  })
})

describe('quantiseKeeps', () => {
  it('floors starts, ceils ends, and never overlaps', () => {
    const q = quantiseKeeps(
      [
        { start: 0, end: 1.01 },
        { start: 1.02, end: 2.5 },
      ],
      F25,
      2.5,
    )
    expect(q).toEqual([
      { start: 0, end: 26 },
      { start: 26, end: 63 },
    ])
  })
  it('drops spans that quantise to nothing and clamps to the file', () => {
    expect(quantiseKeeps([{ start: 9.999, end: 10.0 }], F25, 10.0)).toEqual([{ start: 249, end: 250 }])
    expect(quantiseKeeps([{ start: 1.0, end: 1.0 }], F25, 10)).toEqual([])
  })
})

describe('frameGaps and stats', () => {
  it('lists the removed spans in frames, including the trailing one', () => {
    const gaps = frameGaps(
      [
        { start: 10, end: 20 },
        { start: 30, end: 40 },
      ],
      F25,
      2.0,
    )
    expect(gaps).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
      { start: 40, end: 50 },
    ])
  })
  it('sums the removed time', () => {
    const s = stats({ silences: [{ start: 1, end: 3 }], keeps: [] }, 10)
    expect(s.removedSec).toBe(2)
    expect(s.keptSec).toBe(8)
    expect(s.removedPct).toBe(20)
    expect(s.silenceCount).toBe(1)
  })
})
