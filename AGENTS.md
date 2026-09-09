# AGENTS.md — bringing an LLM up to speed on Dead Air

Orientation for an AI assistant (or a new human) picking this project up cold. `CLAUDE.md`
holds the short command reference; this file explains the model and the traps.

## 1. What this is

A browser-only silence stripper that outputs edit decisions rather than media: a CMX3600
cut list, a Resolve marker EDL, an FCPXML, a CSV, and an ffmpeg command. React + TypeScript +
Vite, static `dist/`, Cloudflare. No backend, nothing uploaded.

Resolve 20.2+ has Ripple Delete Silence built in. This tool exists for the review-first
marker pass, batch prep, and non-Resolve targets — the README says so, and the footer says so.

## 2. Layout

```
src/
  types.ts              domain types. Read this first — it is the spec.
  lib/detect.ts         THE ENGINE. Envelope, detection, padding, quantisation.
  lib/timecode.ts       rational fps, NDF/DF timecode, seconds<->frames
  lib/edl.ts            cut-list EDL and marker EDL writers
  lib/fcpxml.ts         FCPXML 1.10 writer
  lib/ffmpegcmd.ts      trim+concat filter_complex builder
  lib/mp4meta.ts        ISO-BMFF reader: fps, size, tmcd start timecode, durations
  lib/decode.ts         OfflineAudioContext decode at 16 kHz
  components/Waveform.tsx   canvas: envelope, threshold drag, zoom/pan, playhead
  App.tsx               state, exports, the preview player that skips silences
fixtures/tc-25-fixture.mov   two-frame MOV with a tmcd track, for the reader test
```

## 3. Invariants

- **Seconds until quantisation, frames after.** `Range` is seconds, `FrameRange` is frames
  with an exclusive end. Never put one in the other's slot.
- **Kept spans floor their start and ceil their end**, so quantisation only ever keeps more.
  Adjacent spans are pushed apart, never overlapped; `quantiseKeeps` tests this.
- **Every timeline export derives from the same `keepsFrames`.** The EDL, the FCPXML and the
  ffmpeg command must cut on identical frames — that is what makes them interchangeable.
- **Padding order matters** and is documented in `detectSilence`: threshold → minimum → pad
  → edges → swallow islands. Changing the order changes the behaviour.
- **Drop-frame is a display convention on a plain frame count.** Frame 1800 at 29.97 DF is
  `00:01:00;02`. The count 1798 is still in minute 0. Tests pin the boundaries.
- **A drop-frame flag on a non-DF-capable rate is ignored**, not an error.

## 4. Traps

- `OfflineAudioContext(1, 1, 16000).decodeAudioData` resamples to 16 kHz — that is the whole
  memory strategy. Do not "fix" it to the file's rate.
- `decodeAudioData` needs the entire file as an ArrayBuffer. The 1.5 GB refusal in `App.tsx`
  is deliberate; the way out is the ffmpeg extraction command it prints.
- The wheel handler on the canvas is a native listener with `passive: false`. React's
  `onWheel` cannot `preventDefault`, and the page would scroll instead of zooming.
- Browsers hide file paths. The FCPXML `media-rep src` is just the filename unless the user
  types the folder; Resolve then asks to relink. That is expected, not a bug.
- Resolve's `GetSourceStartFrame` reports one frame less than `GetLeftOffset` for events
  after the first. `GetLeftOffset` is the one that matched the EDL exactly.
- Resolve imports a marker EDL only from the media pool context menu on a timeline
  (Timelines › Import › Timeline Markers from EDL…). There is no scripting API for it and it
  is not under File › Import.
- `ImportTimelineFromFile` with `importSourceClips: False` left the FCPXML's clips offline
  even with the file in the pool; the default (True) relinked by path and reused the pool
  clip. The EDL linked fine either way, by timecode and FROM CLIP NAME.

## 5. Verifying against a real Resolve

The scripting API works from Homebrew Python 3.14 with the env vars in Resolve's
`Developer/Scripting/README.md`; Studio is required for external scripting. Create a
throwaway project, `SetSetting('timelineFrameRate', '25')`, `ImportMedia`, then
`ImportTimelineFromFile` and walk `GetItemListInTrack` comparing `GetStart`/`GetEnd`/
`GetLeftOffset` to the EDL. `GetMarkers()` reads the marker import back. Delete the project
afterwards. `test-media/` (gitignored) is generated with `say` and ffmpeg — see the
`speech-*` recipe in the git history of this file if it is missing.
