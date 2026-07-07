import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { clamp, dist, elBBox, bboxOf, inkPathD, pathLength, rdp, inkFromAbs, recognize, computeSnap, quantizeElements } from './logic.js'

/* ============================================================
   OPEN CANVAS — Stage 1
   Infinite, calm, open-world canvas for structural thinking.
   Tokens (deterministic):
     paper   #F4F0E6  warm beige
     ink     #1A1A1A
     inkDim  rgba(26,26,26,0.3)   (empty-state hairline)
     accent  #E34234              (selection / snap guides)
   ============================================================ */

const PAPER = '#F4F0E6'
const INK = '#1A1A1A'
const INK_DIM = 'rgba(26,26,26,0.30)'
const ACCENT = '#E34234'
const ACCENT_60 = 'rgba(227,66,52,0.60)'

/* muted, faded fill palette — soft charcoal first (default) */
const PALETTE = [
  '#4A4741', // warm charcoal — softer than pure ink
  '#B0685C', // dusty terracotta
  '#B89B5E', // faded ochre
  '#7F9183', // sage
  '#7C8DA0', // dusty blue
  '#8E7B94', // muted plum
]

const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
const DEFAULT_SIZE = 40      // world units (~40px at 100%)
const SNAP_PX = 8            // screen px snap threshold
const TAP_PX = 6             // screen px movement tolerance for a tap
const LONG_PRESS_MS = 420
const DOUBLE_TAP_MS = 350
const HISTORY_MAX = 50

let _uid = 1
const uid = (p = 'e') => p + (_uid++).toString(36) + Date.now().toString(36).slice(-4)

/* equilateral triangle (pointing up) inscribed in the element's size circle */
const triPoints = (x, y, size) => [-90, 30, 150]
  .map(a => { const r = size / 2, q = a * Math.PI / 180; return `${x + r * Math.cos(q)},${y + r * Math.sin(q)}` })
  .join(' ')

const rotXf = (el) => (el.rotation ? `rotate(${el.rotation} ${el.x} ${el.y})` : undefined)

/* ---------- document helpers ---------- */

const newPage = (name) => ({ id: uid('p'), name, elements: [] })

const initialDoc = () => {
  const p = newPage('Page 1')
  return { pages: [p], library: [] }
}

const updatePage = (doc, pageId, fn) => ({
  ...doc,
  pages: doc.pages.map(p => (p.id === pageId ? fn(p) : p)),
})

const groupMembers = (page, groupId) => page.elements.filter(e => e.groupId === groupId)

/* Group axis: horizontal if wider than tall */
const groupAxis = (members) => {
  const bb = bboxOf(members)
  return bb.w >= bb.h ? 'x' : 'y'
}

function redistribute(members) {
  const axis = groupAxis(members)
  const sorted = [...members].sort((a, b) => a[axis] - b[axis])
  const n = sorted.length
  if (n < 3) return members
  const first = sorted[0][axis], last = sorted[n - 1][axis]
  return members.map(m => {
    const i = sorted.indexOf(m)
    return { ...m, [axis]: first + ((last - first) * i) / (n - 1) }
  })
}

function regroupCount(members, newN) {
  const axis = groupAxis(members)
  const sorted = [...members].sort((a, b) => a[axis] - b[axis])
  const oldN = sorted.length
  const first = sorted[0], last = sorted[oldN - 1]
  const a = first[axis], b = last[axis]
  const perp = axis === 'x' ? 'y' : 'x'
  const perpVal = sorted.reduce((s, m) => s + m[perp], 0) / oldN
  const out = []
  for (let i = 0; i < newN; i++) {
    const t = newN === 1 ? 0.5 : i / (newN - 1)
    const src = sorted[Math.round(t * (oldN - 1))]
    out.push({
      ...src,
      id: uid(),
      [axis]: a + (b - a) * t,
      [perp]: perpVal,
      filled: src.filled,
    })
  }
  return out
}

/* ============================================================
   App
   ============================================================ */

