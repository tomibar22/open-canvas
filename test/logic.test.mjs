/* Pure-logic tests — run with: node test/logic.test.mjs
   Fast verification without a browser. */
import assert from 'node:assert/strict'
import { quantizeElements, recognize, computeSnap } from '../src/logic.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok', name) }
  catch (e) { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1 }
}

const circle = (id, x, y, size = 40, extra = {}) =>
  ({ id, shape: 'circle', x, y, size, filled: false, groupId: null, ...extra })

/* ---------- quantize ---------- */

test('messy row: aligns y and equalizes near-even gaps', () => {
  const els = [circle('a', 300, 402), circle('b', 368, 391), circle('c', 452, 408)]
  const out = quantizeElements(els, null)
  assert.ok(out)
  const ys = new Set(out.map(e => Math.round(e.y)))
  assert.equal(ys.size, 1, 'one row y expected')
  const xs = out.map(e => e.x).sort((a, b) => a - b)
  assert.ok(Math.abs((xs[1] - xs[0]) - (xs[2] - xs[1])) < 0.01, 'equal gaps')
  assert.equal(xs[0], 300); assert.equal(xs[2], 452) // span preserved
})

test('intentionally uneven gaps (2 close + 1 far): no respacing', () => {
  const els = [circle('a', 300, 400), circle('b', 344, 400), circle('c', 600, 400)]
  const out = quantizeElements(els, null) // may be null (nothing to fix)
  const xs = (out || els).map(e => e.x).sort((a, b) => a - b)
  assert.deepEqual(xs, [300, 344, 600], 'x positions untouched')
})

test('vertical outlier is not dragged into the row', () => {
  const els = [circle('a', 300, 398), circle('b', 380, 403), circle('c', 460, 400), circle('d', 540, 470)]
  const out = quantizeElements(els, null)
  const d = out.find(e => e.id === 'd')
  assert.equal(Math.round(d.y), 470, 'outlier y unchanged')
  const rowYs = new Set(out.filter(e => e.id !== 'd').map(e => Math.round(e.y)))
  assert.equal(rowYs.size, 1, 'row still aligns')
})

test('distant constellations are independent', () => {
  const els = [circle('a', 100, 100), circle('b', 900, 900)]
  const out = quantizeElements(els, null)
  assert.equal(out, null, 'nothing merged, nothing moved')
})

test('two rows form a grid: columns align too', () => {
  const els = [
    circle('a', 300, 402), circle('b', 380, 398), circle('c', 460, 400),
    circle('d', 305, 512), circle('e', 377, 508), circle('f', 458, 511),
  ]
  const out = quantizeElements(els, null)
  const xs = [...new Set(out.map(e => Math.round(e.x)))].sort((a, b) => a - b)
  assert.equal(xs.length, 3, 'three columns')
  const ys = [...new Set(out.map(e => Math.round(e.y)))].sort((a, b) => a - b)
  assert.equal(ys.length, 2, 'two rows')
})

test('near-identical sizes equalize; distinct sizes do not', () => {
  const els = [circle('a', 100, 100, 40), circle('b', 200, 100, 44), circle('c', 300, 100, 80)]
  const out = quantizeElements(els, null)
  const a = out.find(e => e.id === 'a'), b2 = out.find(e => e.id === 'b'), c = out.find(e => e.id === 'c')
  assert.equal(a.size, b2.size, '40 & 44 equalize')
  assert.equal(c.size, 80, '80 stays distinct')
})

test('groups move as one unit', () => {
  const els = [
    circle('a', 300, 400, 40, { groupId: 'g1' }), circle('b', 380, 400, 40, { groupId: 'g1' }),
    circle('c', 500, 412), // slightly off the group's row
  ]
  const out = quantizeElements(els, null)
  const a = out.find(e => e.id === 'a'), b2 = out.find(e => e.id === 'b')
  assert.equal(b2.x - a.x, 80, 'internal group spacing intact')
  assert.equal(a.y, b2.y, 'group stays level')
})

test('selection scoping: only selected elements move', () => {
  const els = [circle('a', 300, 402), circle('b', 380, 396), circle('c', 700, 700)]
  const out = quantizeElements(els, new Set(['a', 'b']))
  assert.equal(out.find(e => e.id === 'c').y, 700, 'unselected untouched')
  assert.equal(out.find(e => e.id === 'a').y, out.find(e => e.id === 'b').y)
})

/* ---------- recognize ---------- */

test('wobbly horizontal stroke → straight line', () => {
  const pts = []
  for (let i = 0; i <= 20; i++) pts.push({ x: 200 + i * 10, y: 300 + Math.sin(i) * 5 })
  const rec = recognize(pts)
  assert.equal(rec.type, 'ink')
  assert.equal(rec.points.length, 2)
  const [p1, p2] = rec.points
  assert.equal(p1[1], p2[1], 'horizontal after angle snap')
})

test('rough circle → perfect circle', () => {
  const pts = []
  for (let i = 0; i <= 36; i++) {
    const a = (i / 36) * Math.PI * 2
    const r = 60 + Math.sin(i * 1.7) * 5
    pts.push({ x: 500 + Math.cos(a) * r, y: 500 + Math.sin(a) * r })
  }
  const rec = recognize(pts)
  assert.equal(rec.type, 'circle')
  assert.ok(Math.abs(rec.r - 60) < 4)
})

test('rough square → square element', () => {
  const pts = []
  const leg = (P, Q) => { for (let i = 0; i < 14; i++) pts.push({ x: P[0] + (Q[0] - P[0]) * i / 14 + Math.sin(i * 3) * 2, y: P[1] + (Q[1] - P[1]) * i / 14 + Math.cos(i * 2) * 2 }) }
  leg([900, 600], [1020, 605]); leg([1020, 605], [1018, 720]); leg([1018, 720], [902, 715]); leg([902, 715], [900, 600])
  pts.push({ x: 900, y: 600 })
  const rec = recognize(pts)
  assert.equal(rec.type, 'square')
})

/* ---------- snapping ---------- */

test('equal-spacing snap: third element completes the row', () => {
  const statics = [circle('a', 300, 400), circle('b', 380, 400)]
  const moving = [circle('m', 457, 396)]
  const { ax, ay } = computeSnap(moving, statics, 8)
  assert.equal(457 + ax, 460, 'x snaps to equal gap')
  assert.equal(396 + ay, 400, 'y snaps to row')
})

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''))
