import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'

/* ============================================================
   OPEN CANVAS — Stage 1
   Infinite, calm, open-world canvas for structural thinking.
   Tokens (deterministic):
     paper   #FAFAF7
     ink     #1A1A1A
     inkDim  rgba(26,26,26,0.3)   (empty-state hairline)
     accent  #E34234              (selection / snap guides)
   ============================================================ */

const PAPER = '#FAFAF7'
const INK = '#1A1A1A'
const INK_DIM = 'rgba(26,26,26,0.30)'
const ACCENT = '#E34234'
const ACCENT_60 = 'rgba(227,66,52,0.60)'

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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

/* ---------- geometry ---------- */

function elBBox(el) {
  const h = el.size / 2
  return { l: el.x - h, r: el.x + h, t: el.y - h, b: el.y + h, cx: el.x, cy: el.y, w: el.size, h2: el.size }
}

function bboxOf(els) {
  if (!els.length) return null
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
  for (const el of els) {
    const bb = elBBox(el)
    l = Math.min(l, bb.l); r = Math.max(r, bb.r)
    t = Math.min(t, bb.t); b = Math.max(b, bb.b)
  }
  return { l, r, t, b, cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t }
}

/* ---------- snapping engine ---------- */
/*
 Given the set of moving elements (at proposed raw position) and the
 static elements on the page, returns {ax, ay, guides} — adjustments
 to apply, plus guide primitives for rendering:
   guides.v: [{x, y1, y2}]      alignment verticals
   guides.h: [{y, x1, x2}]      alignment horizontals
   guides.gapX: [{y, xs}]       equal-gap markers along a row
   guides.gapY: [{x, ys}]       equal-gap markers along a column
*/
function computeSnap(movingEls, statics, th) {
  const bb = bboxOf(movingEls)
  if (!bb) return { ax: 0, ay: 0, guides: null }

  const alignAxis = (movVals, getStatVals) => {
    let best = null
    for (const s of statics) {
      for (const sv of getStatVals(s)) {
        for (const mv of movVals) {
          const adj = sv - mv
          if (Math.abs(adj) <= th && (!best || Math.abs(adj) < Math.abs(best.adj))) {
            best = { adj, v: sv, s }
          }
        }
      }
    }
    return best
  }

  const sx = s => { const e = elBBox(s); return [e.l, e.cx, e.r] }
  const sy = s => { const e = elBBox(s); return [e.t, e.cy, e.b] }

  const bestAX = alignAxis([bb.l, bb.cx, bb.r], sx)
  const bestAY = alignAxis([bb.t, bb.cy, bb.b], sy)

  // equal-spacing candidates (uses the alignment-adjusted perpendicular)
  const cyNow = bb.cy + (bestAY ? bestAY.adj : 0)
  const cxNow = bb.cx + (bestAX ? bestAX.adj : 0)

  const spacing = (centerNow, perpNow, mainOf, perpOf, perpTolOf) => {
    const row = statics.filter(s =>
      Math.abs(perpOf(s) - perpNow) <= Math.max(perpTolOf(s), Math.min(bb.w, bb.h) / 2) + 1)
    row.sort((a, b) => mainOf(a) - mainOf(b))
    let best = null
    for (let i = 0; i < row.length; i++) {
      for (let j = i + 1; j < row.length; j++) {
        const a = mainOf(row[i]), b = mainOf(row[j])
        const d = b - a
        if (d < 4) continue
        for (const cand of [a - d, b + d, (a + b) / 2]) {
          const adj = cand - centerNow
          if (Math.abs(adj) <= th && (!best || Math.abs(adj) < Math.abs(best.adj))) {
            best = { adj, cand, pair: [a, b] }
          }
        }
      }
    }
    return best
  }

  const spX = spacing(bb.cx, cyNow, s => s.x, s => s.y, s => s.size / 2)
  const spY = spacing(bb.cy, cxNow, s => s.y, s => s.x, s => s.size / 2)

  // choose per axis: spacing wins if at least as close (it is the rarer, more precious snap)
  let ax = 0, useSpX = false
  if (spX && (!bestAX || Math.abs(spX.adj) <= Math.abs(bestAX.adj) + 0.5)) { ax = spX.adj; useSpX = true }
  else if (bestAX) ax = bestAX.adj

  let ay = 0, useSpY = false
  if (spY && (!bestAY || Math.abs(spY.adj) <= Math.abs(bestAY.adj) + 0.5)) { ay = spY.adj; useSpY = true }
  else if (bestAY) ay = bestAY.adj

  /* ---- guides ---- */
  const guides = { v: [], h: [], gapX: [], gapY: [] }
  const fl = bb.l + ax, fr = bb.r + ax, ft = bb.t + ay, fbm = bb.b + ay
  const fcx = bb.cx + ax, fcy = bb.cy + ay

  if (!useSpX && bestAX) {
    const v = bestAX.v
    let y1 = ft, y2 = fbm
    for (const s of statics) {
      const e = elBBox(s)
      if ([e.l, e.cx, e.r].some(sv => Math.abs(sv - v) < 0.5)) { y1 = Math.min(y1, e.t); y2 = Math.max(y2, e.b) }
    }
    guides.v.push({ x: v, y1: y1 - 14, y2: y2 + 14 })
  }
  if (!useSpY && bestAY) {
    const vv = bestAY.v
    let x1 = fl, x2 = fr
    for (const s of statics) {
      const e = elBBox(s)
      if ([e.t, e.cy, e.b].some(sv => Math.abs(sv - vv) < 0.5)) { x1 = Math.min(x1, e.l); x2 = Math.max(x2, e.r) }
    }
    guides.h.push({ y: vv, x1: x1 - 14, x2: x2 + 14 })
  }
  if (useSpX && spX) {
    const xs = [...spX.pair, fcx].sort((a, b) => a - b)
    guides.gapX.push({ y: fcy, xs })
  }
  if (useSpY && spY) {
    const ys = [...spY.pair, fcy].sort((a, b) => a - b)
    guides.gapY.push({ x: fcx, ys })
  }

  return { ax, ay, guides: (guides.v.length || guides.h.length || guides.gapX.length || guides.gapY.length) ? guides : null }
}

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
  const [tool, setTool] = useState(null) // 'circle' | 'square' | null
  const toolRef = useRef(tool); toolRef.current = tool
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
    let el = { id: uid(), shape, x: wx, y: wy, size: DEFAULT_SIZE, filled: false, groupId: null }
    if (withSnap) {
      const th = SNAP_PX / viewRef.current.scale
      const { ax, ay } = computeSnap([el], p.elements, th)
      el = { ...el, x: el.x + ax, y: el.y + ay }
    }
    commit(d => updatePage(d, p.id, pg => ({ ...pg, elements: [...pg.elements, el] })))
  }, [commit])

  const toggleFill = useCallback((id) => {
    commit(d => updatePage(d, pageIdRef.current, pg => ({
      ...pg,
      elements: pg.elements.map(e => (e.id === id ? { ...e, filled: !e.filled } : e)),
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
      const avg = members.reduce((s, m) => s + m.size, 0) / members.length
      const dy = bb.h + avg * 1.2
      const g2 = uid('g')
      const copies = members.map(m => ({ ...m, id: uid(), y: m.y + dy, groupId: g2 }))
      newIds = copies.map(c => c.id)
      return { ...pg, elements: [...pg.elements, ...copies] }
    }))
    if (newIds) setSel(new Set(newIds))
  }, [commit])

  const saveAsset = useCallback(() => {
    const ids = selRef.current
    if (!ids.size) return
    const p = pageRef.current
    const src = p.elements.filter(e => ids.has(e.id))
    const bb = bboxOf(src)
    const grouped = src.length > 1 && src.every(e => e.groupId && e.groupId === src[0].groupId)
    const items = src.map(e => ({ shape: e.shape, dx: e.x - bb.cx, dy: e.y - bb.cy, size: e.size, filled: e.filled }))
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
    let els = asset.items.map(it => ({
      id: uid(), shape: it.shape, x: wx + it.dx, y: wy + it.dy, size: it.size, filled: it.filled, groupId: g,
    }))
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

  const startPinchIfTwo = () => {
    if (pointers.current.size !== 2) return false
    clearLongTimer()
    const [p1, p2] = [...pointers.current.values()]
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const v = viewRef.current
    gesture.current = {
      type: 'pinch',
      d0: dist(p1, p2),
      view0: v,
      world0: { x: (c.x - v.tx) / v.scale, y: (c.y - v.ty) / v.scale },
    }
    setGuides(null)
    return true
  }

  const beginElementGesture = (id, e) => {
    e.stopPropagation()
    const pt = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, pt)
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
    pointers.current.set(e.pointerId, pt)
    if (startPinchIfTwo()) return
    gesture.current = { type: 'canvas', start: pt, view0: viewRef.current, moved: false, forcePan }
  }

  const beginHandleGesture = (el, e) => {
    e.stopPropagation()
    const pt = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, pt)
    gesture.current = { type: 'resize', id: el.id, docBefore: docRef.current }
  }

  const onPointerMove = useCallback((e) => {
    if (!pointers.current.has(e.pointerId)) return
    const pt = { x: e.clientX, y: e.clientY }
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
      if (!g.moved && Math.hypot(dx, dy) > TAP_PX) g.moved = true
      if (g.moved) setView({ ...g.view0, tx: g.view0.tx + dx, ty: g.view0.ty + dy })
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

    if (g.type === 'resize') {
      if (docRef.current !== g.docBefore) pushHistory(g.docBefore)
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
        if (toolRef.current) {
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
    }
    const up = (e) => { if (e.code === 'Space') spaceDown.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [undo, redo, duplicateSelection, groupSelection, deleteSelection])

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
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gesture.current = { type: 'toolDrag', shape, start: { x: e.clientX, y: e.clientY }, moved: false }
  }
  const beginLibDrag = (asset) => (e) => {
    e.stopPropagation()
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
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
  const singleFree = selEls.length === 1 && !selEls[0].groupId ? selEls[0] : null
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
            const hitR = Math.max(el.size / 2, 20 / view.scale)
            return (
              <g key={el.id} onPointerDown={(e) => beginElementGesture(el.id, e)} style={{ cursor: 'pointer' }}>
                {el.shape === 'circle' ? (
                  <>
                    <circle cx={el.x} cy={el.y} r={hitR} fill="transparent" />
                    <circle
                      cx={el.x} cy={el.y} r={el.size / 2}
                      fill={el.filled ? INK : 'transparent'}
                      stroke={el.filled ? 'none' : INK_DIM}
                      strokeWidth={hair}
                    />
                    {selected && <circle cx={el.x} cy={el.y} r={el.size / 2 + 4 / view.scale} fill="none" stroke={ACCENT} strokeWidth={hair} />}
                  </>
                ) : (
                  <>
                    <rect x={el.x - hitR} y={el.y - hitR} width={hitR * 2} height={hitR * 2} fill="transparent" />
                    <rect
                      x={el.x - el.size / 2} y={el.y - el.size / 2} width={el.size} height={el.size}
                      fill={el.filled ? INK : 'transparent'}
                      stroke={el.filled ? 'none' : INK_DIM}
                      strokeWidth={hair}
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

          {/* resize handles: single free element */}
          {singleFree && (() => {
            const el = singleFree
            const h = el.size / 2 + 4 / view.scale
            const hs = 5 / view.scale
            return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([mx, my], i) => (
              <rect key={i}
                x={el.x + mx * h - hs} y={el.y + my * h - hs} width={hs * 2} height={hs * 2}
                fill={PAPER} stroke={ACCENT} strokeWidth={hair}
                style={{ cursor: 'nwse-resize' }}
                onPointerDown={(e) => beginHandleGesture(el, e)}
              />
            ))
          })()}
        </g>
      </svg>

      {/* empty-state hint */}
      {page.elements.length === 0 && !tool && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <span style={microLabel(0.35)}>TAP A SHAPE BELOW · THEN TAP THE CANVAS</span>
        </div>
      )}

      {/* ---- action bar ---- */}
      {barPos && sel.size > 0 && (
        <div style={{
          position: 'absolute',
          left: clamp(barPos.x, 130, window.innerWidth - 130),
          top: Math.max(barPos.y - 40, 12),
          transform: 'translate(-50%, 0)',
          display: 'flex', gap: 1, alignItems: 'stretch',
          border: `1px solid ${INK}`, background: PAPER,
        }}>
          {singleGroupId ? (
            <>
              <BarBtn label="REDIST" onClick={() => redistributeGroup(singleGroupId)} />
              <BarBtn label="−" wide={false} onClick={() => setGroupCount(singleGroupId, selEls.length - 1)} />
              <div style={{ ...barBtnStyle, cursor: 'default', minWidth: 26, textAlign: 'center' }}>{selEls.length}</div>
              <BarBtn label="+" wide={false} onClick={() => setGroupCount(singleGroupId, selEls.length + 1)} />
              <BarBtn label="DUP ↓" onClick={() => duplicateGroupBelow(singleGroupId)} />
              <BarBtn label="UNGROUP" onClick={ungroupSelection} />
            </>
          ) : (
            <>
              <BarBtn label="DUPLICATE" onClick={duplicateSelection} />
              {sel.size > 1 && !anyGrouped && <BarBtn label="GROUP" onClick={groupSelection} />}
              {anyGrouped && <BarBtn label="UNGROUP" onClick={ungroupSelection} />}
            </>
          )}
          <BarBtn label="SAVE" onClick={saveAsset} />
          <BarBtn label="DELETE" accent onClick={deleteSelection} />
        </div>
      )}

      {/* ---- toolbar (bottom center) ---- */}
      <div style={{
        position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 1, border: `1px solid ${INK}`, background: PAPER,
        touchAction: 'none',
      }}>
        <ToolBtn active={tool === 'circle'} onPointerDown={beginToolDrag('circle')}>
          <svg width="18" height="18" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r="7" fill="none" stroke={tool === 'circle' ? ACCENT : INK} strokeWidth="1" />
          </svg>
        </ToolBtn>
        <ToolBtn active={tool === 'square'} onPointerDown={beginToolDrag('square')}>
          <svg width="18" height="18" viewBox="0 0 18 18">
            <rect x="2.5" y="2.5" width="13" height="13" fill="none" stroke={tool === 'square' ? ACCENT : INK} strokeWidth="1" />
          </svg>
        </ToolBtn>
        <div style={{ width: 1, background: INK }} />
        <ToolBtn onPointerDown={(e) => { e.stopPropagation() }} onClick={undo}>
          <span style={{ fontSize: 14, color: INK }}>↺</span>
        </ToolBtn>
        <ToolBtn onPointerDown={(e) => { e.stopPropagation() }} onClick={redo}>
          <span style={{ fontSize: 14, color: INK }}>↻</span>
        </ToolBtn>
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
          <div style={{ marginTop: 1, border: `1px solid ${INK}`, background: PAPER, minWidth: 180 }}>
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
                      font: '11px "Helvetica Neue", Inter, Arial, sans-serif', letterSpacing: '0.08em',
                      padding: '8px 10px', color: INK,
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
            marginTop: 1, border: `1px solid ${INK}`, background: PAPER, width: 168,
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
                      width: 64, height: 64, border: `1px solid rgba(26,26,26,0.25)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'grab', touchAction: 'none', background: PAPER,
                    }}
                  >
                    <AssetThumb asset={a} />
                  </div>
                  <button
                    onClick={() => deleteAsset(a.id)}
                    style={{
                      position: 'absolute', top: -6, right: -6, width: 16, height: 16,
                      border: `1px solid ${INK}`, background: PAPER, color: INK,
                      fontSize: 9, lineHeight: '13px', padding: 0, cursor: 'pointer',
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
  font: '10px "Helvetica Neue", Inter, Arial, sans-serif',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: INK,
  background: 'transparent',
  border: 'none',
  padding: '9px 12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
  WebkitUserSelect: 'none',
}

const microLabel = (opacity = 0.5) => ({
  font: '10px "Helvetica Neue", Inter, Arial, sans-serif',
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
      padding: '10px 14px',
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
      {asset.items.map((it, i) => it.shape === 'circle' ? (
        <circle key={i} cx={it.dx} cy={it.dy} r={it.size / 2}
          fill={it.filled ? INK : 'none'} stroke={it.filled ? 'none' : INK_DIM} strokeWidth={sw} />
      ) : (
        <rect key={i} x={it.dx - it.size / 2} y={it.dy - it.size / 2} width={it.size} height={it.size}
          fill={it.filled ? INK : 'none'} stroke={it.filled ? 'none' : INK_DIM} strokeWidth={sw} />
      ))}
    </svg>
  )
}