export default function App() {
  /* ----- document (undoable) ----- */
  const [doc, setDoc] = useState(initialDoc)
  const undoStack = useRef([])
  const redoStack = useRef([])
  const docRef = useRef(doc); docRef.current = doc

  const pushHistory = useCallback((snapshot) => {
    undoStack.current.push(snapshot)
    if (undoStack.current.length > HISTORY_MAX) undoStack.current.shift()
    redoStack.current = []
  }, [])

  const commit = useCallback((updater) => {
    setDoc(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (next === prev) return prev
      undoStack.current.push(prev)
      if (undoStack.current.length > HISTORY_MAX) undoStack.current.shift()
      redoStack.current = []
      return next
    })
  }, [])

  const setLive = setDoc // no history — used during drags

  const undo = useCallback(() => {
    if (!undoStack.current.length) return
    redoStack.current.push(docRef.current)
    setDoc(undoStack.current.pop())
  }, [])
  const redo = useCallback(() => {
    if (!redoStack.current.length) return
    undoStack.current.push(docRef.current)
    setDoc(redoStack.current.pop())
  }, [])

  /* ----- page / view ----- */
  const [pageId, setPageId] = useState(doc.pages[0].id)
  const pageIdRef = useRef(pageId); pageIdRef.current = pageId
  const page = doc.pages.find(p => p.id === pageId) || doc.pages[0]
  const pageRef = useRef(page); pageRef.current = page

  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 })
  const viewRef = useRef(view); viewRef.current = view
  const viewMemory = useRef({}) // pageId -> view

  const switchPage = (id) => {
    if (id === pageIdRef.current) return
    viewMemory.current[pageIdRef.current] = viewRef.current
    setPageId(id)
    setView(viewMemory.current[id] || { tx: 0, ty: 0, scale: 1 })
    setSel(new Set()); setSelectMode(false)
  }

  /* ----- selection / UI state ----- */
  const [sel, setSel] = useState(new Set())
  const selRef = useRef(sel); selRef.current = sel
  const [selectMode, setSelectMode] = useState(false)
  const selectModeRef = useRef(selectMode); selectModeRef.current = selectMode
  const [tool, setTool] = useState(null) // 'circle' | 'square' | 'draw' | null
  const toolRef = useRef(tool); toolRef.current = tool
  const [activeColor, setActiveColor] = useState(PALETTE[0])
  const activeColorRef = useRef(activeColor); activeColorRef.current = activeColor
  const [penWidth, setPenWidth] = useState(2.5) // world units: 1.25 fine / 2.5 regular / 5 bold
  const penWidthRef = useRef(penWidth); penWidthRef.current = penWidth
  const [colorTarget, setColorTarget] = useState('fill') // 'fill' | 'line' — what palette taps recolor on a selection
  const colorTargetRef = useRef(colorTarget); colorTargetRef.current = colorTarget
  const [marquee, setMarquee] = useState(null) // {x1,y1,x2,y2} world
  const [drawing, setDrawing] = useState(null) // {pts:[{x,y}], color, preview} world
  const [guides, setGuides] = useState(null)
  const [ghost, setGhost] = useState(null) // {x,y,shape} or {x,y,asset} screen coords
  const [libOpen, setLibOpen] = useState(false)
  const [pagesOpen, setPagesOpen] = useState(false)
  const [renaming, setRenaming] = useState(null)

  const svgRef = useRef(null)
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const longTimer = useRef(null)
  const spaceDown = useRef(false)
  const lastCanvasTap = useRef(null)

  /* select an id — grouped elements always select their whole group */
  const expandSel = useCallback((ids) => {
    const p = pageRef.current
    const out = new Set()
    for (const id of ids) {
      const el = p.elements.find(e => e.id === id)
      if (!el) continue
      if (el.groupId) groupMembers(p, el.groupId).forEach(m => out.add(m.id))
      else out.add(id)
    }
    return out
  }, [])

  const toScreen = (wx, wy) => {
    const v = viewRef.current
    return { x: wx * v.scale + v.tx, y: wy * v.scale + v.ty }
  }
  const toWorld = (sx, sy) => {
    const v = viewRef.current
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale }
  }

  /* ----- zoom to fit ----- */
  const zoomToFit = useCallback(() => {
    const els = pageRef.current.elements
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!els.length) { setView({ tx: rect.width / 2, ty: rect.height / 2, scale: 1 }); return }
    const bb = bboxOf(els)
    const m = 80
    const scale = clamp(Math.min((rect.width - m * 2) / Math.max(bb.w, 1), (rect.height - m * 2) / Math.max(bb.h, 1)), MIN_ZOOM, Math.min(MAX_ZOOM, 2))
    setView({ tx: rect.width / 2 - bb.cx * scale, ty: rect.height / 2 - bb.cy * scale, scale })
  }, [])

  /* ----- mutations ----- */
  const placeElement = useCallback((shape, wx, wy, withSnap = true) => {
    const p = pageRef.current
    let el = { id: uid(), shape, x: wx, y: wy, size: DEFAULT_SIZE, filled: false, color: activeColorRef.current, strokeColor: activeColorRef.current, weight: 1.25, groupId: null }
    if (withSnap) {
      const th = SNAP_PX / viewRef.current.scale
      const { ax, ay } = computeSnap([el], p.elements, th)
      el = { ...el, x: el.x + ax, y: el.y + ay }
    }
    commit(d => updatePage(d, p.id, pg => ({ ...pg, elements: [...pg.elements, el] })))
  }, [commit])

  /* tap: empty → fill with active color; filled in another color → recolor; same color → empty */
  const toggleFill = useCallback((id) => {
    const c = activeColorRef.current
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => {
        if (e.id !== id) return e
        if (e.type === 'ink' && !e.closed) return { ...e, color: c } // open stroke: recolor
        if (!e.filled) return { ...e, filled: true, color: c }
        if ((e.color || INK) !== c) return { ...e, color: c }
        return { ...e, filled: false }
      }),
    })))
  }, [commit])

  /* palette tap on a selection recolors the active target: fill or line */
  const applyColorToSelection = useCallback((c) => {
    const ids = selRef.current
    if (!ids.size) return
    const target = colorTargetRef.current
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => {
        if (!ids.has(e.id)) return e
        if (e.type === 'ink') return { ...e, color: c } // ink has one color
        if (target === 'line') return { ...e, strokeColor: c }
        return { ...e, filled: true, color: c }
      }),
    })))
  }, [commit])

  const deleteSelection = useCallback(() => {
    const ids = selRef.current
    if (!ids.size) return
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.filter(e => !ids.has(e.id)),
    })))
    setSel(new Set()); setSelectMode(false)
  }, [commit])

  const duplicateSelection = useCallback(() => {
    const ids = selRef.current
    if (!ids.size) return
    const p = pageRef.current
    const src = p.elements.filter(e => ids.has(e.id))
    const groupMap = {}
    const copies = src.map(e => {
      let g = null
      if (e.groupId) { groupMap[e.groupId] = groupMap[e.groupId] || uid('g'); g = groupMap[e.groupId] }
      return { ...e, id: uid(), x: e.x + 24, y: e.y + 24, groupId: g }
    })
    commit(d => updatePage(d, p.id, pg => ({ ...pg, elements: [...pg.elements, ...copies] })))
    setSel(new Set(copies.map(c => c.id)))
  }, [commit])

  const groupSelection = useCallback(() => {
    const ids = selRef.current
    if (ids.size < 2) return
    const g = uid('g')
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => (ids.has(e.id) ? { ...e, groupId: g } : e)),
    })))
  }, [commit])

  const ungroupSelection = useCallback(() => {
    const ids = selRef.current
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => (ids.has(e.id) ? { ...e, groupId: null } : e)),
    })))
  }, [commit])

  const redistributeGroup = useCallback((gid) => {
    commit(d => updatePage(d, pageIdRef.current, pg => {
      const members = groupMembers(pg, gid)
      const next = redistribute(members)
      const map = Object.fromEntries(next.map(m => [m.id, m]))
      return { ...pg, elements: pg.elements.map(e => map[e.id] || e) }
    }))
  }, [commit])

  const setGroupCount = useCallback((gid, n) => {
    n = clamp(n, 1, 64)
    let newIds = null
    commit(d => updatePage(d, pageIdRef.current, pg => {
      const members = groupMembers(pg, gid)
      if (members.length === n || members.length < 2) return pg
      const fresh = regroupCount(members, n).map(m => ({ ...m, groupId: gid }))
      newIds = fresh.map(m => m.id)
      return { ...pg, elements: [...pg.elements.filter(e => e.groupId !== gid), ...fresh] }
    }))
    if (newIds) setSel(new Set(newIds))
  }, [commit])

  const duplicateGroupBelow = useCallback((gid) => {
    let newIds = null
    commit(d => updatePage(d, pageIdRef.current, pg => {
      const members = groupMembers(pg, gid)
      if (!members.length) return pg
      const bb = bboxOf(members)
      const avg = members.reduce((s, m) => s + (m.size || elBBox(m).b - elBBox(m).t), 0) / members.length
      const dy = bb.h + avg * 1.2
      const g2 = uid('g')
      const copies = members.map(m => ({ ...m, id: uid(), y: m.y + dy, groupId: g2 }))
      newIds = copies.map(c => c.id)
      return { ...pg, elements: [...pg.elements, ...copies] }
    }))
    if (newIds) setSel(new Set(newIds))
  }, [commit])

  /* scale the whole selection around its collective center */
  const scaleSelection = useCallback((f) => {
    const ids = selRef.current
    if (!ids.size) return
    const els = pageRef.current.elements.filter(e => ids.has(e.id))
    const bb = bboxOf(els)
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => {
        if (!ids.has(e.id)) return e
        const x = bb.cx + (e.x - bb.cx) * f
        const y = bb.cy + (e.y - bb.cy) * f
        if (e.type === 'ink') {
          return { ...e, x, y, points: e.points.map(([dx, dy]) => [dx * f, dy * f]) }
        }
        return { ...e, x, y, size: clamp(e.size * f, 8, 1600) }
      }),
    })))
  }, [commit])

  /* set stroke weight on selected ink strokes / element outlines */
  const setSelWeight = useCallback((w) => {
    const ids = selRef.current
    if (!ids.size) return
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => {
        if (!ids.has(e.id)) return e
        if (e.type === 'ink') return { ...e, width: w }
        return { ...e, weight: w }
      }),
    })))
  }, [commit])

  /* Quantize — conservative auto-structure; pure logic in logic.js */
  const quantize = useCallback(() => {
    commit(d => updatePage(d, pageIdRef.current, pg => {
      const next = quantizeElements(pg.elements, selRef.current)
      return next ? { ...pg, elements: next } : pg
    }))
  }, [commit])

  const saveAsset = useCallback(() => {
    const ids = selRef.current
    if (!ids.size) return
    const p = pageRef.current
    const src = p.elements.filter(e => ids.has(e.id))
    const bb = bboxOf(src)
    const grouped = src.length > 1 && src.every(e => e.groupId && e.groupId === src[0].groupId)
    const items = src.map(e => e.type === 'ink'
      ? { type: 'ink', dx: e.x - bb.cx, dy: e.y - bb.cy, points: e.points, closed: e.closed, filled: e.filled, color: e.color || INK, width: e.width, rotation: e.rotation }
      : { shape: e.shape, dx: e.x - bb.cx, dy: e.y - bb.cy, size: e.size, filled: e.filled, color: e.color || INK, strokeColor: e.strokeColor || INK, weight: e.weight, rotation: e.rotation })
    const asset = { id: uid('a'), items, grouped, w: bb.w, h: bb.h }
    commit(d => ({ ...d, library: [...d.library, asset] }))
    setLibOpen(true)
  }, [commit])

  const deleteAsset = useCallback((aid) => {
    commit(d => ({ ...d, library: d.library.filter(a => a.id !== aid) }))
  }, [commit])

  const placeAsset = useCallback((asset, wx, wy) => {
    const p = pageRef.current
    const g = asset.grouped ? uid('g') : null
    let els = asset.items.map(it => it.type === 'ink'
      ? { id: uid(), type: 'ink', x: wx + it.dx, y: wy + it.dy, points: it.points, closed: it.closed, filled: it.filled, color: it.color || INK, width: it.width, rotation: it.rotation, groupId: g }
      : { id: uid(), shape: it.shape, x: wx + it.dx, y: wy + it.dy, size: it.size, filled: it.filled, color: it.color || INK, strokeColor: it.strokeColor || INK, weight: it.weight, rotation: it.rotation, groupId: g })
    const th = SNAP_PX / viewRef.current.scale
    const { ax, ay } = computeSnap(els, p.elements, th)
    els = els.map(e => ({ ...e, x: e.x + ax, y: e.y + ay }))
    commit(d => updatePage(d, p.id, pg => ({ ...pg, elements: [...pg.elements, ...els] })))
    setSel(new Set(els.map(e => e.id)))
  }, [commit])

  /* ============================================================
     gestures
     ============================================================ */

  const clearLongTimer = () => { if (longTimer.current) { clearTimeout(longTimer.current); longTimer.current = null } }

  /* a primary pointerdown starts a fresh interaction — purge any ghost
     pointers left behind when the OS swallowed a pointerup mid-gesture */
  const trackPointer = (e) => {
    if (e.isPrimary) pointers.current.clear()
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }

  const startPinchIfTwo = () => {
    if (pointers.current.size !== 2) return false
    const [p1, p2] = [...pointers.current.values()]
    if (dist(p1, p2) < 20) return false // two real fingers never land this close — ghost pointer
    clearLongTimer()
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const v = viewRef.current
    gesture.current = {
      type: 'pinch',
      d0: dist(p1, p2),
      view0: v,
      world0: { x: (c.x - v.tx) / v.scale, y: (c.y - v.ty) / v.scale },
    }
    setGuides(null)
    setDrawing(null)
    setMarquee(null)
    return true
  }

  const beginElementGesture = (id, e) => {
    e.stopPropagation()
    const pt = { x: e.clientX, y: e.clientY }
    trackPointer(e)
    if (startPinchIfTwo()) return
    if (spaceDown.current) { beginCanvasGesture(e, true); return }

    const p = pageRef.current
    const el = p.elements.find(x => x.id === id)
    if (!el) return

    // dragged set: current selection if el belongs to it, else el (or its whole group)
    let movingIds
    if (selRef.current.has(id) && selRef.current.size > 1) movingIds = new Set(selRef.current)
    else movingIds = expandSel([id])

    const startPos = {}
    for (const e2 of p.elements) if (movingIds.has(e2.id)) startPos[e2.id] = { x: e2.x, y: e2.y }

    gesture.current = {
      type: 'element', id, start: pt, world0: toWorld(pt.x, pt.y),
      movingIds, startPos, moved: false, longPressed: false,
      docBefore: docRef.current,
    }

    clearLongTimer()
    longTimer.current = setTimeout(() => {
      const g = gesture.current
      if (!g || g.type !== 'element' || g.moved) return
      g.longPressed = true
      // long-press: enter select mode / add to selection
      const add = expandSel([id])
      if (selectModeRef.current) {
        setSel(prev => { const n = new Set(prev); add.forEach(x => n.add(x)); return n })
      } else {
        setSelectMode(true)
        setSel(add)
      }
      if (navigator.vibrate) navigator.vibrate(10)
    }, LONG_PRESS_MS)
  }

  const beginCanvasGesture = (e, forcePan = false) => {
    const pt = { x: e.clientX, y: e.clientY }
    trackPointer(e)
    if (startPinchIfTwo()) return
    if (toolRef.current === 'draw' && !forcePan) {
      const w = toWorld(pt.x, pt.y)
      gesture.current = { type: 'draw', pts: [w], lastScreen: pt, snapped: null, holdTimer: null }
      setDrawing({ pts: [w], color: activeColorRef.current, preview: null })
      return
    }
    const g = { type: 'canvas', start: pt, view0: viewRef.current, moved: false, forcePan }
    gesture.current = g
    // long-press on the canvas turns the gesture into a selection marquee
    if (!forcePan) {
      clearLongTimer()
      longTimer.current = setTimeout(() => {
        if (gesture.current !== g || g.moved) return
        gesture.current = { type: 'marquee', start: pt, world0: toWorld(pt.x, pt.y), moved: false }
        if (navigator.vibrate) navigator.vibrate(10)
      }, LONG_PRESS_MS)
    }
  }

  const beginRotateGesture = (el, e) => {
    e.stopPropagation()
    trackPointer(e)
    gesture.current = { type: 'rotate', id: el.id, docBefore: docRef.current }
  }

  const beginHandleGesture = (el, e) => {
    e.stopPropagation()
    const pt = { x: e.clientX, y: e.clientY }
    trackPointer(e)
    gesture.current = { type: 'resize', id: el.id, docBefore: docRef.current }
  }

  const onPointerMove = useCallback((e) => {
    if (!pointers.current.has(e.pointerId)) return
    const pt = { x: e.clientX, y: e.clientY }
    // plain update — never clear here, or a moving primary finger would
    // wipe the second finger out of the map and kill the pinch
    pointers.current.set(e.pointerId, pt)
    const g = gesture.current
    if (!g) return

    if (g.type === 'pinch') {
      if (pointers.current.size < 2) return
      const [p1, p2] = [...pointers.current.values()]
      const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      const scale = clamp(g.view0.scale * (dist(p1, p2) / g.d0), MIN_ZOOM, MAX_ZOOM)
      setView({ scale, tx: c.x - g.world0.x * scale, ty: c.y - g.world0.y * scale })
      return
    }

    if (g.type === 'canvas') {
      const dx = pt.x - g.start.x, dy = pt.y - g.start.y
      if (!g.moved && Math.hypot(dx, dy) > TAP_PX) { g.moved = true; clearLongTimer() }
      if (g.moved) setView({ ...g.view0, tx: g.view0.tx + dx, ty: g.view0.ty + dy })
      return
    }

    if (g.type === 'draw') {
      if (dist(pt, g.lastScreen) < 1.5) return
      g.lastScreen = pt
      g.pts.push(toWorld(pt.x, pt.y))
      if (g.snapped) g.snapped = null // kept moving — cancel the snap
      if (g.holdTimer) clearTimeout(g.holdTimer)
      g.holdTimer = setTimeout(() => {
        const rec = recognize(g.pts)
        if (rec && gesture.current === g) {
          g.snapped = rec
          setDrawing(d => (d ? { ...d, preview: rec } : d))
        }
      }, 500)
      setDrawing(d => (d ? { ...d, pts: g.pts.slice(), preview: null } : d))
      return
    }

    if (g.type === 'marquee') {
      if (!g.moved && dist(pt, g.start) > TAP_PX) g.moved = true
      if (!g.moved) return
      const w = toWorld(pt.x, pt.y)
      const rect = {
        x1: Math.min(g.world0.x, w.x), y1: Math.min(g.world0.y, w.y),
        x2: Math.max(g.world0.x, w.x), y2: Math.max(g.world0.y, w.y),
      }
      setMarquee(rect)
      const hit = pageRef.current.elements.filter(el => {
        const bb = elBBox(el)
        return bb.r >= rect.x1 && bb.l <= rect.x2 && bb.b >= rect.y1 && bb.t <= rect.y2
      }).map(el => el.id)
      setSel(expandSel(hit))
      return
    }

    if (g.type === 'element') {
      const dxs = pt.x - g.start.x, dys = pt.y - g.start.y
      if (!g.moved && Math.hypot(dxs, dys) > TAP_PX) { g.moved = true; clearLongTimer() }
      if (!g.moved) return
      const v = viewRef.current
      const rawDx = dxs / v.scale, rawDy = dys / v.scale
      const p = pageRef.current
      const movingRaw = p.elements.filter(el => g.movingIds.has(el.id)).map(el => ({
        ...el, x: g.startPos[el.id].x + rawDx, y: g.startPos[el.id].y + rawDy,
      }))
      const statics = p.elements.filter(el => !g.movingIds.has(el.id))
      const th = SNAP_PX / v.scale
      const { ax, ay, guides: gd } = computeSnap(movingRaw, statics, th)
      setGuides(gd)
      setLive(d => updatePage(d, p.id, pg => ({
        ...pg,
        elements: pg.elements.map(el => g.movingIds.has(el.id)
          ? { ...el, x: g.startPos[el.id].x + rawDx + ax, y: g.startPos[el.id].y + rawDy + ay }
          : el),
      })))
      return
    }

    if (g.type === 'resize') {
      const w = toWorld(pt.x, pt.y)
      const p = pageRef.current
      const el = p.elements.find(x => x.id === g.id)
      if (!el) return
      const size = clamp(Math.max(Math.abs(w.x - el.x), Math.abs(w.y - el.y)) * 2, 12, 600)
      setLive(d => updatePage(d, p.id, pg => ({
        ...pg, elements: pg.elements.map(x => (x.id === g.id ? { ...x, size } : x)),
      })))
      return
    }

    if (g.type === 'rotate') {
      const w = toWorld(pt.x, pt.y)
      const p = pageRef.current
      const el = p.elements.find(x => x.id === g.id)
      if (!el) return
      let ang = Math.atan2(w.y - el.y, w.x - el.x) * 180 / Math.PI + 90
      // magnetic angles: every 15° (0/45/90… included), escapable
      const snapped = Math.round(ang / 15) * 15
      if (Math.abs(ang - snapped) < 6) ang = snapped
      ang = ((ang % 360) + 360) % 360
      setLive(d => updatePage(d, p.id, pg => ({
        ...pg, elements: pg.elements.map(x => (x.id === g.id ? { ...x, rotation: ang % 360 === 0 ? 0 : ang } : x)),
      })))
      return
    }

    if (g.type === 'toolDrag' || g.type === 'libDrag') {
      if (!g.moved && dist(pt, g.start) > TAP_PX) g.moved = true
      if (g.moved) setGhost({ x: pt.x, y: pt.y, shape: g.shape, asset: g.asset })
      return
    }
  }, [])

  const onPointerUp = useCallback((e) => {
    if (!pointers.current.has(e.pointerId)) return
    const pt = { x: e.clientX, y: e.clientY }
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    clearLongTimer()
    if (!g) return

    if (g.type === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null
      return
    }

    gesture.current = null

    if (g.type === 'element') {
      if (g.moved) {
        // commit drag as one history step
        if (docRef.current !== g.docBefore) pushHistory(g.docBefore)
        setGuides(null)
      } else if (!g.longPressed) {
        // tap
        if (selectModeRef.current) {
          const add = expandSel([g.id])
          setSel(prev => {
            const n = new Set(prev)
            const allIn = [...add].every(x => n.has(x))
            if (allIn) add.forEach(x => n.delete(x))
            else add.forEach(x => n.add(x))
            if (!n.size) setSelectMode(false)
            return n
          })
        } else {
          toggleFill(g.id)
        }
      }
      return
    }

    if (g.type === 'resize' || g.type === 'rotate') {
      if (docRef.current !== g.docBefore) pushHistory(g.docBefore)
      return
    }

    if (g.type === 'draw') {
      if (g.holdTimer) clearTimeout(g.holdTimer)
      setDrawing(null)
      const color = activeColorRef.current
      const rec = g.snapped
      const finish = (el) => commit(d => updatePage(d, pageIdRef.current, pg => ({
        ...pg, elements: [...pg.elements, el],
      })))
      const w = penWidthRef.current
      if (rec) {
        if (rec.type === 'circle') {
          finish({ id: uid(), shape: 'circle', x: rec.cx, y: rec.cy, size: rec.r * 2, filled: false, color, strokeColor: color, weight: w, groupId: null })
        } else if (rec.type === 'square') {
          finish({ id: uid(), shape: 'square', x: rec.cx, y: rec.cy, size: rec.size, filled: false, color, strokeColor: color, weight: w, groupId: null })
        } else {
          finish({ id: uid(), ...rec, filled: false, color, width: w, groupId: null })
        }
      } else if (g.pts.length > 2 && pathLength(g.pts) > 10) {
        // keep the freehand stroke, lightly simplified
        const eps = Math.max(0.8, 1.2 / viewRef.current.scale)
        const smooth = rdp(g.pts, eps)
        const ink = inkFromAbs(smooth, false)
        finish({ id: uid(), ...ink, filled: false, color, width: w, groupId: null })
      }
      return
    }

    if (g.type === 'marquee') {
      setMarquee(null)
      if (g.moved) {
        setSelectMode(selRef.current.size > 0)
      } else {
        setSel(new Set()); setSelectMode(false)
      }
      return
    }

    if (g.type === 'canvas') {
      if (!g.moved) {
        // tap on empty canvas
        const now = Date.now()
        const lt = lastCanvasTap.current
        if (lt && now - lt.t < DOUBLE_TAP_MS && dist(lt, pt) < 30) {
          lastCanvasTap.current = null
          zoomToFit()
          return
        }
        lastCanvasTap.current = { ...pt, t: now }
        // dismiss first, create second: a tap while something is selected
        // only clears the selection — it never also places a new element
        if (selRef.current.size) {
          setSel(new Set()); setSelectMode(false)
        } else if (toolRef.current) {
          const w = toWorld(pt.x, pt.y)
          placeElement(toolRef.current, w.x, w.y)
        } else {
          setSel(new Set()); setSelectMode(false)
        }
      }
      return
    }

    if (g.type === 'toolDrag') {
      setGhost(null)
      if (g.moved) {
        const svg = svgRef.current.getBoundingClientRect()
        if (pt.x >= svg.left && pt.x <= svg.right && pt.y >= svg.top && pt.y <= svg.bottom) {
          const w = toWorld(pt.x, pt.y)
          placeElement(g.shape, w.x, w.y)
        }
      } else {
        setTool(t => (t === g.shape ? null : g.shape))
      }
      return
    }

    if (g.type === 'libDrag') {
      setGhost(null)
      if (g.moved) {
        const svg = svgRef.current.getBoundingClientRect()
        if (pt.x >= svg.left && pt.x <= svg.right && pt.y >= svg.top && pt.y <= svg.bottom) {
          const w = toWorld(pt.x, pt.y)
          placeAsset(g.asset, w.x, w.y)
        }
      }
      return
    }
  }, [placeElement, placeAsset, toggleFill, zoomToFit, expandSel, pushHistory])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [onPointerMove, onPointerUp])

  /* wheel: ctrl/cmd = zoom at cursor, else pan */
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e) => {
      e.preventDefault()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        const scale = clamp(v.scale * factor, MIN_ZOOM, MAX_ZOOM)
        const wx = (e.clientX - v.tx) / v.scale, wy = (e.clientY - v.ty) / v.scale
        setView({ scale, tx: e.clientX - wx * scale, ty: e.clientY - wy * scale })
      } else {
        setView({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY })
      }
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    const prevent = (e) => e.preventDefault()
    document.addEventListener('gesturestart', prevent, { passive: false })
    document.addEventListener('gesturechange', prevent, { passive: false })
    return () => {
      svg.removeEventListener('wheel', onWheel)
      document.removeEventListener('gesturestart', prevent)
      document.removeEventListener('gesturechange', prevent)
    }
  }, [])

  /* keyboard */
  useEffect(() => {
    const down = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.code === 'Space') { spaceDown.current = true }
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return }
      if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); groupSelection(); return }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (selRef.current.size) { e.preventDefault(); deleteSelection() } return }
      if (e.key === 'Escape') { setSel(new Set()); setSelectMode(false); setTool(null) }
      if (!mod && e.key.toLowerCase() === 'q') { quantize() }
    }
    const up = (e) => { if (e.code === 'Space') spaceDown.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [undo, redo, duplicateSelection, groupSelection, deleteSelection, quantize])

  /* palette taps go back to recoloring fill when nothing is selected */
  useEffect(() => { if (!sel.size) setColorTarget('fill') }, [sel])

  /* prune selection when elements vanish (undo etc.) */
  useEffect(() => {
    const ids = new Set(page.elements.map(e => e.id))
    setSel(prev => {
      const n = new Set([...prev].filter(id => ids.has(id)))
      return n.size === prev.size ? prev : n
    })
  }, [page.elements])

  /* toolbar / library drag sources */
  const beginToolDrag = (shape) => (e) => {
    e.stopPropagation()
    trackPointer(e)
    gesture.current = { type: 'toolDrag', shape, start: { x: e.clientX, y: e.clientY }, moved: false }
  }
  const beginLibDrag = (asset) => (e) => {
    e.stopPropagation()
    trackPointer(e)
    gesture.current = { type: 'libDrag', asset, start: { x: e.clientX, y: e.clientY }, moved: false }
  }

  /* ============================================================
     derived render data
     ============================================================ */
  const hair = 1 / view.scale
  const selEls = page.elements.filter(e => sel.has(e.id))
  const selBB = bboxOf(selEls)
  const singleGroupId = selEls.length > 1 && selEls.every(e => e.groupId && e.groupId === selEls[0].groupId)
    ? selEls[0].groupId : null
  const singleSel = selEls.length === 1 && !selEls[0].groupId ? selEls[0] : null
  const singleFree = singleSel && singleSel.type !== 'ink' ? singleSel : null
  const anyGrouped = selEls.some(e => e.groupId)

  /* group hairline frames for selected groups */
  const selGroupFrames = useMemo(() => {
    const gids = new Set(selEls.filter(e => e.groupId).map(e => e.groupId))
    return [...gids].map(gid => ({ gid, bb: bboxOf(groupMembers(page, gid)) }))
  }, [selEls, page])

  /* action bar screen position */
  let barPos = null
  if (selBB && sel.size) {
    const s = toScreen(selBB.cx, selBB.t)
    barPos = { x: s.x, y: s.y - 16 }
  }

  const pct = Math.round(view.scale * 100)

  /* compact, icon-based selection panel (rendered above the left dock) */
  const ib = (accent) => ({
    width: 50, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: PAPER, border: 'none', cursor: 'pointer', padding: 0, color: accent ? ACCENT : INK,
  })
  const IB = ({ title, accent, onClick, children }) => (
    <button title={title} onPointerDown={(e) => e.stopPropagation()} onClick={onClick} style={ib(accent)}>{children}</button>
  )
  const svgP = { width: 22, height: 22, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor' }
  const selectionPanel = sel.size > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: INK, border: `1px solid ${INK}` }}>
      {singleGroupId ? (
        <>
          <IB title="Redistribute evenly" onClick={() => redistributeGroup(singleGroupId)}>
            <svg {...svgP}><circle cx="3.5" cy="9" r="1.8" fill="currentColor" stroke="none" /><circle cx="9" cy="9" r="1.8" fill="currentColor" stroke="none" /><circle cx="14.5" cy="9" r="1.8" fill="currentColor" stroke="none" /></svg>
          </IB>
          <div style={{ display: 'flex', background: PAPER, alignItems: 'center', justifyContent: 'space-between' }}>
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setGroupCount(singleGroupId, selEls.length - 1)} style={{ ...ib(), width: 18, fontSize: 15 }}>−</button>
            <span style={{ font: '12px "Helvetica Neue", Inter, sans-serif', color: INK }}>{selEls.length}</span>
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setGroupCount(singleGroupId, selEls.length + 1)} style={{ ...ib(), width: 18, fontSize: 15 }}>+</button>
          </div>
          <IB title="Duplicate below" onClick={() => duplicateGroupBelow(singleGroupId)}>
            <svg {...svgP}><rect x="3" y="2" width="12" height="6.5" rx="1" strokeWidth="1.2" /><path d="M9 10 L9 15 M6.5 12.5 L9 15 L11.5 12.5" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </IB>
          <IB title="Ungroup" onClick={ungroupSelection}>
            <svg {...svgP}><rect x="2" y="3.5" width="7" height="7" rx="1" strokeWidth="1.2" /><rect x="9.5" y="8" width="6.5" height="6.5" rx="1" fill={PAPER} strokeWidth="1.2" /></svg>
          </IB>
        </>
      ) : (
        <>
          <IB title="Duplicate" onClick={duplicateSelection}>
            <svg {...svgP}><rect x="6" y="6" width="9" height="9" rx="1" strokeWidth="1.2" /><rect x="3" y="3" width="9" height="9" rx="1" fill={PAPER} strokeWidth="1.2" /></svg>
          </IB>
          {sel.size > 1 && (
            <IB title="Quantize — auto-align (Q)" onClick={quantize}>
              <svg {...svgP}><line x1="1.5" y1="13.5" x2="16.5" y2="13.5" strokeWidth="1" /><circle cx="4.5" cy="13.5" r="2.2" fill="currentColor" stroke="none" /><circle cx="9" cy="13.5" r="2.2" fill="currentColor" stroke="none" /><circle cx="13.5" cy="4" r="2.2" strokeWidth="1" /><path d="M12 9 L13.5 11 L15 9" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </IB>
          )}
          {sel.size > 1 && !anyGrouped && (
            <IB title="Group" onClick={groupSelection}>
              <svg {...svgP}><rect x="2" y="2" width="14" height="14" rx="1" strokeWidth="1" strokeDasharray="2.5 1.8" /><circle cx="6.5" cy="9" r="1.6" fill="currentColor" stroke="none" /><circle cx="11.5" cy="9" r="1.6" fill="currentColor" stroke="none" /></svg>
            </IB>
          )}
          {anyGrouped && (
            <IB title="Ungroup" onClick={ungroupSelection}>
              <svg {...svgP}><rect x="2" y="3.5" width="7" height="7" rx="1" strokeWidth="1.2" /><rect x="9.5" y="8" width="6.5" height="6.5" rx="1" fill={PAPER} strokeWidth="1.2" /></svg>
            </IB>
          )}
        </>
      )}
      {/* FILL / LINE color target */}
      {(() => {
        const first = selEls[0]
        const fillC = first ? (first.color || INK) : INK
        const lineC = first ? (first.type === 'ink' ? (first.color || INK) : (first.strokeColor || INK)) : INK
        const chip = (target, dot) => (
          <button key={target} onPointerDown={(e) => e.stopPropagation()} onClick={() => setColorTarget(target)}
            title={target === 'fill' ? 'Recolor fill' : 'Recolor outline'}
            style={{ ...ib(), width: 25, borderBottom: colorTarget === target ? `2px solid ${ACCENT}` : '2px solid transparent' }}>
            {dot}
          </button>
        )
        return (
          <div style={{ display: 'flex', background: PAPER, justifyContent: 'center' }}>
            {chip('fill', <span style={{ width: 13, height: 13, borderRadius: '50%', background: fillC, display: 'inline-block' }} />)}
            {chip('line', <span style={{ width: 13, height: 13, borderRadius: '50%', border: `2.5px solid ${lineC}`, display: 'inline-block' }} />)}
          </div>
        )
      })()}
      {/* size */}
      <div style={{ display: 'flex', background: PAPER, alignItems: 'center', justifyContent: 'space-between' }}>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => scaleSelection(1 / 1.2)} title="Smaller" style={{ ...ib(), width: 25, fontSize: 16 }}>−</button>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => scaleSelection(1.2)} title="Larger" style={{ ...ib(), width: 25, fontSize: 16 }}>+</button>
      </div>
      {/* stroke weight */}
      <div style={{ display: 'flex', background: PAPER, gap: 3, justifyContent: 'center', padding: '5px 2px' }}>
        {[1.25, 2.5, 5].map(w => (
          <button key={w} onPointerDown={(e) => e.stopPropagation()} onClick={() => setSelWeight(w)} title={`Stroke ${w}`}
            style={{ width: 13, height: 20, padding: 0, cursor: 'pointer', background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="12" height="16"><line x1="6" y1="2" x2="6" y2="14" stroke={INK} strokeWidth={w === 1.25 ? 1.5 : w === 2.5 ? 3 : 5} strokeLinecap="round" /></svg>
          </button>
        ))}
      </div>
      <IB title="Save as asset" onClick={saveAsset}>
        <svg {...svgP}><path d="M5 2 H13 V16 L9 12.5 L5 16 Z" strokeWidth="1.2" strokeLinejoin="round" /></svg>
      </IB>
      <IB title="Delete" accent onClick={deleteSelection}>
        <svg {...svgP} stroke={ACCENT}><path d="M4 5 H14 M6.5 5 V3.5 H11.5 V5 M5.5 5 L6.2 15 H11.8 L12.5 5" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </IB>
    </div>
  ) : null

  /* ============================================================
     render
     ============================================================ */
  return (
    <div style={{ position: 'fixed', inset: 0, background: PAPER, overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        width="100%" height="100%"
        style={{ display: 'block', touchAction: 'none', cursor: tool ? 'crosshair' : 'default' }}
        onPointerDown={(e) => beginCanvasGesture(e)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {/* elements */}
          {page.elements.map(el => {
            const selected = sel.has(el.id)
            if (el.type === 'ink') {
              const d = inkPathD(el)
              const bb = elBBox(el)
              return (
                <g key={el.id} transform={rotXf(el)} onPointerDown={(e) => beginElementGesture(el.id, e)} style={{ cursor: 'pointer' }}>
                  <path d={d}
                    fill={el.closed ? 'transparent' : 'none'}
                    stroke="transparent" strokeWidth={Math.max(16 / view.scale, 10)}
                    pointerEvents={el.closed ? 'all' : 'stroke'} />
                  <path d={d}
                    fill={el.closed && el.filled ? (el.color || INK) : 'none'}
                    stroke={el.color || INK} strokeWidth={el.width || 2}
                    strokeLinejoin="round" strokeLinecap="round"
                    pointerEvents="none" />
                  {selected && (
                    <rect x={bb.l - 5 / view.scale} y={bb.t - 5 / view.scale}
                      width={bb.r - bb.l + 10 / view.scale} height={bb.b - bb.t + 10 / view.scale}
                      fill="none" stroke={ACCENT} strokeWidth={hair} pointerEvents="none" />
                  )}
                </g>
              )
            }
            const hitR = Math.max(el.size / 2, 20 / view.scale)
            const colored = el.strokeColor && el.strokeColor !== INK
            const outline = colored ? el.strokeColor : (el.weight ? INK : INK_DIM)
            const outlineW = el.weight || hair
            return (
              <g key={el.id} transform={rotXf(el)} onPointerDown={(e) => beginElementGesture(el.id, e)} style={{ cursor: 'pointer' }}>
                {el.shape === 'circle' ? (
                  <>
                    <circle cx={el.x} cy={el.y} r={hitR} fill="transparent" />
                    <circle
                      cx={el.x} cy={el.y} r={el.size / 2}
                      fill={el.filled ? (el.color || INK) : 'transparent'}
                      stroke={outline}
                      strokeWidth={outlineW}
                    />
                    {selected && <circle cx={el.x} cy={el.y} r={el.size / 2 + 4 / view.scale} fill="none" stroke={ACCENT} strokeWidth={hair} />}
                  </>
                ) : el.shape === 'triangle' ? (
                  <>
                    <circle cx={el.x} cy={el.y} r={hitR} fill="transparent" />
                    <polygon
                      points={triPoints(el.x, el.y, el.size)}
                      fill={el.filled ? (el.color || INK) : 'transparent'}
                      stroke={outline}
                      strokeWidth={outlineW}
                      strokeLinejoin="round"
                    />
                    {selected && <circle cx={el.x} cy={el.y} r={el.size / 2 + 4 / view.scale} fill="none" stroke={ACCENT} strokeWidth={hair} />}
                  </>
                ) : (
                  <>
                    <rect x={el.x - hitR} y={el.y - hitR} width={hitR * 2} height={hitR * 2} fill="transparent" />
                    <rect
                      x={el.x - el.size / 2} y={el.y - el.size / 2} width={el.size} height={el.size}
                      fill={el.filled ? (el.color || INK) : 'transparent'}
                      stroke={outline}
                      strokeWidth={outlineW}
                    />
                    {selected && (
                      <rect
                        x={el.x - el.size / 2 - 4 / view.scale} y={el.y - el.size / 2 - 4 / view.scale}
                        width={el.size + 8 / view.scale} height={el.size + 8 / view.scale}
                        fill="none" stroke={ACCENT} strokeWidth={hair}
                      />
                    )}
                  </>
                )}
              </g>
            )
          })}

          {/* selected group frames */}
          {selGroupFrames.map(({ gid, bb }) => bb && (
            <rect key={gid}
              x={bb.l - 10 / view.scale} y={bb.t - 10 / view.scale}
              width={bb.w + 20 / view.scale} height={bb.h + 20 / view.scale}
              fill="none" stroke={ACCENT} strokeWidth={hair} strokeDasharray={`${4 / view.scale} ${3 / view.scale}`}
              pointerEvents="none"
            />
          ))}

          {/* snap guides */}
          {guides && (
            <g pointerEvents="none">
              {guides.v.map((gl, i) => (
                <line key={'v' + i} x1={gl.x} y1={gl.y1} x2={gl.x} y2={gl.y2} stroke={ACCENT_60} strokeWidth={hair} />
              ))}
              {guides.h.map((gl, i) => (
                <line key={'h' + i} x1={gl.x1} y1={gl.y} x2={gl.x2} y2={gl.y} stroke={ACCENT_60} strokeWidth={hair} />
              ))}
              {guides.gapX.map((gp, i) => (
                <g key={'gx' + i}>
                  <line x1={gp.xs[0]} y1={gp.y} x2={gp.xs[2]} y2={gp.y} stroke={ACCENT_60} strokeWidth={hair} />
                  {gp.xs.map((x, j) => (
                    <line key={j} x1={x} y1={gp.y - 6 / view.scale} x2={x} y2={gp.y + 6 / view.scale} stroke={ACCENT_60} strokeWidth={hair} />
                  ))}
                </g>
              ))}
              {guides.gapY.map((gp, i) => (
                <g key={'gy' + i}>
                  <line x1={gp.x} y1={gp.ys[0]} x2={gp.x} y2={gp.ys[2]} stroke={ACCENT_60} strokeWidth={hair} />
                  {gp.ys.map((y, j) => (
                    <line key={j} x1={gp.x - 6 / view.scale} y1={y} x2={gp.x + 6 / view.scale} y2={y} stroke={ACCENT_60} strokeWidth={hair} />
                  ))}
                </g>
              ))}
            </g>
          )}

          {/* live freehand drawing */}
          {drawing && (() => {
            const p = drawing.preview
            const w = penWidth
            if (p) {
              if (p.type === 'circle') {
                return <circle cx={p.cx} cy={p.cy} r={p.r} fill="none" stroke={drawing.color} strokeWidth={w} pointerEvents="none" />
              }
              if (p.type === 'square') {
                return <rect x={p.cx - p.size / 2} y={p.cy - p.size / 2} width={p.size} height={p.size} fill="none" stroke={drawing.color} strokeWidth={w} pointerEvents="none" />
              }
              return <path d={inkPathD(p)} fill="none" stroke={drawing.color} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
            }
            const d = drawing.pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join('')
            return <path d={d} fill="none" stroke={drawing.color} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
          })()}

          {/* marquee selection rectangle */}
          {marquee && (
            <rect
              x={marquee.x1} y={marquee.y1}
              width={marquee.x2 - marquee.x1} height={marquee.y2 - marquee.y1}
              fill="rgba(227,66,52,0.04)" stroke={ACCENT_60} strokeWidth={hair}
              strokeDasharray={`${4 / view.scale} ${3 / view.scale}`}
              pointerEvents="none"
            />
          )}

          {/* resize handles: single free element (rotate with the shape) */}
          {singleFree && (() => {
            const el = singleFree
            const h = el.size / 2 + 4 / view.scale
            const hs = 5 / view.scale
            return (
              <g transform={rotXf(el)}>
                {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([mx, my], i) => (
                  <rect key={i}
                    x={el.x + mx * h - hs} y={el.y + my * h - hs} width={hs * 2} height={hs * 2}
                    fill={PAPER} stroke={ACCENT} strokeWidth={hair}
                    style={{ cursor: 'nwse-resize' }}
                    onPointerDown={(e) => beginHandleGesture(el, e)}
                  />
                ))}
              </g>
            )
          })()}

          {/* rotation handle: single selected element (circles have nothing to rotate) */}
          {singleSel && singleSel.shape !== 'circle' && (() => {
            const el = singleSel
            const bb = elBBox(el)
            const rd = Math.max(bb.r - bb.l, bb.b - bb.t) / 2 + 30 / view.scale
            const ra = ((el.rotation || 0) - 90) * Math.PI / 180
            const hx = el.x + Math.cos(ra) * rd, hy = el.y + Math.sin(ra) * rd
            return (
              <g>
                <line x1={el.x} y1={el.y} x2={hx} y2={hy} stroke={ACCENT_60} strokeWidth={hair} pointerEvents="none" />
                <circle cx={hx} cy={hy} r={20 / view.scale} fill="transparent"
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => beginRotateGesture(el, e)} />
                <circle cx={hx} cy={hy} r={7 / view.scale} fill={PAPER} stroke={ACCENT} strokeWidth={hair}
                  pointerEvents="none" />
              </g>
            )
          })()}
        </g>
      </svg>

      {/* empty-state hint */}
      {page.elements.length === 0 && !tool && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <span style={microLabel(0.35)}>TAP A SHAPE ON THE LEFT · THEN TAP THE CANVAS</span>
        </div>
      )}

      {/* ---- left-edge dock: selection panel (top) + palette + tools ---- */}
      <div style={{
        position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
        display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start',
        maxHeight: '92vh',
      }}>
        {selectionPanel}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {/* palette column (outermost — easiest thumb reach) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '6px 4px', alignItems: 'center' }}>
          {PALETTE.map(c => (
            <button
              key={c}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { setActiveColor(c); if (selRef.current.size) applyColorToSelection(c) }}
              title={c}
              style={{
                width: 28, height: 28, borderRadius: '50%', padding: 0, cursor: 'pointer',
                background: c,
                border: 'none',
                outline: activeColor === c ? `2px solid ${ACCENT}` : '1px solid rgba(26,26,26,0.15)',
                outlineOffset: 3,
              }}
            />
          ))}
          {tool === 'draw' && (
            <>
              <div style={{ height: 1, width: 26, background: 'rgba(26,26,26,0.2)', margin: '2px 0' }} />
              {[1.25, 2.5, 5].map(w => (
                <button
                  key={w}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setPenWidth(w)}
                  title={`Pen ${w}`}
                  style={{
                    width: 34, height: 26, padding: 0, cursor: 'pointer', background: 'transparent',
                    border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    outline: penWidth === w ? `2px solid ${ACCENT}` : '1px solid rgba(26,26,26,0.15)',
                    outlineOffset: 3,
                  }}
                >
                  <svg width="26" height="14">
                    <line x1="3" y1="7" x2="23" y2="7" stroke={INK}
                      strokeWidth={w === 1.25 ? 1.5 : w === 2.5 ? 3.5 : 6} strokeLinecap="round" />
                  </svg>
                </button>
              ))}
            </>
          )}
        </div>
        {/* tools column */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 1, border: `1px solid ${INK}`, background: PAPER,
          touchAction: 'none',
        }}>
        <ToolBtn active={tool === 'circle'} onPointerDown={beginToolDrag('circle')}>
          <svg width="24" height="24" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r="7" fill="none" stroke={tool === 'circle' ? ACCENT : INK} strokeWidth="1" />
          </svg>
        </ToolBtn>
        <ToolBtn active={tool === 'square'} onPointerDown={beginToolDrag('square')}>
          <svg width="24" height="24" viewBox="0 0 18 18">
            <rect x="2.5" y="2.5" width="13" height="13" fill="none" stroke={tool === 'square' ? ACCENT : INK} strokeWidth="1" />
          </svg>
        </ToolBtn>
        <ToolBtn active={tool === 'triangle'} onPointerDown={beginToolDrag('triangle')}>
          <svg width="24" height="24" viewBox="0 0 18 18">
            <polygon points="9,2.5 15.5,14.5 2.5,14.5" fill="none"
              stroke={tool === 'triangle' ? ACCENT : INK} strokeWidth="1" strokeLinejoin="round" />
          </svg>
        </ToolBtn>
        <ToolBtn active={tool === 'draw'} onPointerDown={(e) => e.stopPropagation()} onClick={() => setTool(t => (t === 'draw' ? null : 'draw'))}>
          <svg width="24" height="24" viewBox="0 0 18 18">
            <path d="M2.5 13.5 C 5 4.5, 9 15, 15.5 4" fill="none"
              stroke={tool === 'draw' ? ACCENT : INK} strokeWidth="1" strokeLinecap="round" />
          </svg>
        </ToolBtn>
        <div style={{ height: 1, background: INK }} />
        <ToolBtn onPointerDown={(e) => { e.stopPropagation() }} onClick={quantize} title="Quantize — auto-align everything (Q)">
          {/* a stray dot dropping into place on an aligned row */}
          <svg width="26" height="26" viewBox="0 0 18 18">
            <line x1="1.5" y1="13.5" x2="16.5" y2="13.5" stroke={INK} strokeWidth="1" />
            <circle cx="4.5" cy="13.5" r="2.4" fill={INK} />
            <circle cx="9" cy="13.5" r="2.4" fill={INK} />
            <circle cx="13.5" cy="4" r="2.4" fill="none" stroke={INK} strokeWidth="1" />
            <line x1="13.5" y1="6.8" x2="13.5" y2="10.2" stroke={INK} strokeWidth="1" strokeDasharray="1.6 1.4" />
            <path d="M12 9.2 L13.5 11.2 L15 9.2" fill="none" stroke={INK} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </ToolBtn>
        <div style={{ height: 1, background: INK }} />
        <ToolBtn onPointerDown={(e) => { e.stopPropagation() }} onClick={undo}>
          <span style={{ fontSize: 20, color: INK }}>↺</span>
        </ToolBtn>
        <ToolBtn onPointerDown={(e) => { e.stopPropagation() }} onClick={redo}>
          <span style={{ fontSize: 20, color: INK }}>↻</span>
        </ToolBtn>
        </div>
        </div>
      </div>

      {/* ---- zoom HUD (bottom right) ---- */}
      <div style={{
        position: 'absolute', bottom: 20, right: 16, display: 'flex', gap: 1,
        border: `1px solid ${INK}`, background: PAPER,
      }}>
        <button style={{ ...barBtnStyle, minWidth: 48 }} onClick={() => {
          const svg = svgRef.current.getBoundingClientRect()
          const v = viewRef.current
          const cx = svg.width / 2, cy = svg.height / 2
          const wx = (cx - v.tx) / v.scale, wy = (cy - v.ty) / v.scale
          setView({ scale: 1, tx: cx - wx, ty: cy - wy })
        }}>{pct}%</button>
        <button style={barBtnStyle} onClick={zoomToFit}>FIT</button>
      </div>

      {/* ---- pages sidebar (left) ---- */}
      <div style={{ position: 'absolute', top: 16, left: 16 }}>
        <button style={{ ...barBtnStyle, border: `1px solid ${INK}` }} onClick={() => setPagesOpen(o => !o)}>
          {pagesOpen ? '× PAGES' : 'PAGES'}
        </button>
        {pagesOpen && (
          <div style={{ marginTop: 1, border: `1px solid ${INK}`, background: PAPER, minWidth: 230 }}>
            {doc.pages.map(p => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                borderBottom: `1px solid rgba(26,26,26,0.15)`,
                background: p.id === pageId ? 'rgba(26,26,26,0.06)' : 'transparent',
              }}>
                {renaming === p.id ? (
                  <input
                    autoFocus defaultValue={p.name}
                    style={{
                      flex: 1, border: 'none', outline: 'none', background: 'transparent',
                      font: '13px "Helvetica Neue", Inter, Arial, sans-serif', letterSpacing: '0.08em',
                      padding: '11px 14px', color: INK,
                    }}
                    onBlur={(ev) => {
                      const name = ev.target.value.trim() || p.name
                      commit(d => ({ ...d, pages: d.pages.map(x => x.id === p.id ? { ...x, name } : x) }))
                      setRenaming(null)
                    }}
                    onKeyDown={(ev) => { if (ev.key === 'Enter') ev.target.blur() }}
                  />
                ) : (
                  <button
                    style={{ ...barBtnStyle, flex: 1, textAlign: 'left', textTransform: 'none', letterSpacing: '0.06em' }}
                    onClick={() => switchPage(p.id)}
                    onDoubleClick={() => setRenaming(p.id)}
                  >{p.name}</button>
                )}
                <button title="Duplicate page" style={{ ...barBtnStyle, padding: '8px 6px' }} onClick={() => {
                  const copy = {
                    ...p, id: uid('p'), name: p.name + ' copy',
                    elements: p.elements.map(e => ({ ...e, id: uid() })),
                  }
                  // remap group ids
                  const gmap = {}
                  copy.elements = copy.elements.map(e => {
                    if (!e.groupId) return e
                    gmap[e.groupId] = gmap[e.groupId] || uid('g')
                    return { ...e, groupId: gmap[e.groupId] }
                  })
                  commit(d => ({ ...d, pages: [...d.pages, copy] }))
                }}>⧉</button>
                <button title="Delete page" style={{ ...barBtnStyle, padding: '8px 8px' }} onClick={() => {
                  if (doc.pages.length === 1) return
                  commit(d => ({ ...d, pages: d.pages.filter(x => x.id !== p.id) }))
                  if (p.id === pageId) {
                    const rest = doc.pages.filter(x => x.id !== p.id)
                    switchPage(rest[0].id)
                  }
                }}>×</button>
              </div>
            ))}
            <button style={{ ...barBtnStyle, width: '100%', textAlign: 'left' }} onClick={() => {
              const p = newPage(`Page ${doc.pages.length + 1}`)
              commit(d => ({ ...d, pages: [...d.pages, p] }))
              switchPage(p.id)
            }}>+ NEW PAGE</button>
          </div>
        )}
      </div>

      {/* ---- library panel (right) ---- */}
      <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <button style={{ ...barBtnStyle, border: `1px solid ${INK}` }} onClick={() => setLibOpen(o => !o)}>
          {libOpen ? '× LIBRARY' : 'LIBRARY'}
        </button>
        {libOpen && (
          <div style={{
            marginTop: 1, border: `1px solid ${INK}`, background: PAPER, width: 216,
            maxHeight: '60vh', overflowY: 'auto', touchAction: 'pan-y',
          }}>
            {doc.library.length === 0 && (
              <div style={{ ...microLabel(0.4), padding: 14, lineHeight: 1.6 }}>
                SELECT ELEMENTS →<br />SAVE — THEY APPEAR HERE.<br />DRAG THEM OUT ONTO ANY PAGE.
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: doc.library.length ? 10 : 0 }}>
              {doc.library.map(a => (
                <div key={a.id} style={{ position: 'relative' }}>
                  <div
                    onPointerDown={beginLibDrag(a)}
                    style={{
                      width: 88, height: 88, border: `1px solid rgba(26,26,26,0.25)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'grab', touchAction: 'none', background: PAPER,
                    }}
                  >
                    <AssetThumb asset={a} />
                  </div>
                  <button
                    onClick={() => deleteAsset(a.id)}
                    style={{
                      position: 'absolute', top: -8, right: -8, width: 22, height: 22,
                      border: `1px solid ${INK}`, background: PAPER, color: INK,
                      fontSize: 12, lineHeight: '19px', padding: 0, cursor: 'pointer',
                    }}
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* drag ghost */}
      {ghost && (
        <div style={{ position: 'fixed', left: ghost.x, top: ghost.y, transform: 'translate(-50%,-50%)', pointerEvents: 'none', opacity: 0.6 }}>
          {ghost.asset ? (
            <div style={{ width: 48, height: 48 }}><AssetThumb asset={ghost.asset} /></div>
          ) : ghost.shape === 'circle' ? (
            <svg width="40" height="40"><circle cx="20" cy="20" r="19" fill="none" stroke={INK} strokeWidth="1" /></svg>
          ) : ghost.shape === 'triangle' ? (
            <svg width="40" height="40"><polygon points="20,2 38,37 2,37" fill="none" stroke={INK} strokeWidth="1" /></svg>
          ) : (
            <svg width="40" height="40"><rect x="1" y="1" width="38" height="38" fill="none" stroke={INK} strokeWidth="1" /></svg>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================================================
   small components / styles
   ============================================================ */

const barBtnStyle = {
  font: '13px "Helvetica Neue", Inter, Arial, sans-serif',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: INK,
  background: 'transparent',
  border: 'none',
  padding: '13px 16px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}

const microLabel = (opacity = 0.5) => ({
  font: '12px "Helvetica Neue", Inter, Arial, sans-serif',
  letterSpacing: '0.18em',
  color: INK,
  opacity,
  textTransform: 'uppercase',
})

function BarBtn({ label, onClick, accent, wide = true }) {
  return (
    <button
      style={{ ...barBtnStyle, color: accent ? ACCENT : INK, padding: wide ? '9px 12px' : '9px 8px' }}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
    >{label}</button>
  )
}

function ToolBtn({ active, children, ...rest }) {
  return (
    <button style={{
      ...barBtnStyle,
      padding: '14px 18px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: active ? 'rgba(227,66,52,0.07)' : 'transparent',
      touchAction: 'none',
    }} {...rest}>{children}</button>
  )
}

function AssetThumb({ asset }) {
  const pad = 6
  const w = Math.max(asset.w, 10), h = Math.max(asset.h, 10)
  const vb = `${-w / 2 - pad} ${-h / 2 - pad} ${w + pad * 2} ${h + pad * 2}`
  const sw = Math.max(w, h) / 40
  return (
    <svg width="100%" height="100%" viewBox={vb} preserveAspectRatio="xMidYMid meet" style={{ pointerEvents: 'none' }}>
      {asset.items.map((it, i) => {
        const xf = it.rotation ? `rotate(${it.rotation} ${it.dx} ${it.dy})` : undefined
        const oc = it.strokeColor && it.strokeColor !== INK ? it.strokeColor : INK_DIM
        return it.type === 'ink' ? (
          <path key={i} transform={xf}
            d={it.points.map(([dx, dy], j) => `${j ? 'L' : 'M'}${it.dx + dx} ${it.dy + dy}`).join('') + (it.closed ? 'Z' : '')}
            fill={it.closed && it.filled ? (it.color || INK) : 'none'}
            stroke={it.color || INK} strokeWidth={sw * 2} strokeLinejoin="round" strokeLinecap="round" />
        ) : it.shape === 'circle' ? (
          <circle key={i} cx={it.dx} cy={it.dy} r={it.size / 2}
            fill={it.filled ? (it.color || INK) : 'none'} stroke={oc} strokeWidth={sw} />
        ) : it.shape === 'triangle' ? (
          <polygon key={i} transform={xf} points={triPoints(it.dx, it.dy, it.size)}
            fill={it.filled ? (it.color || INK) : 'none'} stroke={oc} strokeWidth={sw} strokeLinejoin="round" />
        ) : (
          <rect key={i} transform={xf} x={it.dx - it.size / 2} y={it.dy - it.size / 2} width={it.size} height={it.size}
            fill={it.filled ? (it.color || INK) : 'none'} stroke={oc} strokeWidth={sw} />
        )
      })}
    </svg>
  )
}
