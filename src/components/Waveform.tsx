import { useCallback, useEffect, useRef, useState } from 'react'
import type { Envelope, Range } from '../types'
import { formatSeconds } from '../lib/timecode'

const DB_TOP = 0
const DB_BOTTOM = -80

interface Props {
  env: Envelope
  silences: Range[]
  thresholdDb: number
  currentTime: number
  onThreshold: (db: number) => void
  onSeek: (sec: number) => void
}

interface View {
  start: number
  len: number
}

/**
 * The picture of the decision. RMS loudness in dB as a filled area, peaks
 * behind it, the threshold as a draggable line, and every span the detector
 * would cut shaded red. Wheel pans, ctrl/cmd-wheel zooms about the cursor,
 * click seeks. Drawn straight to a canvas: an hour is 360 000 bins, far past
 * what the DOM should hold.
 */
export function Waveform({ env, silences, thresholdDb, currentTime, onThreshold, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<View>({ start: 0, len: env.duration })
  const [hoverThreshold, setHoverThreshold] = useState(false)
  const dragging = useRef(false)
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => setView({ start: 0, len: env.duration }), [env])

  const dbToY = useCallback((db: number, h: number) => {
    const t = (Math.min(DB_TOP, Math.max(DB_BOTTOM, db)) - DB_BOTTOM) / (DB_TOP - DB_BOTTOM)
    return h - t * h
  }, [])

  // Drawing.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW === 0 || cssH === 0) return
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = cssW
    const h = cssH
    ctx.clearRect(0, 0, w, h)

    const secPerPx = view.len / w
    const xOf = (sec: number) => (sec - view.start) / secPerPx

    // Grid: dB lines.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.font = '10px ui-monospace, Menlo, monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    for (let db = -70; db <= -10; db += 10) {
      const y = Math.round(dbToY(db, h)) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      ctx.fillText(`${db}`, 3, y - 2)
    }

    // Silences.
    ctx.fillStyle = 'rgba(199,75,75,0.28)'
    for (const s of silences) {
      if (s.end < view.start || s.start > view.start + view.len) continue
      const x0 = Math.max(0, xOf(s.start))
      const x1 = Math.min(w, xOf(s.end))
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h)
    }

    // Peaks (behind) and RMS (in front), one column per CSS pixel.
    const { db, peak, hopSec } = env
    const peakPath = new Path2D()
    const rmsPath = new Path2D()
    peakPath.moveTo(0, h)
    rmsPath.moveTo(0, h)
    for (let x = 0; x < w; x++) {
      const t0 = view.start + x * secPerPx
      const t1 = t0 + secPerPx
      let b0 = Math.floor(t0 / hopSec)
      let b1 = Math.ceil(t1 / hopSec)
      if (b1 <= b0) b1 = b0 + 1
      b0 = Math.max(0, b0)
      b1 = Math.min(db.length, b1)
      let maxDb = DB_BOTTOM
      let maxPk = 0
      for (let b = b0; b < b1; b++) {
        if (db[b] > maxDb) maxDb = db[b]
        if (peak[b] > maxPk) maxPk = peak[b]
      }
      const pkDb = maxPk > 0 ? 20 * Math.log10(maxPk) : DB_BOTTOM
      peakPath.lineTo(x, dbToY(pkDb, h))
      rmsPath.lineTo(x, dbToY(maxDb, h))
    }
    peakPath.lineTo(w, h)
    rmsPath.lineTo(w, h)
    peakPath.closePath()
    rmsPath.closePath()
    ctx.fillStyle = 'rgba(232,198,106,0.22)'
    ctx.fill(peakPath)
    ctx.fillStyle = 'rgba(232,198,106,0.75)'
    ctx.fill(rmsPath)

    // Threshold.
    const ty = Math.round(dbToY(thresholdDb, h)) + 0.5
    ctx.strokeStyle = '#ff9a9a'
    ctx.lineWidth = hoverThreshold ? 2 : 1
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(0, ty)
    ctx.lineTo(w, ty)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ff9a9a'
    ctx.fillText(`${thresholdDb} dB`, w - 48, ty - 3)

    // Time ruler along the bottom.
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    const step = niceStep(view.len / Math.max(1, w / 90))
    const first = Math.ceil(view.start / step) * step
    for (let t = first; t <= view.start + view.len; t += step) {
      const x = Math.round(xOf(t)) + 0.5
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      ctx.beginPath()
      ctx.moveTo(x, h - 12)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.fillText(formatSeconds(t), x + 3, h - 3)
    }

    // Playhead.
    if (currentTime >= view.start && currentTime <= view.start + view.len) {
      const x = Math.round(xOf(currentTime)) + 0.5
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
  }, [env, silences, thresholdDb, currentTime, view, hoverThreshold, dbToY])

  // Redraw on resize.
  const [, bump] = useState(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => bump((n) => n + 1))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  const yToDb = (y: number, h: number) => Math.round(DB_BOTTOM + (1 - y / h) * (DB_TOP - DB_BOTTOM))

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const y = e.clientY - rect.top
    const ty = dbToY(thresholdDb, rect.height)
    if (Math.abs(y - ty) <= 7) {
      dragging.current = true
      canvas.setPointerCapture(e.pointerId)
      return
    }
    const x = e.clientX - rect.left
    onSeek(view.start + (x / rect.width) * view.len)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const y = e.clientY - rect.top
    if (dragging.current) {
      onThreshold(Math.max(-80, Math.min(-5, yToDb(y, rect.height))))
      return
    }
    setHoverThreshold(Math.abs(y - dbToY(thresholdDb, rect.height)) <= 7)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragging.current) {
      dragging.current = false
      canvasRef.current?.releasePointerCapture(e.pointerId)
    }
  }

  // Wheel: native listener so preventDefault works (React's is passive).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const frac = (e.clientX - rect.left) / rect.width
        const at = v.start + frac * v.len
        const factor = Math.exp(e.deltaY * 0.01)
        const len = clamp(v.len * factor, Math.min(1, env.duration), env.duration)
        const start = clamp(at - frac * len, 0, env.duration - len)
        setView({ start, len })
      } else {
        const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (v.len / rect.width)
        setView({ start: clamp(v.start + delta, 0, env.duration - v.len), len: v.len })
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [env.duration])

  const zoom = (factor: number) => {
    const v = viewRef.current
    const centre = currentTime >= v.start && currentTime <= v.start + v.len ? currentTime : v.start + v.len / 2
    const len = clamp(v.len * factor, Math.min(1, env.duration), env.duration)
    setView({ start: clamp(centre - len / 2, 0, env.duration - len), len })
  }

  return (
    <div className="wave-wrap">
      <canvas
        ref={canvasRef}
        className={`wave${hoverThreshold ? ' threshold-hover' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverThreshold(false)}
        aria-label="Loudness over time with silences shaded"
      />
      <div className="wave-tools">
        <button className="btn small" onClick={() => zoom(0.5)} title="Zoom in">
          +
        </button>
        <button className="btn small" onClick={() => zoom(2)} title="Zoom out">
          −
        </button>
        <button className="btn small" onClick={() => setView({ start: 0, len: env.duration })} title="Fit whole file">
          fit
        </button>
        <span>
          {formatSeconds(view.start)} – {formatSeconds(view.start + view.len)}
        </span>
        <span className="sp" />
        <span>drag the dashed line to set the threshold · click to seek · wheel pans · ⌘/ctrl+wheel zooms</span>
      </div>
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function niceStep(raw: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  for (const s of steps) if (s >= raw) return s
  return 3600
}
