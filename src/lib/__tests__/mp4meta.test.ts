import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bufferSource, readMediaMeta } from '../mp4meta'
import { framesToTc, nearestPreset } from '../timecode'

// fixtures/tc-25-fixture.mov: ffmpeg testsrc2, 25 fps, two frames, no audio,
// -timecode 01:02:03:04, faststart off (moov after mdat).
const fixture = new Uint8Array(readFileSync(new URL('../../../fixtures/tc-25-fixture.mov', import.meta.url)))

describe('readMediaMeta', () => {
  it('reads the frame rate, size and start timecode from a MOV', async () => {
    const meta = await readMediaMeta(bufferSource(fixture))
    expect(meta).not.toBeNull()
    expect(meta!.hasVideo).toBe(true)
    expect(meta!.hasAudio).toBe(false)
    expect(nearestPreset(meta!.fps!)).toBe('25')
    expect(meta!.width).toBe(64)
    expect(meta!.height).toBe(36)
    expect(meta!.dropFrame).toBe(false)
    expect(meta!.videoDuration).toBeCloseTo(0.08, 3)
    expect(meta!.startTcFrames).not.toBeNull()
    expect(framesToTc(meta!.startTcFrames!, meta!.tcFps!, false)).toBe('01:02:03:04')
  })
  it('returns null for something that is not an MP4', async () => {
    const wav = new Uint8Array(64)
    wav.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    expect(await readMediaMeta(bufferSource(wav))).toBeNull()
  })
  it('survives a truncated file', async () => {
    expect(await readMediaMeta(bufferSource(fixture.subarray(0, 40)))).toBeNull()
  })
})
