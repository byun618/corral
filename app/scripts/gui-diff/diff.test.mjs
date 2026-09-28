// C4 — diff 로직 단위 테스트. `node --test app/scripts/gui-diff/diff.test.mjs`
//
// 왜 vitest 가 아닌가: 이 파일은 I/O 도 소켓도 안 쓴다. node 내장 러너면 설정이 0 이고
// app 의 vitest include 규칙과 다투지 않는다.

import test from 'node:test'
import assert from 'node:assert/strict'
import { diffBox, diffStyle, diffSnapshots, selfDiff, compareMeta } from './lib/diff.mjs'

const unit = (id, extra = {}) => ({ id, note: `${id} 설명`, ...extra })
const el = (over = {}) => ({
  present: true,
  count: 1,
  countAll: 1,
  box: { x: 0, y: 0, w: 100, h: 20 },
  style: { color: 'rgba(0, 0, 0, 1)', fontSize: '13px' },
  ...over
})
const snap = (app, elements, meta = {}) => ({
  app,
  meta: { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2, hasFocus: false, prefersDark: true, devOverlays: 0, ...meta },
  elements
})

test('diffBox: 허용치 이내는 차이가 아니다', () => {
  assert.deepEqual(diffBox({ x: 0, y: 0, w: 100, h: 20 }, { x: 0.4, y: 0, w: 100, h: 20 }, 0.5), [])
})

test('diffBox: 허용치를 넘으면 델타와 함께 보고한다', () => {
  const out = diffBox({ x: 0, y: 0, w: 100, h: 20 }, { x: 0, y: 0, w: 108, h: 20 }, 0.5)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { prop: 'w', left: 100, right: 108, delta: 8 })
})

test('diffBox: 허용치가 0 이면 서브픽셀도 잡힌다', () => {
  const out = diffBox({ x: 0, y: 0, w: 100, h: 20 }, { x: 0, y: 0, w: 100.01, h: 20 }, 0)
  assert.equal(out.length, 1)
  assert.equal(out[0].prop, 'w')
})

test('diffStyle: 한쪽에만 있는 속성도 차이다', () => {
  const out = diffStyle({ color: 'a' }, { color: 'a', gap: '4px' })
  assert.deepEqual(out, [{ prop: 'gap', left: null, right: '4px' }])
})

test('diffStyle: 값이 같으면 빈 배열', () => {
  assert.deepEqual(diffStyle({ color: 'a', gap: '4px' }, { gap: '4px', color: 'a' }), [])
})

test('존재/부재 차이는 missing 한 건으로 끝난다 — 박스·스타일을 덧붙이지 않는다 (K7)', () => {
  const left = snap('orca', { pill: el({ box: { x: 0, y: 0, w: 60, h: 18 } }) })
  const right = snap('corral', { pill: el({ present: false, count: 0, box: undefined, style: undefined }) })
  const result = diffSnapshots(left, right, { units: [unit('pill')], tolerance: 0.5 })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'missing')
  assert.deepEqual(result.summary, { total: 1, unpaired: 0, missing: 1, count: 0, box: 0, style: 0 })
})

test('둘 다 없으면 차이가 아니다', () => {
  const left = snap('orca', { pill: el({ present: false, count: 0 }) })
  const right = snap('corral', { pill: el({ present: false, count: 0 }) })
  assert.equal(diffSnapshots(left, right, { units: [unit('pill')] }).findings.length, 0)
})

test('영역 정의에 있는데 양쪽 스냅샷에 없으면 unmeasured 로 드러낸다', () => {
  const result = diffSnapshots(snap('orca', {}), snap('corral', {}), { units: [unit('ghost')] })
  assert.equal(result.findings.length, 1)
  assert.deepEqual(result.findings[0].detail, { left: 'unmeasured', right: 'unmeasured' })
})

test('개수 차이·박스 차이·스타일 차이가 따로 나온다', () => {
  const left = snap('orca', { row: el({ count: 2, box: { x: 0, y: 0, w: 100, h: 20 }, style: { color: 'rgba(1, 1, 1, 1)' } }) })
  const right = snap('corral', { row: el({ count: 3, box: { x: 0, y: 0, w: 140, h: 20 }, style: { color: 'rgba(2, 2, 2, 1)' } }) })
  const result = diffSnapshots(left, right, { units: [unit('row')], tolerance: 0.5 })
  assert.deepEqual(result.findings.map((f) => f.kind), ['count', 'box', 'style'])
})

