import { describe, expect, it } from 'vitest'
import { buildCutEdl, buildMarkerEdl, reelFromName } from '../edl'
import { buildFcpxml, fileUrl, rateToken } from '../fcpxml'
import { buildFfmpegCommand, frac } from '../ffmpegcmd'
import { FPS_PRESETS, tcToFrames } from '../timecode'

const F25 = FPS_PRESETS['25']
const F2997 = FPS_PRESETS['29.97']
const KEEPS = [
  { start: 38, end: 147 },
  { start: 229, end: 309 },
]

describe('cut EDL', () => {
  const edl = buildCutEdl({
    title: 'interview stripped',
    clipName: 'interview.mov',
    reel: 'INTERVIE',
    keeps: KEEPS,
    fps: F25,
    dropFrame: false,
    sourceStartFrames: tcToFrames('01:00:00:00', F25, false)!,
    recordStartFrames: tcToFrames('01:00:00:00', F25, false)!,
    tracks: 'AA/V',
  })
  const lines = edl.split('\n')

  it('has a CMX header', () => {
    expect(lines[0]).toBe('TITLE: interview stripped')
    expect(lines[1]).toBe('FCM: NON-DROP FRAME')
    expect(lines[2]).toBe('')
  })
  it('lays the events end to end on the record side', () => {
    expect(lines[3]).toBe('001  INTERVIE AA/V  C        01:00:01:13 01:00:05:22 01:00:00:00 01:00:04:09')
    expect(lines[4]).toBe('* FROM CLIP NAME: interview.mov')
    expect(lines[6]).toBe('002  INTERVIE AA/V  C        01:00:09:04 01:00:12:09 01:00:04:09 01:00:07:14')
  })
  it('conserves duration', () => {
    const total = KEEPS.reduce((a, k) => a + (k.end - k.start), 0)
    const lastOut = lines[6].split(/\s+/).at(-1)!
    expect(tcToFrames(lastOut, F25, false)! - tcToFrames('01:00:00:00', F25, false)!).toBe(total)
  })
  it('uses semicolons and the DF flag for drop-frame', () => {
    const df = buildCutEdl({
      title: 't',
      clipName: 'c.mov',
      reel: 'C',
      keeps: [{ start: 0, end: 1800 }],
      fps: F2997,
      dropFrame: true,
      sourceStartFrames: 0,
      recordStartFrames: 0,
      tracks: 'V',
    })
    expect(df).toContain('FCM: DROP FRAME')
    expect(df).toContain('001  C        V     C        00:00:00;00 00:01:00;02 00:00:00;00 00:01:00;02')
  })
  it('widens the event number past 999 events', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }))
    const edl = buildCutEdl({
      title: 't',
      clipName: 'c',
      reel: 'C',
      keeps: many,
      fps: F25,
      dropFrame: false,
      sourceStartFrames: 0,
      recordStartFrames: 0,
      tracks: 'AA/V',
    })
    expect(edl).toContain('\n0001  C ')
    expect(edl).toContain('\n1200  C ')
  })
})

describe('marker EDL', () => {
  it('writes one-frame events with Resolve colour, name and duration', () => {
    const edl = buildMarkerEdl({
      title: 'markers',
      gaps: [
        { start: 0, end: 38 },
        { start: 147, end: 229 },
      ],
      fps: F25,
      dropFrame: false,
      recordStartFrames: tcToFrames('01:00:00:00', F25, false)!,
      color: 'Red',
      namePrefix: 'Silence',
    })
    const lines = edl.split('\n')
    expect(lines[3]).toBe('001  001      V     C        01:00:00:00 01:00:00:01 01:00:00:00 01:00:00:01  ')
    expect(lines[4]).toBe(' |C:ResolveColorRed |M:Silence 1 |D:38')
    expect(lines[6]).toBe('002  002      V     C        01:00:05:22 01:00:05:23 01:00:05:22 01:00:05:23  ')
    expect(lines[7]).toBe(' |C:ResolveColorRed |M:Silence 2 |D:82')
  })
})

describe('reel names', () => {
  it('are eight upper-case alphanumerics from the stem', () => {
    expect(reelFromName('A001_C002_0805AB.mov')).toBe('A001C002')
    expect(reelFromName('my interview (final).mp4')).toBe('MYINTERV')
    expect(reelFromName('___.wav')).toBe('AX')
  })
})

