// C4 — diff 로직 단위 테스트. `node --test app/scripts/gui-diff/diff.test.mjs`
//
// 왜 vitest 가 아닌가: 이 파일은 I/O 도 소켓도 안 쓴다. node 내장 러너면 설정이 0 이고
// app 의 vitest include 규칙과 다투지 않는다.

import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CHILDREN, diffBox, diffBoxWithBelow, diffStyle, diffSnapshots, diffFonts, diffItemFonts, fontState, selfDiff, compareMeta, fontCaptureFailures } from './lib/diff.mjs'
import { selectOwnedByPath, commandPathTokens, isPathInside, normalizePath, planSignals, classifyPathSurvivors, commandMentionsPath, parseProcessList, commandIncludesPath, pathDiagnosis, cleanVerdict } from './lib/own.mjs'
import { decodePng, encodePng, compareRoi, evaluateRoiControls } from './lib/png.mjs'
import { evaluateControls, POSITIVE_CONTROLS } from './lib/controls.mjs'
import { compareRuns, validateRun, expectedKeys } from './lib/compare.mjs'

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

test('선언상 부재는 missing 한 건으로 끝난다 — 박스·스타일을 덧붙이지 않는다 (K7)', () => {
  const left = snap('orca', { pill: el({ box: { x: 0, y: 0, w: 60, h: 18 } }) })
  const right = snap('corral', { pill: el({ present: false, count: 0, box: undefined, style: undefined, declaredAbsent: true }) })
  const result = diffSnapshots(left, right, { units: [unit('pill')], tolerance: 0.5 })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'missing')
  assert.equal(result.findings[0].detail.absentSide, 'right')
  assert.equal(result.summary.total, 1)
  assert.equal(result.summary.missing, 1)
})

test('선택자가 0개를 찾은 것은 missing 이 아니라 selector-miss 다 (F11)', () => {
  // 선언이 아니라 **실패**다. 447~450 이 DOM 을 고친 뒤 예정된 사건이고, 차이로 내보내면
  // 「corral 에 없음」이라는 거짓 차이가 나간다.
  const left = snap('orca', { row: el() })
  const right = snap('corral', { row: el({ present: false, count: 0, box: undefined, style: undefined, declaredAbsent: false }) })
  const result = diffSnapshots(left, right, { units: [unit('row')] })
  assert.equal(result.findings[0].kind, 'selector-miss')
  assert.equal(result.summary.missing, 0)
  assert.equal(result.summary['selector-miss'], 1)
})

test('둘째 요소만 다른 경우도 잡는다 — 대표 1개만 재던 자리 (F7)', () => {
  const same = { box: { x: 0, y: 0, w: 100, h: 20 }, style: { color: 'x' } }
  const other = { box: { x: 0, y: 40, w: 100, h: 20 }, style: { color: 'x' } }
  const left = snap('orca', { card: el({ count: 2, countAll: 2, items: [same, other] }) })
  const right = snap('corral', {
    card: el({ count: 2, countAll: 2, items: [same, { ...other, style: { color: 'y' } }] })
  })
  const result = diffSnapshots(left, right, { units: [unit('card')], tolerance: 0.5 })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'style')
  assert.equal(result.findings[0].index, 1)
})

test('허용치 이하 박스 차이는 판정에서 빼되 belowTolerance 로 센다 (F12)', () => {
  const left = snap('orca', { a: el({ box: { x: 0, y: 0, w: 100, h: 20 } }) })
  const right = snap('corral', { a: el({ box: { x: 0.3, y: 0, w: 100, h: 20 } }) })
  const result = diffSnapshots(left, right, { units: [unit('a')], tolerance: 0.5 })
  assert.equal(result.summary.total, 0)
  assert.equal(result.summary.belowTolerance, 1)
  assert.equal(result.belowTolerance[0].detail[0].prop, 'x')
})

test('반올림은 부호 대칭이다 — +0.505 와 -0.505 가 같은 쪽으로 간다 (G7)', () => {
  const box = (x) => ({ x, y: 0, w: 0, h: 0 })
  const plus = diffBoxWithBelow(box(0), box(0.505), 0.5)
  const minus = diffBoxWithBelow(box(0), box(-0.505), 0.5)
  assert.equal(plus.over.length, minus.over.length)
  assert.equal(Math.abs(plus.over[0].delta), Math.abs(minus.over[0].delta))
})

test('렌더 폰트는 선언과 따로 나온다 — 빈 목록은 "같다" 가 아니다 (F14)', () => {
  assert.equal(diffFonts([{ family: 'Geist' }], [{ family: 'Geist' }]), null)
  assert.equal(diffFonts([{ family: 'Geist' }], [{ family: '.SF NS' }]).kind, 'differs')
  assert.equal(diffFonts([{ family: 'Geist' }], []).kind, 'unmeasured')
  const left = snap('orca', { a: el({ platformFonts: [{ family: 'Geist' }] }) })
  const right = snap('corral', { a: el({ platformFonts: [{ family: '.SF NS' }] }) })
  const result = diffSnapshots(left, right, { units: [unit('a')] })
  assert.ok(result.findings.some((finding) => finding.kind === 'font'))
})

