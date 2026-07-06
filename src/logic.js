/* ============================================================
   Pure geometry / recognition / quantize logic.
   No React, no DOM — testable directly under node (see test/).
   ============================================================ */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

/* ---------- geometry ---------- */

export function elBBox(el) {
  if (el.type === 'ink') {
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
    for (const [dx, dy] of el.points) {
      const x = el.x + dx, y = el.y + dy
      l = Math.min(l, x); r = Math.max(r, x)
      t = Math.min(t, y); b = Math.max(b, y)
    }
    return { l, r, t, b, cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h2: b - t }
  }
  const h = el.size / 2
  return { l: el.x - h, r: el.x + h, t: el.y - h, b: el.y + h, cx: el.x, cy: el.y, w: el.size, h2: el.size }
}

export function bboxOf(els) {
  if (!els.length) return null
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
  for (const el of els) {
    const bb = elBBox(el)
    l = Math.min(l, bb.l); r = Math.max(r, bb.r)
    t = Math.min(t, bb.t); b = Math.max(b, bb.b)
  }
  return { l, r, t, b, cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t }
}

export const inkPathD = (el) => el.points
  .map(([dx, dy], i) => `${i ? 'L' : 'M'}${(el.x + dx).toFixed(2)} ${(el.y + dy).toFixed(2)}`)
  .join('') + (el.closed ? 'Z' : '')

/* ---------- freehand shape recognition ---------- */

export const pathLength = (pts) => {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
  return L
}

export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice()
  const a = pts[0], b = pts[pts.length - 1]
  const dx = b.x - a.x, dy = b.y - a.y
  const L = Math.hypot(dx, dy) || 1e-9
  let maxD = 0, idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * (pts[i].x - a.x) - dx * (pts[i].y - a.y)) / L
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps)
    return left.slice(0, -1).concat(rdp(pts.slice(idx), eps))
  }
  return [a, b]
}

export const inkFromAbs = (abs, closed) => {
  let cx = 0, cy = 0
  for (const p of abs) { cx += p.x; cy += p.y }
  cx /= abs.length; cy /= abs.length
  return { type: 'ink', x: cx, y: cy, points: abs.map(p => [p.x - cx, p.y - cy]), closed }
}

/*
 Recognize a raw stroke (world coords). Returns:
   {type:'circle', cx, cy, r}      → becomes a real circle element
   {type:'square', cx, cy, size}   → becomes a real square element
   {type:'ink', x, y, points, closed} → perfected line / triangle / rect / polygon
   null → keep the raw stroke
*/
export function recognize(pts) {
  if (pts.length < 4) return null
  const len = pathLength(pts)
  if (len < 12) return null
  const first = pts[0], last = pts[pts.length - 1]
  const closed = dist(first, last) < Math.max(len * 0.2, 12)

  if (!closed) {
    // straight line?
    const dx = last.x - first.x, dy = last.y - first.y
    const L = Math.hypot(dx, dy) || 1e-9
    let maxDev = 0
    for (const p of pts) {
      maxDev = Math.max(maxDev, Math.abs(dy * (p.x - first.x) - dx * (p.y - first.y)) / L)
    }
    if (maxDev < Math.max(L * 0.08, 5)) {
      let ang = Math.atan2(dy, dx)
      const deg = ang * 180 / Math.PI
      for (const s of [0, 45, 90, 135, 180, -45, -90, -135, -180]) {
        if (Math.abs(deg - s) < 8) { ang = s * Math.PI / 180; break }
      }
      const mx = (first.x + last.x) / 2, my = (first.y + last.y) / 2
      const h = L / 2, ca = Math.cos(ang), sa = Math.sin(ang)
      return inkFromAbs([{ x: mx - ca * h, y: my - sa * h }, { x: mx + ca * h, y: my + sa * h }], false)
    }
    return null // open scribble stays freehand
  }

  // closed: circle vs polygon
  let cx = 0, cy = 0
  for (const p of pts) { cx += p.x; cy += p.y }
  cx /= pts.length; cy /= pts.length
  const radii = pts.map(p => Math.hypot(p.x - cx, p.y - cy))
  const rMean = radii.reduce((s, r) => s + r, 0) / radii.length
  const dev = Math.sqrt(radii.reduce((s, r) => s + (r - rMean) ** 2, 0) / radii.length) / (rMean || 1e-9)

  let poly = rdp(pts, Math.max(len * 0.025, 4))
  if (poly.length > 2 && dist(poly[0], poly[poly.length - 1]) < len * 0.1) poly = poly.slice(0, -1)
  // keep only real corners: drop vertices where the direction barely turns
  if (poly.length > 3) {
    const corners = poly.filter((p, i) => {
      const prev = poly[(i - 1 + poly.length) % poly.length]
      const next = poly[(i + 1) % poly.length]
      const a1 = Math.atan2(p.y - prev.y, p.x - prev.x)
      const a2 = Math.atan2(next.y - p.y, next.x - p.x)
      let turn = Math.abs(a1 - a2)
      if (turn > Math.PI) turn = 2 * Math.PI - turn
      return turn > 20 * Math.PI / 180
    })
    if (corners.length >= 3) poly = corners
  }
  const n = poly.length

  if (dev < 0.10 || (n >= 6 && dev < 0.22)) {
    return { type: 'circle', cx, cy, r: rMean }
  }

  if (n === 4) {
    // near-axis-aligned quad → rectangle (square element when proportions allow)
    const axisAligned = poly.every((p, i) => {
      const q = poly[(i + 1) % 4]
      const a = Math.abs(Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI)
      return Math.min(a, Math.abs(a - 90), Math.abs(a - 180)) < 15
    })
    if (axisAligned) {
      let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
      for (const p of poly) { l = Math.min(l, p.x); r = Math.max(r, p.x); t = Math.min(t, p.y); b = Math.max(b, p.y) }
      const w = r - l, h = b - t
      if (w / h > 0.8 && w / h < 1.25) {
        return { type: 'square', cx: (l + r) / 2, cy: (t + b) / 2, size: (w + h) / 2 }
      }
      return inkFromAbs([{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }], true)
    }
    return inkFromAbs(poly, true)
  }

  if (n >= 3 && n <= 8) return inkFromAbs(poly, true)
  return null
}

