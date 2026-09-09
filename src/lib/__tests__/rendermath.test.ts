import { describe, expect, it } from 'vitest'
import { audioFramesInSegment, planSegments, remap, totalDuration, videoFrameInSegment } from '../rendermath'
import { FPS_PRESETS } from '../timecode'

const F25 = FPS_PRESETS['25']

describe('planSegments', () => {
  it('lays kept spans end to end in output time', () => {
    const segs = planSegments(
      [
        { start: 35, end: 150 },
        { start: 226, end: 364 },
      ],
      F25,
    )
    expect(segs[0]).toEqual({ start: 1.4, end: 6, outOffset: 0 })
    expect(segs[1].start).toBeCloseTo(9.04)
    expect(segs[1].outOffset).toBeCloseTo(4.6)
    expect(totalDuration(segs)).toBeCloseTo(4.6 + 5.52)
  })
  it('drops empty spans', () => {
    expect(planSegments([{ start: 5, end: 5 }], F25)).toEqual([])
  })
  it('remaps source time into the output', () => {
    const seg = { start: 9.04, end: 14.56, outOffset: 4.6 }
    expect(remap(seg, 9.04)).toBeCloseTo(4.6)
    expect(remap(seg, 10)).toBeCloseTo(5.56)
  })
})

describe('audioFramesInSegment', () => {
  const seg = { start: 1.4, end: 6, outOffset: 0 }
  it('keeps a chunk wholly inside', () => {
    expect(audioFramesInSegment(2, 1024, 48000, seg)).toEqual([0, 1024])
  })
  it('trims the front of a chunk straddling the start', () => {
    // Chunk from 1.39 s: the first 0.01 s = 480 frames are before the cut.
    expect(audioFramesInSegment(1.39, 1024, 48000, seg)).toEqual([480, 1024])
  })
  it('trims the back of a chunk straddling the end', () => {
    // Chunk from 5.99 s: 0.01 s = 480 frames remain inside.
    expect(audioFramesInSegment(5.99, 1024, 48000, seg)).toEqual([0, 480])
  })
  it('rejects a chunk wholly outside', () => {
    expect(audioFramesInSegment(0, 1024, 48000, seg)).toBeNull()
    expect(audioFramesInSegment(6, 1024, 48000, seg)).toBeNull()
    expect(audioFramesInSegment(1.4 - 1024 / 48000, 1024, 48000, seg)).toBeNull()
  })
})

describe('videoFrameInSegment', () => {
  const seg = { start: 1.4, end: 6, outOffset: 0 }
  it('accepts frames inside and the boundary frame, rejects the one past the end', () => {
    expect(videoFrameInSegment(1.4, seg, F25)).toBe(true)
    expect(videoFrameInSegment(1.36, seg, F25)).toBe(false)
    expect(videoFrameInSegment(5.96, seg, F25)).toBe(true) // frame 149, the last kept
    expect(videoFrameInSegment(6.0, seg, F25)).toBe(false) // frame 150, the first cut
  })
})