test('양쪽 다 선언·조건부 부재면 차이가 아니다', () => {
  const left = snap('orca', { pill: el({ present: false, count: 0, declaredAbsent: true }) })
  const right = snap('corral', { pill: el({ present: false, count: 0, declaredAbsent: true }) })
  assert.equal(diffSnapshots(left, right, { units: [unit('pill')] }).findings.length, 0)
  const cond = diffSnapshots(snap('orca', { pill: el({ present: false, count: 0 }) }), snap('corral', { pill: el({ present: false, count: 0 }) }), {
    units: [unit('pill', { conditional: true })]
  })
  assert.equal(cond.findings.length, 0)
})

test('필수 단위가 **양쪽 다** 0개면 차이 0 이 아니라 측정 실패다 (G6)', () => {
  const left = snap('orca', { shell: el({ present: false, count: 0 }) })
  const right = snap('corral', { shell: el({ present: false, count: 0 }) })
  const result = diffSnapshots(left, right, { units: [unit('shell')] })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'selector-miss')
  assert.equal(result.findings[0].detail.absentSide, 'both')
  // 자기 diff 에서는 세지 않는다 — 같은 앱을 두 번 찍은 흔들림이 아니다
  assert.equal(selfDiff(left, left, { units: [unit('shell')] }).findings.length, 0)
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

// ---- 양성 대조의 판별력 (F9) — 「차이가 있다」와 「그 차이를 잡았다」는 다르다 ----

const controlResults = (findings, { area = 'sidebar', state = 'agents-2' } = {}) => [
  { area, states: [{ state, findings }] }
]
const PREREQ = { orcaCompact: true, orcaNotSendTarget: true }
const controlResultsA = (findings) => controlResults(findings, { state: 'default' })
const controlA = POSITIVE_CONTROLS.filter((control) => control.id === 'C6ⓐ')
const controlB = POSITIVE_CONTROLS.filter((control) => control.id === 'C6ⓑ')

test('C6ⓐ — Orca 있음 / corral 없음이면 통과', () => {
  const rows = evaluateControls({
    results: controlResultsA([{ id: 'nav-buttons', kind: 'missing', detail: { left: '있음 (1)', right: '없음(선언)', absentSide: 'right' } }]),
    prerequisites: PREREQ,
    controls: controlA
  })
  assert.equal(rows[0].pass, true)
})

test('C6ⓐ — 방향이 반대면(우리 쪽 선택자가 썩어 Orca 가 없음) 실패', () => {
  const rows = evaluateControls({
    results: controlResultsA([{ id: 'nav-buttons', kind: 'missing', detail: { left: '없음(선택자 0개)', right: '있음 (1)', absentSide: 'left' } }]),
    prerequisites: PREREQ,
    controls: controlA
  })
  assert.equal(rows[0].pass, false)
  assert.match(rows[0].verdict, /방향/)
})

test('C6ⓐ — 측정 불가(unpaired·selector-miss) 행은 통과 근거가 아니다', () => {
  for (const kind of ['unpaired', 'selector-miss']) {
    const rows = evaluateControls({
      results: controlResultsA([{ id: 'nav-buttons', kind, detail: { reason: 'cannot measure' } }]),
      prerequisites: PREREQ,
      controls: controlA
    })
    assert.equal(rows[0].pass, false, kind)
  }
})

test('전제(requires)를 못 확인하면 실패 — 옛 C6ⓐ 의 compact·send-target 전제 모양', () => {
  const rows = evaluateControls({
    results: controlResults([{ id: 'agent-group-pill', kind: 'missing', detail: { absentSide: 'right' } }]),
    prerequisites: { orcaCompact: false, orcaNotSendTarget: true },
    controls: [{ id: 'prereq', area: 'sidebar', state: 'agents-2', unit: 'agent-group-pill', claim: 'x', expect: { kind: 'missing', absentSide: 'right' }, requires: ['orcaCompact', 'orcaNotSendTarget'] }]
  })
  assert.equal(rows[0].pass, false)
  assert.match(rows[0].verdict, /전제/)
})

test('C6ⓐ — 그 영역·상태를 재지 않았으면 「측정 안 됨」 실패 (통과도 아니고 침묵도 아니다)', () => {
  const rows = evaluateControls({ results: [{ area: 'tabbar', states: [{ state: 'default', findings: [] }] }], prerequisites: PREREQ, controls: controlA })
  assert.equal(rows[0].pass, false)
  assert.match(rows[0].verdict, /측정 안 됨/)
})

test('C6ⓑ — box+style 둘 다 있어야 통과, 하나만이면 실패', () => {
  const both = evaluateControls({
    results: controlResults(
      [
        { id: 'repo-header-icon', kind: 'box', detail: [{ prop: 'w', left: 16, right: 20, delta: 4 }] },
        { id: 'repo-header-icon', kind: 'style', detail: [{ prop: 'backgroundColor', left: 'a', right: 'b' }] }
      ],
      { state: 'default' }
    ),
    prerequisites: PREREQ,
    controls: controlB
  })
  assert.equal(both[0].pass, true)
  const onlyBox = evaluateControls({
    results: controlResults([{ id: 'repo-header-icon', kind: 'box', detail: [{ prop: 'w', left: 16, right: 17, delta: 1 }] }], { state: 'default' }),
    prerequisites: PREREQ,
    controls: controlB
  })
  assert.equal(onlyBox[0].pass, false)
  assert.match(onlyBox[0].verdict, /종류/)
})

// ---- C10 검사기 (F10) — 아무것도 재지 않은 것은 「같은 것」이 아니다 ----

const runOf = (label, keys, summary) => ({
  dir: `/tmp/${label}`,
  label,
  keys: new Map(Object.entries(keys).map(([key, elements]) => [key, { total: elements.length, elements: new Set(elements) }])),
  summary
})
const SUMMARY = { args: { areas: ['sidebar'], states: ['default'] }, gate: { pass: true } }

test('compare-runs — diff 가 없는 빈 회차 둘은 통과가 아니다 (F10)', () => {
  const result = compareRuns([runOf('r6', {}, null), runOf('r10', {}, null)])
  assert.equal(result.ok, false)
  assert.match(result.reason, /유효하지 않은/)
})

test('compare-runs — 요청한 칸이 빠진 회차는 유효하지 않다', () => {
  const partial = runOf('rA', { 'sidebar-default': ['x'] }, { args: { areas: ['sidebar', 'tabbar'], states: ['default'] }, gate: { pass: true } })
  assert.equal(validateRun(partial).ok, false)
  assert.deepEqual(expectedKeys(partial.summary), ['sidebar-default', 'tabbar-default'])
})

test('compare-runs — 자기 관문을 통과하지 못한 회차는 유효하지 않다', () => {
  const failed = runOf('rB', { 'sidebar-default': ['x'] }, { args: { areas: ['sidebar'], states: ['default'] }, gate: { pass: false, why: '잡음 3건' } })
  assert.equal(validateRun(failed).ok, false)
})

test('compare-runs — 같은 집합 두 회차는 통과, 원소가 다르면 미달', () => {
  const same = compareRuns([runOf('r1', { 'sidebar-default': ['a', 'b'] }, SUMMARY), runOf('r2', { 'sidebar-default': ['b', 'a'] }, SUMMARY)])
  assert.equal(same.ok, true)
  const differ = compareRuns([runOf('r1', { 'sidebar-default': ['a', 'b'] }, SUMMARY), runOf('r2', { 'sidebar-default': ['a', 'c'] }, SUMMARY)])
  assert.equal(differ.ok, false)
  assert.equal(differ.mismatches.length, 2)
})

test('compare-runs — 회차가 하나면 재현성을 말하지 않는다', () => {
  assert.equal(compareRuns([runOf('r1', { 'sidebar-default': ['a'] }, SUMMARY)]).ok, false)
})

test('조건부 단위의 0개는 selector-miss 가 아니라 missing 이다 (임계·hover 의존)', () => {
  const left = snap('orca', { pill: el() })
  const right = snap('corral', { pill: el({ present: false, count: 0, declaredAbsent: false }) })
  const asRot = diffSnapshots(left, right, { units: [unit('pill')] })
  assert.equal(asRot.findings[0].kind, 'selector-miss')
  const asConditional = diffSnapshots(left, right, { units: [{ ...unit('pill'), conditional: true }] })
  assert.equal(asConditional.findings[0].kind, 'missing')
  assert.equal(asConditional.findings[0].detail.absentSide, 'right')
})


// ---- G2 부모 단위 짝짓기 ------------------------------------------------------
// 왜 이 자리에 테스트가 필요한가: 전역 순번으로 묶던 판은 자식이 없는 부모를 건너뛰면서
// **다른 탭의 점끼리** 비교했고, 그 거짓 차이(x −122.78px)가 최종 보고서에 「해소 대상」으로 실렸다.

const child = (parentIndex, box, style = { color: 'x' }) => ({ parentIndex, present: true, box, style })
const noChild = (parentIndex) => ({ parentIndex, present: false })
const box = (x) => ({ x, y: 0, w: 8, h: 8 })

test('가운데 부모에 자식이 없으면 다른 부모끼리 짝지어지지 않는다 (G2)', () => {
  // Orca: 0·2번 탭에만 점이 있다. corral: 세 탭 모두 있다.
  const left = snap('orca', {
    dot: el({ parentScoped: true, parents: 3, count: 2, items: [child(0, box(6)), noChild(1), child(2, box(287))] })
  })
  const right = snap('corral', {
    dot: el({ parentScoped: true, parents: 3, count: 3, items: [child(0, box(6)), child(1, box(164)), child(2, box(287))] })
  })
  const result = diffSnapshots(left, right, { units: [unit('dot')], tolerance: 0.5 })
  // 0번·2번 부모는 값이 같으므로 박스 차이가 없어야 한다 — 밀려서 (2↔1) 로 묶이면 여기서 터진다
  assert.equal(result.findings.filter((finding) => finding.kind === 'box').length, 0)
  // 1번 부모는 **그 부모 안의 부재**로 한 건
  const missing = result.findings.filter((finding) => finding.kind === 'missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].detail.parentIndex, 1)
  assert.equal(missing[0].detail.absentSide, 'left')
  // 개수 차이는 따로 한 건
  assert.equal(result.findings.filter((finding) => finding.kind === 'count').length, 1)
})

test('부모 단위 짝짓기에서 같은 부모의 값 차이는 그대로 잡는다', () => {
  const left = snap('orca', { dot: el({ parentScoped: true, parents: 2, count: 2, items: [child(0, box(6)), child(1, box(100))] }) })
  const right = snap('corral', { dot: el({ parentScoped: true, parents: 2, count: 2, items: [child(0, box(6)), child(1, box(120))] }) })
  const result = diffSnapshots(left, right, { units: [unit('dot')], tolerance: 0.5 })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'box')
  assert.equal(result.findings[0].index, 1)
  assert.equal(result.findings[0].detail[0].delta, 20)
})

test('부모 자체가 한쪽에만 있으면 그 사실로 적는다 (자식 값 비교가 아니다)', () => {
  const left = snap('orca', { dot: el({ parentScoped: true, parents: 2, count: 2, items: [child(0, box(6)), child(1, box(100))] }) })
  const right = snap('corral', { dot: el({ parentScoped: true, parents: 1, count: 1, items: [child(0, box(6))] }) })
  const result = diffSnapshots(left, right, { units: [unit('dot')], tolerance: 0.5 })
  const missing = result.findings.filter((finding) => finding.kind === 'missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].detail.right, '없음(부모 자체가 없음)')
})

// ---- R4 부모 안 자식 전부 --------------------------------------------------------
// 왜: 부모 하나에 자식(행·무리)이 여럿이어도 첫 자식만 재던 판은 **둘째 행만 다른** 화면을 같다고 봤다.

const kid = (parentIndex, childIndex, x) => ({ parentIndex, childIndex, present: true, box: box(x), style: { color: 'x' } })

test('둘째 자식만 다르면 그 자리를 잡는다 — 합성 판별력 대조 (R4)', () => {
  const left = snap('orca', { row: el({ parentScoped: true, parents: 1, count: 1, items: [kid(0, 0, 6), kid(0, 1, 40)] }) })
  const right = snap('corral', { row: el({ parentScoped: true, parents: 1, count: 1, items: [kid(0, 0, 6), kid(0, 1, 52)] }) })
  const result = diffSnapshots(left, right, { units: [unit('row')], tolerance: 0.5 })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].kind, 'box')
  assert.equal(result.findings[0].childIndex, 1)
  assert.equal(result.findings[0].detail[0].delta, 12)
  // 대조: 첫 자식만 남기면(예전 도구가 본 모양) 같은 두 화면이 「차이 0」 이 된다 — 도구가 무엇을 못 봤는지
  const firstOnly = (snapshot) => snap(snapshot.app, { row: { ...snapshot.elements.row, items: snapshot.elements.row.items.filter((item) => item.childIndex === 0) } })
  assert.equal(diffSnapshots(firstOnly(left), firstOnly(right), { units: [unit('row')], tolerance: 0.5 }).findings.length, 0)
})

