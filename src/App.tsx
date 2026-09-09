import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Waveform } from './components/Waveform'
import { DecodeError, decodeFile, extractionCommand } from './lib/decode'
import { DEFAULT_PARAMS, computeEnvelope, detectSilence, frameGaps, quantiseKeeps, stats } from './lib/detect'
import { copyText, downloadText } from './lib/download'
import { MARKER_COLORS, buildCutEdl, buildMarkerEdl, reelFromName } from './lib/edl'
import type { MarkerColor } from './lib/edl'
import { buildFcpxml } from './lib/fcpxml'
import { buildFfmpegCommand } from './lib/ffmpegcmd'
import { fileSource, readMediaMeta } from './lib/mp4meta'
import {
  FPS_KEYS,
  FPS_PRESETS,
  formatSeconds,
  framesToTc,
  isDropFrameCapable,
  nearestPreset,
  secondsToFrames,
  tcToFrames,
} from './lib/timecode'
import type { DetectParams, Envelope, FpsKey, MediaMeta, TrackMode } from './types'

type Status = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'ready' } | { kind: 'error'; text: string; cmd?: string }

const LARGE_FILE = 1.5 * 1024 * 1024 * 1024

export function App() {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [meta, setMeta] = useState<MediaMeta | null>(null)
  const [env, setEnv] = useState<Envelope | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [params, setParams] = useState<DetectParams>(DEFAULT_PARAMS)
  const [fpsKey, setFpsKey] = useState<FpsKey>('25')
  const [dropFrame, setDropFrame] = useState(false)
  const [sourceTc, setSourceTc] = useState('00:00:00:00')
  const [recordTc, setRecordTc] = useState('01:00:00:00')
  const [mediaFolder, setMediaFolder] = useState('')
  const [tracks, setTracks] = useState<TrackMode>('AA/V')
  const [markerColor, setMarkerColor] = useState<MarkerColor>('Red')
  const [currentTime, setCurrentTime] = useState(0)
  const [skipSilence, setSkipSilence] = useState(true)
  const [showCmd, setShowCmd] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)

  const fps = FPS_PRESETS[fpsKey]
  const dfAllowed = isDropFrameCapable(fps)
  const df = dropFrame && dfAllowed

  const load = useCallback(async (f: File) => {
    setFile(f)
    setEnv(null)
    setMeta(null)
    setCurrentTime(0)
    setUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return URL.createObjectURL(f)
    })
    setStatus({ kind: 'busy', text: 'Reading container…' })
    let m: MediaMeta | null = null
    try {
      m = await readMediaMeta(fileSource(f))
    } catch {
      m = null
    }
    setMeta(m)
    if (m?.fps) {
      const key = nearestPreset(m.fps)
      if (key) setFpsKey(key)
    }
    if (m?.startTcFrames !== null && m?.startTcFrames !== undefined && m.tcFps) {
      setDropFrame(m.dropFrame)
      setSourceTc(framesToTc(m.startTcFrames, m.tcFps, m.dropFrame))
    } else {
      setSourceTc('00:00:00:00')
    }
    if (f.size > LARGE_FILE) {
      setStatus({
        kind: 'error',
        text: `This file is ${(f.size / 1073741824).toFixed(1)} GB. The browser has to hold the whole file in memory to decode it, so extract the audio first and drop the WAV here instead:`,
        cmd: extractionCommand(f.name),
      })
      return
    }
    setStatus({ kind: 'busy', text: 'Decoding audio…' })
    try {
      const decoded = await decodeFile(f)
      setStatus({ kind: 'busy', text: 'Measuring loudness…' })
      await new Promise((r) => setTimeout(r, 0))
      const e = computeEnvelope(decoded.channels, decoded.sampleRate, 10)
      setEnv(e)
      setStatus({ kind: 'ready' })
    } catch (err) {
      const text = err instanceof DecodeError ? err.message : `Unexpected error: ${(err as Error).message}`
      setStatus({
        kind: 'error',
        text: `${text} Extract the audio with ffmpeg and drop the WAV here instead — the timecode and frame rate fields keep what was read from the original:`,
        cmd: extractionCommand(f.name),
      })
    }
  }, [])

  const result = useMemo(() => (env ? detectSilence(env, params) : null), [env, params])
  const keepsFrames = useMemo(
    () => (env && result ? quantiseKeeps(result.keeps, fps, env.duration) : []),
    [env, result, fps],
  )
  const gaps = useMemo(() => (env ? frameGaps(keepsFrames, fps, env.duration) : []), [env, keepsFrames, fps])
  const st = useMemo(() => (env && result ? stats(result, env.duration) : null), [env, result])

  const sourceFrames = tcToFrames(sourceTc, fps, df)
  const recordFrames = tcToFrames(recordTc, fps, df)
  const tcOk = sourceFrames !== null && recordFrames !== null
  const hasVideo = meta?.hasVideo ?? (file?.type.startsWith('video/') ?? false)
  const hasAudio = meta?.hasAudio ?? true
  const stem = file ? file.name.replace(/\.[^.]+$/, '') : 'deadair'

  // Playback: skip the silences while playing, and keep the playhead moving.
  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    let raf = 0
    const tick = () => {
      const t = el.currentTime
      if (skipSilence && !el.paused && result) {
        const s = result.silences.find((r) => t >= r.start && t < r.end - 0.05)
        if (s) {
          if (s.end >= el.duration - 0.05) el.pause()
          else el.currentTime = s.end
        }
      }
      setCurrentTime(el.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [result, skipSilence, url])

  const seek = (sec: number) => {
    const el = mediaRef.current
    if (el) el.currentTime = Math.max(0, sec)
    setCurrentTime(Math.max(0, sec))
  }

  const say = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(null), 1800)
  }

  const exportCut = () => {
    if (!file || !env || !tcOk) return
    downloadText(
      `${stem}-cut.edl`,
      buildCutEdl({
        title: `${stem} stripped`,
        clipName: file.name,
        reel: reelFromName(file.name),
        keeps: keepsFrames,
        fps,
        dropFrame: df,
        sourceStartFrames: sourceFrames!,
        recordStartFrames: recordFrames!,
        tracks,
      }),
    )
  }
  const exportMarkers = () => {
    if (!file || !env || !tcOk) return
    downloadText(
      `${stem}-markers.edl`,
      buildMarkerEdl({
        title: `${stem} silences`,
        gaps,
        fps,
        dropFrame: df,
        recordStartFrames: recordFrames!,
        color: markerColor,
        namePrefix: 'Silence',
      }),
    )
  }
  const exportFcpxml = () => {
    if (!file || !env || !tcOk) return
    downloadText(
      `${stem}-stripped.fcpxml`,
      buildFcpxml({
        projectName: `${stem} stripped`,
        fileName: file.name,
        mediaFolder,
        keeps: keepsFrames,
        sourceFrames: secondsToFrames(Math.max(env.duration, meta?.videoDuration ?? 0), fps, 'ceil'),
        fps,
        dropFrame: df,
        sourceStartFrames: sourceFrames!,
        recordStartFrames: recordFrames!,
        width: meta?.width ?? null,
        height: meta?.height ?? null,
        hasVideo,
        hasAudio,
        audioRate: meta?.audioRate ?? null,
        audioChannels: meta?.audioChannels ?? null,
        tracks,
      }),
      'application/xml',
    )
  }
  const exportCsv = () => {
    if (!file || !env || !result) return
    const rows = ['index,kind,start_sec,end_sec,start_tc,end_tc,frames']
    let i = 0
    for (const g of gaps) {
      i++
      rows.push(
        `${i},silence,${(g.start / (fps.num / fps.den)).toFixed(3)},${(g.end / (fps.num / fps.den)).toFixed(3)},${framesToTc(
          (sourceFrames ?? 0) + g.start,
          fps,
          df,
        )},${framesToTc((sourceFrames ?? 0) + g.end, fps, df)},${g.end - g.start}`,
      )
    }
    downloadText(`${stem}-silences.csv`, rows.join('\n') + '\n', 'text/csv')
  }
  const ffmpegCmd = useMemo(
    () => (file ? buildFfmpegCommand({ inputName: file.name, keeps: keepsFrames, fps, hasVideo, hasAudio, tracks }) : ''),
    [file, keepsFrames, fps, hasVideo, hasAudio, tracks],
  )

  const set = <K extends keyof DetectParams>(k: K, v: DetectParams[K]) => setParams((p) => ({ ...p, [k]: v }))

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void load(f)
  }

  const currentSilence = result?.silences.findIndex((r) => currentTime >= r.start && currentTime < r.end) ?? -1

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span>Dead Air</span>
        </h1>
        <span className="tag">strip silence, then hand the cut to DaVinci Resolve</span>
        <span className="ver">{__APP_VERSION__}</span>
      </header>

      <label
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept="video/*,audio/*,.mov,.mp4,.m4a,.wav,.aif,.aiff,.mp3,.flac,.mxf"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void load(f)
          }}
        />
        <strong>Drop a video or audio file</strong> or click to choose one
        <span className="small">
          Nothing is uploaded. The browser decodes the audio locally; the file never leaves this machine.
        </span>
      </label>

      {status.kind === 'busy' && (
        <div className="status">
          <span className="spinner" />
          <span>{status.text}</span>
          {file && <span className="meta">{file.name}</span>}
        </div>
      )}
      {status.kind === 'error' && (
        <div className="status error">
          {status.text}
          {status.cmd && <pre>{status.cmd}</pre>}
        </div>
      )}
      {status.kind === 'ready' && file && env && (
        <div className="status">
          <span className="name">{file.name}</span>
          <span className="meta">
            {formatSeconds(env.duration)} · {env.channels} ch · analysed at {env.sampleRate / 1000} kHz
            {meta?.fps ? ` · ${(meta.fps.num / meta.fps.den).toFixed(3)} fps` : ''}
            {meta?.width ? ` · ${meta.width}×${meta.height}` : ''}
            {meta?.startTcFrames !== null && meta?.startTcFrames !== undefined && meta.tcFps
              ? ` · start TC ${framesToTc(meta.startTcFrames, meta.tcFps, meta.dropFrame)}`
              : ' · no timecode track'}
          </span>
        </div>
      )}

      {env && result && st && file && (
        <div className="layout">
          <aside>
            <section className="panel">
              <h2>Detection</h2>
              <div className="field">
                <label>Threshold</label>
                <span className="val">{params.thresholdDb} dBFS</span>
                <input
                  type="range"
                  min={-80}
                  max={-5}
                  step={1}
                  value={params.thresholdDb}
                  onChange={(e) => set('thresholdDb', Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label>Minimum silence</label>
                <span className="val">{params.minSilenceMs} ms</span>
                <input
                  type="range"
                  min={50}
                  max={5000}
                  step={50}
                  value={params.minSilenceMs}
                  onChange={(e) => set('minSilenceMs', Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label>Pre head</label>
                <span className="val">{params.preHeadMs} ms</span>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={10}
                  value={params.preHeadMs}
                  onChange={(e) => set('preHeadMs', Number(e.target.value))}
                />
              </div>
              <p className="hint">Quiet kept before speech resumes.</p>
              <div className="field">
                <label>Post tail</label>
                <span className="val">{params.postTailMs} ms</span>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={10}
                  value={params.postTailMs}
                  onChange={(e) => set('postTailMs', Number(e.target.value))}
                />
              </div>
              <p className="hint">Quiet kept after speech stops.</p>
              <div className="field">
                <label>Drop islands shorter than</label>
                <span className="val">{params.minKeepMs ? `${params.minKeepMs} ms` : 'off'}</span>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  step={50}
                  value={params.minKeepMs}
                  onChange={(e) => set('minKeepMs', Number(e.target.value))}
                />
              </div>
              <p className="hint">A kept snippet this short is a click or a breath, not a word.</p>
              <div className="field check">
                <input
                  id="trim"
                  type="checkbox"
                  checked={params.trimEnds}
                  onChange={(e) => set('trimEnds', e.target.checked)}
                />
                <label htmlFor="trim">Trim silence at the start and end</label>
              </div>
            </section>

            <section className="panel">
              <h2>Timeline</h2>
              <div className="field">
                <label>Frame rate</label>
                <select value={fpsKey} onChange={(e) => setFpsKey(e.target.value as FpsKey)}>
                  {FPS_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field check">
                <input
                  id="df"
                  type="checkbox"
                  checked={df}
                  disabled={!dfAllowed}
                  onChange={(e) => setDropFrame(e.target.checked)}
                />
                <label htmlFor="df">Drop-frame timecode</label>
              </div>
              <div className="field">
                <label>Source start TC</label>
                <input
                  type="text"
                  className={sourceFrames === null ? 'bad' : ''}
                  value={sourceTc}
                  onChange={(e) => setSourceTc(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <p className="hint">
                The clip's first-frame timecode as Resolve shows it in the media pool. Read from the file when it has a
                timecode track.
              </p>
              <div className="field">
                <label>Timeline start TC</label>
                <input
                  type="text"
                  className={recordFrames === null ? 'bad' : ''}
                  value={recordTc}
                  onChange={(e) => setRecordTc(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label>Tracks</label>
                <select value={tracks} onChange={(e) => setTracks(e.target.value as TrackMode)}>
                  <option value="AA/V">Video + audio</option>
                  <option value="V">Video only</option>
                  <option value="AA">Audio only</option>
                </select>
              </div>
              <div className="field">
                <label>Marker colour</label>
                <select value={markerColor} onChange={(e) => setMarkerColor(e.target.value as MarkerColor)}>
                  {MARKER_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Media folder (FCPXML)</label>
                <input
                  type="text"
                  className="wide"
                  placeholder="/Volumes/Media/Shoot 1"
                  value={mediaFolder}
                  onChange={(e) => setMediaFolder(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <p className="hint">Browsers hide the path, so type the folder for a self-relinking FCPXML.</p>
            </section>
          </aside>

          <main>
            <section className="panel">
              <div className="stats">
                <div className="stat">
                  <div className="k">Silences</div>
                  <div className="v cut">{st.silenceCount}</div>
                </div>
                <div className="stat">
                  <div className="k">Removed</div>
                  <div className="v cut">{formatSeconds(st.removedSec)}</div>
                </div>
                <div className="stat">
                  <div className="k">Kept</div>
                  <div className="v keep">{formatSeconds(st.keptSec)}</div>
                </div>
                <div className="stat">
                  <div className="k">Shorter by</div>
                  <div className="v">{st.removedPct.toFixed(1)}%</div>
                </div>
                <div className="stat">
                  <div className="k">Cuts</div>
                  <div className="v">{Math.max(0, keepsFrames.length - 1)}</div>
                </div>
              </div>

              {url && hasVideo ? (
                <video ref={(el) => { mediaRef.current = el }} className="media" src={url} controls playsInline />
              ) : url ? (
                <audio ref={(el) => { mediaRef.current = el }} className="media" src={url} controls />
              ) : null}

              <Waveform
                env={env}
                silences={result.silences}
                thresholdDb={params.thresholdDb}
                currentTime={currentTime}
                onThreshold={(db) => set('thresholdDb', db)}
                onSeek={seek}
              />
              <div className="wave-tools">
                <button className={`btn small${skipSilence ? ' on' : ''}`} onClick={() => setSkipSilence((v) => !v)}>
                  {skipSilence ? 'Preview: skipping silences' : 'Preview: playing everything'}
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>Export</h2>
              <div className="exports">
                <button className="btn primary" disabled={!tcOk || keepsFrames.length === 0} onClick={exportCut}>
                  Cut list EDL
                </button>
                <button className="btn" disabled={!tcOk || gaps.length === 0} onClick={exportMarkers}>
                  Marker EDL
                </button>
                <button className="btn" disabled={!tcOk || keepsFrames.length === 0} onClick={exportFcpxml}>
                  FCPXML
                </button>
                <button className="btn" disabled={gaps.length === 0} onClick={exportCsv}>
                  CSV
                </button>
                <button className="btn" disabled={!ffmpegCmd} onClick={() => setShowCmd((v) => !v)}>
                  ffmpeg command
                </button>
              </div>
              {!tcOk && <p className="hint">Fix the timecode fields to enable the EDL and FCPXML exports.</p>}
              {showCmd && ffmpegCmd && (
                <>
                  <textarea className="cmd" readOnly value={ffmpegCmd} />
                  <div className="wave-tools">
                    <button
                      className="btn small"
                      onClick={async () => say((await copyText(ffmpegCmd)) ? 'Copied' : 'Copy failed — select the text')}
                    >
                      Copy
                    </button>
                    <span>Re-encodes with x264 CRF 18 and AAC. Run it in the folder that holds the file.</span>
                  </div>
                </>
              )}

              <details className="howto">
                <summary>How to get this into Resolve</summary>
                <ol>
                  <li>
                    Import the original file into the media pool first. Leave it selected in the bin.
                  </li>
                  <li>
                    <strong>Cut list EDL:</strong> File › Import › Timeline, choose the <code>.edl</code>, set the frame
                    rate to match, and untick <em>Assist using reel names</em>. Resolve links every event to the clip by
                    timecode and clip name. The result is the ripple-deleted timeline.
                  </li>
                  <li>
                    <strong>Marker EDL:</strong> put the clip on a timeline starting at the Timeline start TC above, then
                    Timeline › Import › Timeline Markers from EDL. Each silence becomes a coloured span to step through
                    before cutting anything.
                  </li>
                  <li>
                    <strong>FCPXML:</strong> File › Import › Timeline. With the media folder filled in it relinks on
                    its own; otherwise point Resolve at the file when asked. Premiere and Final Cut read it too.
                  </li>
                  <li>
                    <strong>Source start TC</strong> must match what Resolve shows for the clip. Camera files carry it
                    in a timecode track and it is read automatically; a phone or screen recording starts at
                    00:00:00:00.
                  </li>
                </ol>
              </details>
            </section>

            <section className="panel">
              <h2>Silences ({gaps.length})</h2>
              <div className="segs-wrap">
                <table className="segs">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Length</th>
                      <th>Source TC in</th>
                      <th>Source TC out</th>
                      <th>Frames</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.silences.map((s, i) => {
                      const g = gaps[i]
                      return (
                        <tr
                          key={i}
                          className={`row${i === currentSilence ? ' current' : ''}`}
                          onClick={() => seek(Math.max(0, s.start - 0.5))}
                        >
                          <td>{i + 1}</td>
                          <td>{formatSeconds(s.start)}</td>
                          <td>{formatSeconds(s.end)}</td>
                          <td>{(s.end - s.start).toFixed(2)} s</td>
                          <td>{g && sourceFrames !== null ? framesToTc(sourceFrames + g.start, fps, df) : '—'}</td>
                          <td>{g && sourceFrames !== null ? framesToTc(sourceFrames + g.end, fps, df) : '—'}</td>
                          <td>{g ? g.end - g.start : '—'}</td>
                        </tr>
                      )
                    })}
                    {result.silences.length === 0 && (
                      <tr>
                        <td colSpan={7}>Nothing below the threshold for long enough. Raise it, or shorten the minimum.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </main>
        </div>
      )}

      <footer className="foot">
        Dead Air runs entirely in your browser. Resolve 20.2 and later also have Clip › Audio Operations › Ripple Delete
        Silence built in — this tool is for review-first marker passes, batch prep, and cutting outside Resolve.
      </footer>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
