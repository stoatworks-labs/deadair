> **AI-assisted project.** This codebase was created with [Claude Code](https://claude.com/claude-code).
> The detector and the timecode maths are covered by tests, and all three Resolve routes — the
> cut-list EDL, the marker EDL and the FCPXML — have been imported into a running DaVinci Resolve
> Studio 21.1 and read back frame-for-frame. **That was one synthetic 25p file.** Drop-frame output
> has only been checked against the arithmetic, never through Resolve. See [Status](#status).

# Dead Air

**Strip silence from a recording, then hand the cut to DaVinci Resolve.** Drop a video or
audio file, set a threshold and a minimum gap, watch the silences shade red on the waveform,
and export a cut list Resolve imports as the ripple-deleted timeline — or a marker list to
review first, an FCPXML for Premiere and Final Cut, or an ffmpeg command that cuts the file
without any NLE at all.

Runs entirely in your browser. No account, no backend, nothing uploaded.

## Resolve already has this — so why?

Resolve 20.2 added **Clip › Audio Operations › Ripple Delete Silence** on the Edit and Cut
pages, in both Free and Studio, and for a linked talking-head clip it is the shortest route.
Dead Air is for the cases around it:

- **Review before you cut.** The marker EDL puts a coloured span on every silence and touches
  nothing else. Step through them, delete the ones that are dramatic pauses, then cut.
- **Batch prep.** Run a folder of raw captures through it before they go anywhere near a
  timeline, or hand an ffmpeg command to a machine that has no Resolve on it.
- **Anything that isn't Resolve.** The FCPXML opens in Premiere and Final Cut; the CSV goes
  wherever CSVs go.
- **A picture of the decision.** The loudness envelope with the threshold drawn across it
  shows *why* a cut landed where it did, which Resolve's dialog does not.

## What it does

1. Reads the container. For MP4/MOV it pulls the frame rate, picture size and the **start
   timecode from the `tmcd` track** the way cameras and Resolve write it — only the box
   headers and the `moov` are read, so a 40 GB ProRes file costs kilobytes of I/O.
2. Decodes the audio with the browser at 16 kHz and measures RMS loudness in 10 ms windows,
   loudest channel wins.
3. Finds runs below the threshold that last at least the minimum, shrinks each by the pre-head
   and post-tail so the cut never touches speech, optionally swallows kept islands too short
   to be a word, and quantises the result to whole frames.
4. Lays the kept spans end to end as a **CMX3600 EDL** whose source timecodes are offset by the
   clip's start TC, so Resolve links every event to the clip in the bin.

Also: a **preview player that skips the silences**, a draggable threshold line, zoom and pan on
the waveform, and a table of every silence with its source timecodes.

## Getting it into Resolve

Import the original file into the media pool first and leave it selected.

| Export | Where it goes | Result |
| --- | --- | --- |
| Cut list EDL | File › Import › Timeline… (frame rate to match, *Assist using reel names* off) | The ripple-deleted timeline, video and audio linked to the clip |
| Marker EDL | Put the clip on a timeline at the *Timeline start TC*, then right-click that timeline in the media pool › Timelines › Import › Timeline Markers from EDL… | A coloured span per silence, nothing cut |
| FCPXML | File › Import › Timeline… | Same timeline; relinks by path if the media folder was filled in, otherwise Resolve asks |
| ffmpeg command | A terminal, in the folder that holds the file | A re-encoded file with the silences gone, on the same frames as the EDL |

**Source start TC must match what Resolve shows for the clip.** It is read from the file when
there is a timecode track; a phone or screen recording starts at 00:00:00:00.

## Limits

- The browser holds the whole file in memory to decode it, so files over about 1.5 GB are
  refused with an ffmpeg command that extracts the audio to a WAV. Drop the WAV instead; the
  frame rate and timecode read from the original are kept.
- Decoding depends on the browser's codecs. Chrome and Edge handle AAC and PCM in MP4/MOV;
  MXF and most ProRes-in-MOV audio will need the same WAV extraction.
- It is a level detector. It does not know a dramatic pause from dead air, and it cannot hear
  a quiet consonant under the threshold. Review the cuts.

## Development

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — the detector, the timecode maths, the exports, the MP4 reader
npm run build        # tsc -b && vite build -> dist/
```

`src/types.ts` is the spec. `src/lib/detect.ts` is the engine, `src/lib/timecode.ts` the
frame and drop-frame arithmetic, `src/lib/edl.ts` / `fcpxml.ts` / `ffmpegcmd.ts` the writers,
`src/lib/mp4meta.ts` the container reader. `fixtures/tc-25-fixture.mov` is a two-frame MOV
with a timecode track that the reader test runs against.

## Status

- **Verified in Resolve Studio 21.1** on a synthetic 25p MP4 with a 01:00:00:00 timecode track:
  the cut EDL imported as three linked video+audio events at exactly the frames the app
  reported; the FCPXML imported the same geometry and relinked by path; the marker EDL put four
  red markers at the right frames with the right durations. The generated ffmpeg command
  produced a file of exactly the expected 377 frames with no silence over half a second left.
- **Not verified in Resolve:** drop-frame timecode (29.97/59.94 DF) — the arithmetic is tested
  against the standard boundaries, and a 29.97 DF MOV reads its `10:00:00;00` start correctly,
  but no DF EDL has been imported. Audio-only and video-only track modes. Files with more than
  999 events.
- **Not verified interactively:** dragging the threshold line on the waveform (the slider
  is the same state and works). The rest of the waveform — zoom, pan, click-to-seek, the
  skip-silence preview — has only been exercised by hand in Chromium's dev server.
- **Browser coverage:** Chromium only so far. Safari's `decodeAudioData` and its
  `OfflineAudioContext` sample-rate range are untested.

## Licence

MIT.