test('같은 부모 안에서 자식 수가 다르면 그 부모 안의 부재로 적는다 (R4)', () => {
  const left = snap('orca', { row: el({ parentScoped: true, parents: 1, count: 1, items: [kid(0, 0, 6), kid(0, 1, 40)] }) })
  const right = snap('corral', { row: el({ parentScoped: true, parents: 1, count: 1, items: [kid(0, 0, 6)] }) })
  const missing = diffSnapshots(left, right, { units: [unit('row')], tolerance: 0.5 }).findings.filter((finding) => finding.kind === 'missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].detail.childIndex, 1)
  assert.equal(missing[0].detail.right, '없음(그 부모 안에 없음)')
})

test('자식 순번이 없는 예전 원자료는 첫 자식으로 읽는다 (R4 하위 호환)', () => {
  const left = snap('orca', { dot: el({ parentScoped: true, parents: 1, count: 1, items: [child(0, box(6))] }) })
  const right = snap('corral', { dot: el({ parentScoped: true, parents: 1, count: 1, items: [kid(0, 0, 6)] }) })
  assert.equal(diffSnapshots(left, right, { units: [unit('dot')], tolerance: 0.5 }).findings.length, 0)
})

// ---- fix-r2 S2 부모당 자식 상한 --------------------------------------------------
// 왜: 부모당 12개까지만 재면서 잘림 표시도, 부모별 자식 수 비교도 없어 12 ↔ 13(13번째만 다름)이 「차이 0」 이었다(review r2).

const kids = (n, lastX = 6) => Array.from({ length: Math.min(n, MAX_CHILDREN) }, (_, i) => kid(0, i, i === n - 1 ? lastX : 6))
const scoped = (n, lastX) => el({ parentScoped: true, parents: 1, count: 1, childCounts: [n], childrenTruncated: n > MAX_CHILDREN, items: kids(n, lastX) })

test('12 ↔ 13 (13번째만 다름) — 부모 안 자식 수 차이와 상한 뒤 미측정을 드러낸다 (S2 판별력)', () => {
  const result = diffSnapshots(snap('orca', { row: scoped(12) }), snap('corral', { row: scoped(13, 99) }), { units: [unit('row')], tolerance: 0.5 })
  const count = result.findings.filter((finding) => finding.kind === 'count')
  assert.equal(count.length, 1)
  assert.deepEqual(count[0].detail, { left: 12, right: 13, parentIndex: 0, scope: 'children' })
  const truncated = result.findings.filter((finding) => finding.kind === 'truncated')
  assert.equal(truncated.length, 1)
  assert.equal(truncated[0].detail.measured, MAX_CHILDREN)
  // 대조: 자식 수 칸이 없으면(수정 전 모양) 잰 12개끼리는 같아서 차이 0 이 된다 — 도구가 무엇을 못 봤는지
  const blind = (n, lastX) => el({ parentScoped: true, parents: 1, count: 1, items: kids(n, lastX) })
  assert.equal(diffSnapshots(snap('orca', { row: blind(12) }), snap('corral', { row: blind(13, 99) }), { units: [unit('row')], tolerance: 0.5 }).findings.length, 0)
})

test('13 ↔ 13 (13번째만 다름) — 수는 같아도 상한 뒤는 「차이 없음」 이 아니라 미측정 (S2)', () => {
  const result = diffSnapshots(snap('orca', { row: scoped(13) }), snap('corral', { row: scoped(13, 99) }), { units: [unit('row')], tolerance: 0.5 })
  assert.equal(result.findings.filter((finding) => finding.kind === 'count').length, 0)
  assert.equal(result.findings.filter((finding) => finding.kind === 'truncated').length, 1)
})

test('상한 안의 같은 수 — count·truncated 없음 (S2 음성 대조)', () => {
  const result = diffSnapshots(snap('orca', { row: scoped(3) }), snap('corral', { row: scoped(3) }), { units: [unit('row')], tolerance: 0.5 })
  assert.equal(result.findings.length, 0)
})

// ---- G7 렌더 폰트 -----------------------------------------------------------

test('폰트 수집 실패는 "같다" 가 아니라 공백(사유)로 나온다 (G7)', () => {
  assert.equal(fontState({ present: true, platformFonts: [{ family: 'Geist' }] }).state, 'ok')
  assert.equal(fontState({ present: true }).state, 'uncollected')
  assert.equal(fontState({ present: true, fontsError: 'boom' }).state, 'error')
  assert.equal(fontState({ present: true, platformFonts: [] }).state, 'noglyph')
  const unmeasured = diffItemFonts({ present: true, platformFonts: [{ family: 'Geist' }] }, { present: true })
  assert.equal(unmeasured.kind, 'unmeasured')
  assert.match(unmeasured.why, /corral/)
})

test('둘째 요소의 렌더 폰트 차이도 잡는다 — 대표 하나만 보던 자리 (G7)', () => {
  const item = (index, family) => ({ index, present: true, box: box(0), style: { color: 'x' }, platformFonts: [{ family }] })
  const left = snap('orca', { label: el({ count: 2, items: [item(0, 'Geist'), item(1, 'Geist')] }) })
  const right = snap('corral', { label: el({ count: 2, items: [item(0, 'Geist'), item(1, '.SF NS')] }) })
  const result = diffSnapshots(left, right, { units: [unit('label')], tolerance: 0.5 })
  const fonts = result.findings.filter((finding) => finding.kind === 'font')
  assert.equal(fonts.length, 1)
  assert.equal(fonts[0].index, 1)
})

// ---- G1 소유 경계 -----------------------------------------------------------
// 왜: 부분 문자열 일치로 남의 Electron 에 SIGTERM 을 보낼 수 있었다. 실제 프로세스 없이 반례로 본다.

const proc = (pid, command) => ({ pid, command })
const ELECTRON = '/path/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'

test('소유 경로의 접두사만 같은 프로필은 소유가 아니다 (G1)', () => {
  const result = selectOwnedByPath({
    processes: [
      proc(456, `${ELECTRON} --user-data-dir=/tmp/l443/corral-userdata-other`),
      proc(457, `${ELECTRON} --user-data-dir=/tmp/l443/corral-userdata`)
    ],
    targets: ['/tmp/l443/corral-userdata']
  })
  assert.deepEqual(result.owned.map((entry) => entry.pid), [457])
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].why, /부분 문자열/)
})