test('보고 순서는 영역 정의의 단위 순서를 따른다', () => {
  const elements = { b: el({ style: { color: 'x' } }), a: el({ style: { color: 'x' } }) }
  const other = { b: el({ style: { color: 'y' } }), a: el({ style: { color: 'y' } }) }
  const result = diffSnapshots(snap('orca', elements), snap('corral', other), { units: [unit('a'), unit('b')] })
  assert.deepEqual(result.findings.map((f) => f.id), ['a', 'b'])
})

test('note 는 결과에 실려 나간다 — 보고서가 id 만 보고 설명을 잃지 않게', () => {
  const result = diffSnapshots(
    snap('orca', { a: el() }),
    snap('corral', { a: el({ present: false, count: 0 }) }),
    { units: [unit('a')] }
  )
  assert.equal(result.findings[0].note, 'a 설명')
})

test('짝짓기 불가는 "없음" 이 아니라 unpaired 로 나온다 — 거짓 차이를 만들지 않는다', () => {
  const left = snap('orca', { label: el({ present: false, count: 0 }) })
  const right = snap('corral', { label: el() })
  const units = [{ id: 'label', note: '탭 라벨', unpaired: 'Orca 라벨에 안정 식별자가 없다' }]
  const result = diffSnapshots(left, right, { units })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'unpaired')
  assert.equal(result.findings[0].detail.reason, 'Orca 라벨에 안정 식별자가 없다')
  assert.equal(result.summary.missing, 0)
})

test('unpaired 는 양쪽이 멀쩡히 있어도 우선한다 — 잰 값으로 착각하지 않게', () => {
  const result = diffSnapshots(
    snap('orca', { a: el({ style: { color: 'x' } }) }),
    snap('corral', { a: el({ style: { color: 'y' } }) }),
    { units: [{ id: 'a', unpaired: '짝을 못 지었다' }] }
  )
  assert.deepEqual(result.findings.map((f) => f.kind), ['unpaired'])
})

test('selfDiff 는 unpaired 를 세지 않는다 — 짝짓기 불가는 잡음이 아니다', () => {
  const one = snap('orca', { a: el() })
  const units = [{ id: 'a', unpaired: '짝을 못 지었다' }]
  assert.equal(selfDiff(one, structuredClone(one), { units }).summary.total, 0)
  assert.equal(diffSnapshots(one, structuredClone(one), { units }).summary.unpaired, 1)
})

test('selfDiff: 같은 스냅샷끼리는 차이 0 (잡음 바닥의 정의)', () => {
  const one = snap('orca', { a: el(), b: el() })
  assert.equal(selfDiff(one, structuredClone(one), { units: [unit('a'), unit('b')] }).summary.total, 0)
})

test('selfDiff 는 본 diff 와 같은 경로를 탄다 — 허용치도 똑같이 먹는다', () => {
  const one = snap('orca', { a: el() })
  const two = snap('orca', { a: el({ box: { x: 0, y: 0, w: 100.3, h: 20 } }) })
  assert.equal(selfDiff(one, two, { units: [unit('a')], tolerance: 0.5 }).summary.total, 0)
  assert.equal(selfDiff(one, two, { units: [unit('a')], tolerance: 0 }).summary.total, 1)
})

test('compareMeta: 창 크기·테마·포커스가 어긋나면 경고한다', () => {
  const warnings = compareMeta(snap('orca', {}), snap('corral', {}, { innerWidth: 1280, prefersDark: false }))
  assert.deepEqual(warnings.map((w) => w.key), ['innerWidth', 'prefersDark'])
})

test('compareMeta: 개발 오버레이가 있으면 캡처 오염을 경고한다', () => {
  const warnings = compareMeta(snap('orca', {}, { devOverlays: 1 }), snap('corral', {}))
  assert.ok(warnings.some((w) => w.key === 'devOverlays'))
})

test('compareMeta: 완전히 대칭이면 경고 없음', () => {
  assert.deepEqual(compareMeta(snap('orca', {}), snap('corral', {})), [])
})