describe('FCPXML', () => {
  const xml = buildFcpxml({
    projectName: 'interview stripped',
    fileName: 'interview.mov',
    mediaFolder: '/Volumes/Media/Shoot 1',
    keeps: KEEPS,
    sourceFrames: 625,
    fps: F2997,
    dropFrame: true,
    sourceStartFrames: 30,
    recordStartFrames: 0,
    width: 1920,
    height: 1080,
    hasVideo: true,
    hasAudio: true,
    audioRate: 48000,
    audioChannels: 2,
    tracks: 'AA/V',
  })
  it('declares the rate as a frame duration and times as rationals', () => {
    expect(xml).toContain('frameDuration="1001/30000s"')
    expect(xml).toContain('start="30030/30000s"')
    expect(xml).toContain('offset="0s"')
    expect(xml).toContain('duration="109109/30000s"')
    expect(xml).toContain('tcFormat="DF"')
  })
  it('chains the clips on the spine', () => {
    expect(xml).toContain('offset="109109/30000s" start="259259/30000s" duration="80080/30000s"')
  })
  it('points at the media by file URL', () => {
    expect(xml).toContain('src="file:///Volumes/Media/Shoot%201/interview.mov"')
    expect(fileUrl('C:\\Media\\', 'a b.mov')).toBe('file:///C%3A/Media/a%20b.mov')
    expect(fileUrl('', 'a.mov')).toBe('a.mov')
  })
  it('spells sample rates the FCPXML way', () => {
    expect(rateToken(48000)).toBe('48k')
    expect(rateToken(44100)).toBe('44.1k')
  })
  it('is well-formed XML', () => {
    // A crude balance check that catches a forgotten close tag.
    const opens = (xml.match(/<(?!\/|\?|!)[a-z-]+/g) ?? []).length
    const closes = (xml.match(/<\/[a-z-]+>/g) ?? []).length + (xml.match(/\/>/g) ?? []).length
    expect(opens).toBe(closes)
  })
})

describe('ffmpeg command', () => {
  it('trims and concatenates on exact frame fractions', () => {
    const cmd = buildFfmpegCommand({
      inputName: 'clip 1.mov',
      keeps: KEEPS,
      fps: F2997,
      hasVideo: true,
      hasAudio: true,
      tracks: 'AA/V',
    })
    expect(cmd.startsWith('ffmpeg -i "clip 1.mov" -filter_complex "')).toBe(true)
    expect(cmd).toContain('[0:v]trim=start=1.267933:end=4.9049,setpts=PTS-STARTPTS[v0]')
    expect(cmd).toContain('[0:a]atrim=start=1.267933:end=4.9049,asetpts=PTS-STARTPTS[a0]')
    expect(cmd).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]')
    expect(cmd).toContain('-map "[v]" -map "[a]"')
    expect(cmd.endsWith('"clip 1-stripped.mp4"')).toBe(true)
  })
  it('writes durations ffmpeg accepts: decimals, no fractions, no trailing zeros', () => {
    expect(frac(35, F25)).toBe('1.4')
    expect(frac(0, F25)).toBe('0')
    expect(frac(150, F25)).toBe('6')
    expect(frac(250, F25)).toBe('10')
    expect(frac(2500, F25)).toBe('100')
    expect(frac(38, F2997)).toBe('1.267933')
    expect(frac(38, F2997)).not.toMatch(/\//)
  })
  it('goes audio-only for audio files', () => {
    const cmd = buildFfmpegCommand({
      inputName: 'voice.wav',
      keeps: [{ start: 0, end: 25 }],
      fps: F25,
      hasVideo: false,
      hasAudio: true,
      tracks: 'AA/V',
    })
    expect(cmd).not.toContain('[0:v]')
    expect(cmd).toContain('concat=n=1:v=0:a=1[a]')
    expect(cmd.endsWith('"voice-stripped.m4a"')).toBe(true)
  })
  it('is empty with nothing to keep', () => {
    expect(buildFfmpegCommand({ inputName: 'x', keeps: [], fps: F25, hasVideo: true, hasAudio: true, tracks: 'AA/V' })).toBe('')
  })
})