test('소유 경로 **아래**를 쓰는 헬퍼는 소유다 (crashpad 등)', () => {
  const result = selectOwnedByPath({
    processes: [proc(98526, `${ELECTRON} Framework --database=/private/tmp/l443/orca-dev-userdata/Crashpad`)],
    targets: ['/tmp/l443/orca-dev-userdata']
  })
  assert.deepEqual(result.owned.map((entry) => entry.pid), [98526])
})

test('셸·검색 명령은 소유가 아니다 — 회차를 지켜보던 tail 이 걸렸던 자리', () => {
  const result = selectOwnedByPath({
    processes: [proc(1, '/bin/zsh -c tail -f /tmp/l443/corral-userdata/x.log'), proc(2, 'tail -f /tmp/l443/corral-userdata/x.log')],
    targets: ['/tmp/l443/corral-userdata']
  })
  assert.equal(result.owned.length, 0)
})

test('--no-fresh 의 기존 인스턴스는 소유에서 뺀다 (G1)', () => {
  const processes = [proc(700, `${ELECTRON} --user-data-dir=/tmp/l443/corral-userdata`)]
  const targets = ['/tmp/l443/corral-userdata']
  assert.equal(selectOwnedByPath({ processes, targets }).owned.length, 1)
  const excluded = selectOwnedByPath({ processes, targets, exclude: [700] })
  assert.equal(excluded.owned.length, 0)
  assert.match(excluded.rejected[0].why, /이번 실행 전부터/)
})

