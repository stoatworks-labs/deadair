/**
 * Decode a file's audio with the browser. decodeAudioData resamples to the
 * context's rate, so a 16 kHz OfflineAudioContext turns an hour of 48 kHz
 * stereo into 230 MB of floats instead of 1.4 GB — and the detector only ever
 * looks at 10 ms RMS windows, which 16 kHz captures completely.
 */

export const ANALYSIS_RATE = 16000

export interface Decoded {
  channels: Float32Array[]
  sampleRate: number
  duration: number
}

export class DecodeError extends Error {}

export async function decodeFile(file: Blob, rate = ANALYSIS_RATE): Promise<Decoded> {
  let bytes: ArrayBuffer
  try {
    bytes = await file.arrayBuffer()
  } catch (e) {
    throw new DecodeError(`Could not read the file into memory (${(e as Error).message}).`)
  }
  const ctx = new OfflineAudioContext(1, 1, rate)
  let buffer: AudioBuffer
  try {
    buffer = await ctx.decodeAudioData(bytes)
  } catch (e) {
    throw new DecodeError(
      `The browser could not decode audio from this file (${(e as Error)?.message ?? 'unknown error'}).`,
    )
  }
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  return { channels, sampleRate: buffer.sampleRate, duration: buffer.duration }
}

/** The way out when the browser cannot decode the container or codec. */
export function extractionCommand(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '') || 'input'
  return `ffmpeg -i "${name}" -vn -ac 2 -ar 48000 -c:a pcm_s16le "${stem}-audio.wav"`
}
