import type { Fps, MediaMeta } from '../types'

/**
 * Enough of an ISO-BMFF (MP4 / MOV / M4A) parser to read three things the
 * browser's audio decoder cannot tell us: the video frame rate, the picture
 * size, and the start timecode in the tmcd track that cameras and Resolve
 * write. Reads only the box headers and the moov box, so a 40 GB ProRes file
 * costs a few hundred KB of I/O, and the first timecode sample is fetched by
 * offset rather than by reading through the mdat.
 */

export interface ByteSource {
  size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function fileSource(file: Blob): ByteSource {
  return {
    size: file.size,
    async read(offset, length) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
    },
  }
}

export function bufferSource(buf: Uint8Array): ByteSource {
  return {
    size: buf.length,
    async read(offset, length) {
      return buf.subarray(offset, Math.min(buf.length, offset + length))
    },
  }
}

const MAX_MOOV = 64 * 1024 * 1024

interface Box {
  type: string
  /** Offset of the box's payload within its parent buffer. */
  start: number
  /** Offset one past the box's end. */
  end: number
}

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
}

function u64(b: Uint8Array, at: number): number {
  return u32(b, at) * 4294967296 + u32(b, at + 4)
}

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) + b[at + 1]
}

/** Walk the boxes in b[from, to). Handles 64-bit sizes and size 0 (to end). */
function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = u32(b, at)
    const type = fourcc(b, at + 4)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) break
      size = u64(b, at + 8)
      header = 16
    } else if (size === 0) {
      size = to - at
    }
    if (size < header) break
    out.push({ type, start: at + header, end: Math.min(to, at + size) })
    at += size
  }
  return out
}

function find(b: Uint8Array, from: number, to: number, type: string): Box | null {
  return children(b, from, to).find((c) => c.type === type) ?? null
}

/** Returns null for anything that is not an ISO-BMFF file. */
export async function readMediaMeta(src: ByteSource): Promise<MediaMeta | null> {
  if (src.size < 16) return null
  const head = await src.read(0, 12)
  const firstType = fourcc(head, 4)
  if (!['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(firstType)) return null

  // Find moov among the top-level boxes without reading the mdat.
  let at = 0
  let moov: Uint8Array | null = null
  while (at + 8 <= src.size) {
    const h = await src.read(at, 16)
    if (h.length < 8) break
    let size = u32(h, 0)
    const type = fourcc(h, 4)
    let header = 8
    if (size === 1) {
      size = u64(h, 8)
      header = 16
    } else if (size === 0) size = src.size - at
    if (size < header) break
    if (type === 'moov') {
      if (size > MAX_MOOV) return null
      moov = await src.read(at + header, size - header)
      break
    }
    at += size
  }
  if (!moov) return null

  const meta: MediaMeta = {
    fps: null,
    startTcFrames: null,
    tcFps: null,
    dropFrame: false,
    width: null,
    height: null,
    hasVideo: false,
    hasAudio: false,
    audioRate: null,
    audioChannels: null,
    videoDuration: null,
  }

  for (const trak of children(moov, 0, moov.length).filter((c) => c.type === 'trak')) {
    const mdia = find(moov, trak.start, trak.end, 'mdia')
    if (!mdia) continue
    const hdlr = find(moov, mdia.start, mdia.end, 'hdlr')
    const mdhd = find(moov, mdia.start, mdia.end, 'mdhd')
    const minf = find(moov, mdia.start, mdia.end, 'minf')
    if (!hdlr || !mdhd || !minf) continue
    const handler = fourcc(moov, hdlr.start + 8)
    const v1 = moov[mdhd.start] === 1
    const timescale = v1 ? u32(moov, mdhd.start + 20) : u32(moov, mdhd.start + 12)
    const mediaDuration = v1 ? u64(moov, mdhd.start + 24) : u32(moov, mdhd.start + 16)
    const trackSeconds = timescale > 0 ? mediaDuration / timescale : 0
    const stbl = find(moov, minf.start, minf.end, 'stbl')
    if (!stbl) continue
    const stts = find(moov, stbl.start, stbl.end, 'stts')
    const stsd = find(moov, stbl.start, stbl.end, 'stsd')

    if (handler === 'vide') {
      meta.hasVideo = true
      if (trackSeconds > 0 && meta.videoDuration === null) meta.videoDuration = trackSeconds
      if (stts && u32(moov, stts.start + 4) > 0 && !meta.fps) {
        const delta = u32(moov, stts.start + 12)
        if (delta > 0 && timescale > 0) meta.fps = reduce({ num: timescale, den: delta })
      }
      const tkhd = find(moov, trak.start, trak.end, 'tkhd')
      if (tkhd && meta.width === null) {
        const off = moov[tkhd.start] === 1 ? 88 : 76
        const w = u32(moov, tkhd.start + off) / 65536
        const h = u32(moov, tkhd.start + off + 4) / 65536
        if (w > 0 && h > 0) {
          meta.width = Math.round(w)
          meta.height = Math.round(h)
        }
      }
    } else if (handler === 'soun') {
      meta.hasAudio = true
      if (stsd && meta.audioRate === null) {
        // Sample entry: 8 header + 6 reserved + 2 dref, then version(2) rev(2)
        // vendor(4) channels(2) samplesize(2) cid(2) packsize(2) rate(16.16).
        const entry = stsd.start + 8
        const version = u16(moov, entry + 16)
        meta.audioChannels = u16(moov, entry + 24) || null
        const rate = u32(moov, entry + 32) / 65536
        if (version === 2) {
          // QuickTime v2: sample rate is a float64 at +28 from the start of the extended fields.
          const view = new DataView(moov.buffer, moov.byteOffset + entry + 36, 8)
          meta.audioRate = Math.round(view.getFloat64(0))
          meta.audioChannels = u32(moov, entry + 44) || null
        } else if (rate > 0) meta.audioRate = Math.round(rate)
      }
    } else if (handler === 'tmcd' && stsd && meta.startTcFrames === null) {
      // tmcd sample entry: 8 header + 6 reserved + 2 dref + reserved(4) flags(4)
      // timescale(4) frameDuration(4) numberOfFrames(1).
      const entry = stsd.start + 8
      const flags = u32(moov, entry + 20)
      const tcTimescale = u32(moov, entry + 24)
      const frameDuration = u32(moov, entry + 28)
      if (tcTimescale > 0 && frameDuration > 0) meta.tcFps = reduce({ num: tcTimescale, den: frameDuration })
      meta.dropFrame = (flags & 0x1) !== 0
      const stco = find(moov, stbl.start, stbl.end, 'stco')
      const co64 = find(moov, stbl.start, stbl.end, 'co64')
      let offset: number | null = null
      if (stco && u32(moov, stco.start + 4) > 0) offset = u32(moov, stco.start + 8)
      else if (co64 && u32(moov, co64.start + 4) > 0) offset = u64(moov, co64.start + 8)
      if (offset !== null && offset + 4 <= src.size) {
        const sample = await src.read(offset, 4)
        if (sample.length === 4) meta.startTcFrames = u32(sample, 0) | 0
      }
    }
  }
  if (!meta.fps && meta.tcFps) meta.fps = meta.tcFps
  return meta
}

function reduce(f: Fps): Fps {
  const g = gcd(f.num, f.den)
  return { num: f.num / g, den: f.den / g }
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}