test('경로 토큰 추출: --opt=값 · --opt 값 · 맨 토큰', () => {
  const tokens = new Set(commandPathTokens('/bin/app --user-data-dir=/a/b --session /c/d -x plain /e/f'))
  for (const expected of ['/bin/app', '/a/b', '/c/d', '/e/f']) assert.ok(tokens.has(expected), expected)
  assert.ok(!tokens.has('plain'), '경로가 아닌 값은 경로 토큰이 아니다')
  assert.equal(isPathInside('/private/tmp/x/y', '/tmp/x'), true)
  assert.equal(isPathInside('/tmp/x-other', '/tmp/x'), false)
  assert.equal(normalizePath('/private/tmp/x/'), '/tmp/x')
})

// ---- G9 C3 대조 방법의 판별력 --------------------------------------------------
// 왜: 「사람이 보기에 차이를 못 찾았다」는 *차이 없음* 과 *이 방법으로는 못 봄* 을 가르지 못한다.
// 그래서 비교 함수 자체에 음성·양성 대조를 붙이고, 그 판별력을 여기서 시험한다.

const flat = (w, h, value) => ({ width: w, height: h, channels: 3, data: Buffer.alloc(w * h * 3, value) })
const striped = (w, h) => {
  const image = flat(w, h, 30)
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (x % 4 === 0) image.data.fill(200, (y * w + x) * 3, (y * w + x) * 3 + 3)
  }
  return image
}