/* ---------- snapping engine ---------- */
/*
 Given the set of moving elements (at proposed raw position) and the
 static elements on the page, returns {ax, ay, guides} — adjustments
 to apply, plus guide primitives for rendering.
*/
export function computeSnap(movingEls, statics, th) {
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

  const halfMin = s => { const e = elBBox(s); return Math.min(e.r - e.l, e.b - e.t) / 2 }
  const spX = spacing(bb.cx, cyNow, s => elBBox(s).cx, s => elBBox(s).cy, halfMin)
  const spY = spacing(bb.cy, cxNow, s => elBBox(s).cy, s => elBBox(s).cx, halfMin)

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

/* ---------- quantize ---------- */
/*
 Conservative auto-structure, like Ableton quantize: small corrections
 toward structure that is already almost there, never big rearrangements.
 One pass per axis: cluster -> align to median (outliers stay put) ->
 equal-space lines whose gaps are already roughly even (max/min <= 2.4,
 shifts <= 60% of the median gap). Sizes within 18% equalize.
 Groups move as single units. Returns new elements or null.
*/
export function quantizeElements(elements, selIds) {
  const scoped = selIds && selIds.size ? elements.filter(e => selIds.has(e.id)) : elements
  if (scoped.length < 2) return null

  const byUnit = new Map()
  for (const el of scoped) {
    const k = el.groupId ? "g:" + el.groupId : el.id
    byUnit.set(k, [...(byUnit.get(k) || []), el])
  }
  const units = [...byUnit.values()].map(els => {
    const bb = bboxOf(els)
    return { els, cx: bb.cx, cy: bb.cy, w: Math.max(bb.w, 1), h: Math.max(bb.h, 1) }
  })
  const median = a2 => { const t = [...a2].sort((x, y) => x - y), m = t.length >> 1; return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2 }

  const axis = (main, perp, dim) => {
    const sorted = [...units].sort((a2, b) => a2[perp] - b[perp])
    const clusters = [[sorted[0]]]
    for (let i = 1; i < sorted.length; i++) {
      const cl = clusters[clusters.length - 1]
      const mean = cl.reduce((s2, u) => s2 + u[perp], 0) / cl.length
      const tol = clamp(0.45 * Math.min(sorted[i][dim], cl[cl.length - 1][dim]), 10, 36)
      if (sorted[i][perp] - mean <= tol) cl.push(sorted[i])
      else clusters.push([sorted[i]])
    }
    for (const cl of clusters) {
      if (cl.length < 2) continue
      const t0 = median(cl.map(u => u[perp]))
      const movers = cl.filter(u => Math.abs(u[perp] - t0) <= Math.max(0.6 * u[dim], 8))
      if (movers.length < 2) continue
      const t = median(movers.map(u => u[perp]))
      movers.forEach(u => { u[perp] = t })
      // equal spacing along the aligned line
      const line = movers.sort((a2, b) => a2[main] - b[main])
      if (line.length < 3) continue
      const gaps = line.slice(1).map((u, i) => u[main] - line[i][main])
      if (Math.min(...gaps) <= 0 || Math.max(...gaps) / Math.min(...gaps) > 2.4) continue
      const gMed = median(gaps)
      const a1 = line[0][main], b1 = line[line.length - 1][main]
      const targets = line.map((u, i) => a1 + (b1 - a1) * i / (line.length - 1))
      if (line.some((u, i) => Math.abs(targets[i] - u[main]) > 0.6 * gMed)) continue
      line.forEach((u, i) => { u[main] = targets[i] })
    }
  }
  axis("cx", "cy", "h") // rows
  axis("cy", "cx", "w") // columns

  // equalize near-identical sizes (free shape elements only)
  const newSizes = new Map()
  const shapes = scoped.filter(e => e.size && !e.groupId).sort((a2, b) => a2.size - b.size)
  let run = []
  const flush = () => {
    if (run.length >= 2) {
      const m = run.reduce((s2, e) => s2 + e.size, 0) / run.length
      run.forEach(e => { if (Math.abs(m - e.size) > 0.01) newSizes.set(e.id, m) })
    }
    run = []
  }
  for (const e of shapes) {
    if (run.length && e.size / run[run.length - 1].size > 1.18) flush()
    run.push(e)
  }
  flush()

  const delta = new Map()
  for (const u of units) {
    const bb = bboxOf(u.els)
    const dx = u.cx - bb.cx, dy = u.cy - bb.cy
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) u.els.forEach(el => delta.set(el.id, [dx, dy]))
  }
  if (!delta.size && !newSizes.size) return null

  return elements.map(e => {
    const dl = delta.get(e.id), ns = newSizes.get(e.id)
    if (!dl && ns == null) return e
    const next = { ...e, x: e.x + (dl ? dl[0] : 0), y: e.y + (dl ? dl[1] : 0) }
    if (ns != null) next.size = ns
    return next
  })
}