test('C3 대조: 원본↔원본은 0, 색 Δ1 은 검출한다 (G9)', () => {
  const image = flat(20, 10, 37)
  const roi = { x: 2, y: 2, w: 8, h: 4 }
  const result = evaluateRoiControls(image, roi)
  assert.equal(result.negativeOk, true)
  assert.equal(result.negative.maxDelta, 0)
  assert.equal(result.minColorDelta, 1)
})

test('C3 대조: **균일한** ROI 는 이동을 검출하지 못한다 — 그 한계를 값으로 낸다 (G9)', () => {
  const uniform = evaluateRoiControls(flat(20, 10, 37), { x: 2, y: 2, w: 8, h: 4 })
  assert.equal(uniform.minShift, null)
  assert.equal(uniform.uniform, true)
  // 구조가 있으면 1px 이동도 잡힌다 — 기하 민감도는 이 ROI 에서만 말할 수 있다
  const structured = evaluateRoiControls(striped(20, 10), { x: 2, y: 2, w: 8, h: 4 })
  assert.equal(structured.minShift, 1)
  assert.equal(structured.uniform, false)
})

test('C3 대조: ROI 가 이미지 밖이면 던진다 — 밖을 0 으로 채워 「차이 없음」을 만들지 않는다', () => {
  assert.throws(() => compareRoi(flat(10, 10, 0), flat(10, 10, 0), { x: 5, y: 5, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), /밖이다/)
  assert.throws(() => compareRoi(flat(10, 10, 0), flat(10, 10, 0), { x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 0, w: 5, h: 4 }), /ROI 크기가 다르다/)
})

test('PNG 왕복: 디코드→인코드→디코드가 같은 픽셀 (G9 원자료를 사람이 볼 수 있게 남기려면)', () => {
  const image = striped(9, 5)
  const round = decodePng(encodePng(image))
  assert.equal(round.width, 9)
  assert.equal(round.height, 5)
  assert.ok(round.data.equals(image.data))
})

// ---- H1: 신호는 spawn pid 와 그 자손만 -------------------------------------
//
// 리뷰 R3-01 의 반례를 그대로 시험한다. 셋 다 **신호 0건**이어야 한다 — 평탄한 명령줄은
// argv 경계의 증거가 아니라서, 경로가 맞아 보인다는 이유로 남의 프로세스를 죽이면 안 된다.
// 대신 「우리 경로를 쓰는데 우리 것이 아닌 생존 프로세스」는 **보고**되어 회차를 미정리로 만든다.

const PATH_COUNTEREXAMPLES = [
  {
    name: '공백 든 경로 — 남의 프로필 Electron 을 토큰 분할이 우리 것으로 만든다',
    process: {
      pid: 71002,
      command: '/Applications/Electron.app/Contents/MacOS/Electron --user-data-dir=/tmp/l443/corral-userdata backup'
    },
    survivor: true
  },
  {
    name: '`-other` 접미사 — 부분 문자열만 겹친다',
    process: { pid: 71003, command: '/Applications/Electron.app/Contents/MacOS/Electron --user-data-dir=/tmp/l443/corral-userdata-other' },
    survivor: false
  },
  {
    name: 'python 이 프로필 경로를 인자로 들고 있다 — 앱이 아니다',
    process: { pid: 71004, command: '/usr/bin/python3 /tmp/l443/corral-userdata/inspect.py' },
    survivor: true
  }
]

test('H1 — **우리 경로에 공백이 있어도** 고아를 놓치지 않는다 (R3-01 의 반대 방향)', () => {
  // corral CLI 응답이 실패해 데스크톱 pid 를 못 받았고 PPID 로도 못 잇는 고아. 토큰 분할이면
  // `/virtual/my` 로 잘려 「경계 일치 없음」이 되고 `clean:true` 가 나온다 — 그 자리를 막는다.
  const target = '/virtual/my work/corral-userdata'
  const orphan = { pid: 81003, command: `/Applications/Electron.app/Contents/MacOS/Electron --user-data-dir=${target}` }
  const signals = planSignals({ owned: [{ pid: 81002, label: 'corral backend' }], descendantsOf: () => [] })
  assert.deepEqual(signals.map((entry) => entry.pid), [81002])
  const { survivors } = classifyPathSurvivors({
    processes: [orphan],
    targets: [target],
    signalled: signals.map((entry) => entry.pid),
    alive: () => true
  })
  assert.equal(survivors.length, 1)
  assert.equal(survivors[0].pid, 81003)
  assert.equal(survivors[0].signalled, false)
})

test('H1 — 경로 언급 판정은 경계를 본다 (`-other` 는 다른 경로, 자식 폴더는 같은 경로)', () => {
  const t = '/tmp/l443/corral-userdata'
  assert.equal(commandMentionsPath(`Electron --user-data-dir=${t}`, t), true)
  assert.equal(commandMentionsPath(`Electron --user-data-dir=${t} backup`, t), true)
  assert.equal(commandMentionsPath(`Electron --database=${t}/Crashpad`, t), true)
  assert.equal(commandMentionsPath(`Electron --user-data-dir=${t}-other`, t), false)
  assert.equal(commandMentionsPath(`Electron --user-data-dir=${t}x/deep`, t), false)
  // /private/tmp 와 /tmp 는 같은 폴더의 두 이름이다
  assert.equal(commandMentionsPath('Electron --user-data-dir=/private/tmp/l443/corral-userdata', t), true)
})

for (const example of PATH_COUNTEREXAMPLES) {
  test(`H1 — ${example.name}: 신호 0건, spawn 자손만 신호한다`, () => {
    const spawned = { pid: 90001, label: 'corral backend', group: false }
    const descendants = { 90001: [90002, 90003], 90002: [], 90003: [] }
    const signals = planSignals({ owned: [spawned], descendantsOf: (pid) => descendants[pid] ?? [] })
    // ① 신호 대상은 spawn pid 와 그 자손뿐이다 — 후보 프로세스는 목록에 들어오지도 않는다
    assert.deepEqual(
      signals.map((entry) => entry.pid),
      [90001, 90002, 90003]
    )
    assert.equal(signals.some((entry) => entry.pid === example.process.pid), false)
    // ② 경로 분류는 **신호를 만들지 않는다**. 살아 있으면 미정리로 보고할 뿐이다
    const { survivors, rejected } = classifyPathSurvivors({
      processes: [example.process],
      targets: ['/tmp/l443/corral-userdata'],
      signalled: signals.map((entry) => entry.pid),
      alive: () => true
    })
    assert.equal(survivors.every((entry) => entry.signalled === false), true)
    if (example.survivor) {
      assert.deepEqual(survivors.map((entry) => entry.pid), [example.process.pid])
    } else {
      assert.deepEqual(survivors, [])
      assert.equal(rejected.some((entry) => entry.pid === example.process.pid), true)
    }
  })
}

test('H1 — 자손 조회는 신호 전에 끝난다(부모를 죽이면 사슬이 끊긴다) · 중복 pid 는 한 번만', () => {
  const asked = []
  const signals = planSignals({
    owned: [
      { pid: 8001, label: 'orca dev runner', group: true },
      { pid: 8002, label: 'corral backend', group: false },
      { pid: 8001, label: '중복', group: true }
    ],
    descendantsOf: (pid) => {
      asked.push(pid)
      return pid === 8001 ? [8010, 8011] : [8010]
    }
  })
  assert.deepEqual(asked, [8001, 8002])
  assert.deepEqual(signals.map((entry) => entry.pid), [8001, 8010, 8011, 8002])
  assert.equal(signals[0].group, true)
  assert.equal(signals[1].viaParent, 8001)
  // 8002 의 자손 8010 은 이미 8001 의 자손으로 신호 목록에 있다 — 두 번 보내지 않는다
  assert.equal(signals.filter((entry) => entry.pid === 8010).length, 1)
})

test('H1 — 이미 죽었거나 신호한 pid 는 미정리 목록에 넣지 않는다', () => {
  const processes = [
    { pid: 90002, command: '/Applications/Electron.app/Contents/MacOS/Electron --user-data-dir=/tmp/l443/corral-userdata' },
    { pid: 71005, command: '/Applications/Electron.app/Contents/MacOS/Electron --user-data-dir=/tmp/l443/corral-userdata' }
  ]
  const { survivors } = classifyPathSurvivors({
    processes,
    targets: ['/tmp/l443/corral-userdata'],
    signalled: [90001, 90002],
    alive: (pid) => pid !== 71005
  })
  assert.deepEqual(survivors, [])
})

// ---- H2: 요소별 폰트 수집 실패는 관문으로 간다 -----------------------------

test('H2 — 요소별 폰트 실패가 있으면 관문 사유가 나온다 (수집 자체는 성공해도)', () => {
  const why = fontCaptureFailures('tabbar-default-orca-b', {
    fontsCollected: true,
    fontsRequested: 5,
    fontsMeasured: 4,
    fontErrors: [{ unit: 'tab', key: 'tab#0', error: 'mock font transport failure' }]
  })
  assert.equal(why.length, 1)
  assert.match(why[0], /tabbar-default-orca-b: 요소별 폰트 수집 실패 1건/)
  assert.match(why[0], /tab#0: mock font transport failure/)
})

test('H2 — 글리프 없는 노드(빈 목록)는 실패가 아니다 · 수집 자체 실패는 따로 센다', () => {
  assert.deepEqual(fontCaptureFailures('x', { fontsCollected: true, fontsRequested: 3, fontsMeasured: 3, fontErrors: [] }), [])
  const both = fontCaptureFailures('y', {
    fontsCollected: false,
    platformFontsError: 'CSS.enable 실패',
    fontErrors: [
      { key: 'a#0', error: 'e1' },
      { key: 'b#0', error: 'e2' }
    ]
  })
  assert.equal(both.length, 2)
  assert.match(both[0], /CSS\.enable 실패/)
  assert.match(both[1], /2건/)
})

// ---- I1: 경로 진단은 정규식이 아니라 문자열이고, 검색 실패는 통과가 아니다 -----

const PS_OUTPUT = [
  '  101 /bin/zsh -l',
  '  900 /Applications/Electron.app/Contents/MacOS/Electron --user-data-dir=WORK/corral-userdata --remote-debugging-port=9445',
  ' 1001 /usr/sbin/cupsd -l',
  ''
].join('\n')

for (const work of ['/tmp/l443[1]', '/tmp/l443+', '/tmp/l443(2)', '/tmp/l443.d', '/tmp/l443*']) {
  test(`I1 — 정규식 문자가 든 작업 경로(${work})에서도 고아를 찾아 clean:false 로 간다`, () => {
    const target = `${work}/corral-userdata`
    const probe = { ok: true, processes: parseProcessList(PS_OUTPUT.replaceAll('WORK', work)), error: null }
    // ① 목록 파싱: pid 와 명령줄이 갈린다
    assert.deepEqual(probe.processes.map((entry) => entry.pid), [101, 900, 1001])
    // ② 리터럴 포함 — `pgrep -f <경로>` 였다면 이 경로들은 ERE 로 해석돼 못 찾았다
    assert.equal(commandIncludesPath(probe.processes[1].command, target), true)
    // ③ spawn 한 backend(101) 만 신호했고, CLI 응답 실패로 잃은 데스크톱(900)은 자손도 아니다
    const diagnosis = pathDiagnosis({ probe, targets: [target], signalled: [101], alive: () => true })
    assert.equal(diagnosis.ok, true)
    assert.deepEqual(diagnosis.survivors.map((entry) => entry.pid), [900])
    assert.equal(diagnosis.survivors[0].signalled, false)
    // ④ 그 회차는 정리 실패다
    const verdict = cleanVerdict({ signalled: [{ pid: 101, alive: false }], diagnosis })
    assert.equal(verdict.clean, false)
    assert.deepEqual(verdict.survivorPids, [900])
  })
}

test('I1 — 검색 명령이 실패하면 「후보 없음」이 아니라 진단 실패 → clean:false (fail closed)', () => {
  for (const probe of [
    { ok: false, processes: [], error: 'ps → 종료코드 1' },
    { ok: false, processes: [], error: 'ps 출력이 비었다 — 경로 진단을 못 했다' },
    null
  ]) {
    const diagnosis = pathDiagnosis({ probe, targets: ['/tmp/l443/corral-userdata'], signalled: [101] })
    assert.equal(diagnosis.ok, false)
    assert.deepEqual(diagnosis.survivors, [])
    const verdict = cleanVerdict({ signalled: [{ pid: 101, alive: false }], diagnosis })
    // 신호한 pid 는 전부 죽었지만 **확인하지 못했으므로** 통과가 아니다
    assert.equal(verdict.clean, false)
    assert.match(verdict.why, /경로 진단 실패/)
  }
})

test('I1 — 정상 진단에서 후보가 정말 없으면 clean:true (양성/음성 대조)', () => {
  const probe = { ok: true, processes: parseProcessList(PS_OUTPUT.replaceAll('WORK', '/tmp/other')), error: null }
  const diagnosis = pathDiagnosis({ probe, targets: ['/tmp/l443/corral-userdata'], signalled: [101] })
  assert.equal(diagnosis.ok, true)
  assert.deepEqual(diagnosis.survivors, [])
  assert.equal(diagnosis.candidates, 0)
  assert.equal(cleanVerdict({ signalled: [{ pid: 101, alive: false }], diagnosis }).clean, true)
})

test('I1 — 목록 파싱은 공백·빈 줄·잘린 줄을 버리고 명령줄의 공백을 지킨다', () => {
  const parsed = parseProcessList(['', '  12 /bin/sh -c "a b  c"', 'nope', '  x /bin/true', ' 13 ', '  14 /usr/bin/foo'].join('\n'))
  assert.deepEqual(parsed, [
    { pid: 12, command: '/bin/sh -c "a b  c"' },
    { pid: 14, command: '/usr/bin/foo' }
  ])
})
