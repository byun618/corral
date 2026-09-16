// LIFE-373 3차 — T1(비포커스 탭 pane 입력) · T5(입력이 포커스를 끄는가) · T3(같은 pane 두 연결) · T2(비포커스 스크롤)
//
// 관문 ②: 판별자는 전부 **control 소켓**(herdr CLI, 별도 커넥션). 연결 자신의 서피스는 기록만 한다.
// 관문 ④: 앱 본체 무수정 — 벤더 클라이언트·입력 분류기를 esbuild 로 그대로 묶어 쓴다.

import { execFileSync } from 'node:child_process'
import {
  SESSION,
  clientSocketPath,
  ctl,
  layout,
  loadVendor,
  paneList,
  sleep,
  tabList,
  writeRaw3,
} from './lib3.mjs'

const { EndpointClient, VtInputClassifier } = await loadVendor()
const NONCE = String(Date.now()).slice(-8)
const log = []
const note = (label, data) => {
  const e = { label, at: new Date().toISOString(), ...data }
  log.push(e)
  console.log('#', label, JSON.stringify(data ?? {}).slice(0, 400))
  return e
}

/** control 소켓으로 pane 화면을 읽는다 (text 는 JSON 이 아니라 평문). */
function paneRead(paneId, lines = 40) {
  return execFileSync('herdr', ['--session', SESSION, 'pane', 'read', paneId, '--format', 'text', '--lines', String(lines)], {
    encoding: 'utf8',
  })
}
const paneGet = (paneId) => ctl('pane', 'get', paneId).pane
const snapshotFocus = () => ({
  focusedPaneId: layout().focused_pane_id,
  panesFocused: paneList().filter((p) => p.focused).map((p) => p.pane_id),
  tabsFocused: tabList().filter((t) => t.focused).map((t) => t.tab_id),
  tabs: tabList().map((t) => ({ id: t.tab_id, focused: t.focused, label: t.label ?? null })),
})

// --- 준비: 탭 A(기존, 스크롤백 있는 pane) + 탭 B(새로 만듦) ------------------------
const created = { tabs: [] }
const before = paneList()
const tabsBefore = tabList()
note('before', { panes: before.map((p) => ({ id: p.pane_id, tab: p.tab_id, scroll: p.scroll })), tabs: tabsBefore.map((t) => t.tab_id) })

// T2 전제: pane A 는 스크롤백이 있어야 한다 (max_offset_from_bottom > 0)
const paneA = before.slice().sort((a, b) => b.scroll.max_offset_from_bottom - a.scroll.max_offset_from_bottom)[0]
const tabA = paneA.tab_id

const createdTab = ctl('tab', 'create', '--label', `l373s3-${NONCE}`)
const tabB = createdTab.tab?.tab_id ?? createdTab.tab_id
created.tabs.push(tabB)
await sleep(1200)
const paneB = paneList().find((p) => p.tab_id === tabB)
if (!paneB) throw new Error('탭 B 의 pane 을 찾지 못했다')

note('setup', {
  paneA: { id: paneA.pane_id, tab: tabA, maxOffsetFromBottom: paneA.scroll.max_offset_from_bottom },
  paneB: { id: paneB.pane_id, tab: tabB },
  t2Precondition: paneA.scroll.max_offset_from_bottom > 0 ? '충족(스크롤백 있음)' : '미충족(스크롤백 0 — T2 판정 불가)',
})

// --- 연결 2개: connA→paneA(탭 A), connB→paneB(탭 B). 포커스는 마지막인 B 에 남는다 ---
const mkConn = async (pane) => {
  const client = new EndpointClient(clientSocketPath)
  client.on('error', () => {})
  await client.connect(160, 44)
  await client.callEndpoint('pane.focus', { pane_id: pane.pane_id })
  await sleep(900)
  return { client, classifier: new VtInputClassifier(), paneId: pane.pane_id, tabId: pane.tab_id }
}
const connA = await mkConn(paneA)
const connB = await mkConn(paneB)
await sleep(900)

const surfaceOf = (c) => {
  const s = c.client.currentSurface
  if (s === null) return null
  return {
    revision: s.surfaceRevision,
    frame: `${s.frame.width}x${s.frame.height}`,
    panes: s.panes.map((p) => ({ paneId: p.paneId, focused: p.focused })),
    hasOwnPane: s.panes.some((p) => p.paneId === c.paneId),
  }
}

const gate = snapshotFocus()
const gateOk = gate.focusedPaneId === paneB.paneId || gate.focusedPaneId === paneB.pane_id
note('전제-게이트', {
  기대: `focused_pane_id === ${paneB.pane_id} (탭 B)`,
  실제: gate.focusedPaneId,
  통과: gateOk,
  surfaces: { connA: surfaceOf(connA), connB: surfaceOf(connB) },
  focus: gate,
})
if (!gateOk) console.error('!! 전제 미충족 — 포커스가 탭 B 에 없다. 결과는 무효로 기록한다')

/** 본체(endpoint-terminal-session.input)와 같은 경로로 바이트를 보낸다. */
function sendBytes(conn, targetPaneId, text) {
  const events = conn.classifier.feed(Buffer.from(text, 'utf8'))
  conn.client.sendPaneInput(targetPaneId, events)
  const flushed = conn.classifier.flush()
  if (flushed.length > 0) conn.client.sendPaneInput(targetPaneId, flushed)
  return { eventCount: events.length, flushedCount: flushed.length }
}

// --- T1: 포커스가 탭 B 에 있는 상태에서 connA 가 비포커스 탭 A 의 pane 에 입력 ---------
const M1 = `L373T1-${NONCE}`
const focusBeforeT1 = snapshotFocus()
let sendErr = null
let sent = null
try {
  sent = sendBytes(connA, paneA.pane_id, `echo ${M1}\r`)
} catch (e) {
  sendErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
await sleep(1200)
const readA1 = paneRead(paneA.pane_id)
const readB1 = paneRead(paneB.pane_id)
let retry = null
if (!readA1.includes(M1) && !readB1.includes(M1)) {
  await sleep(2000)
  retry = { A: paneRead(paneA.pane_id), B: paneRead(paneB.pane_id) }
}
const focusAfterT1 = snapshotFocus()
const t1 = {
  marker: M1,
  sendError: sendErr,
  sent,
  markerInA: readA1.includes(M1) || (retry?.A.includes(M1) ?? false),
  markerInB: readB1.includes(M1) || (retry?.B.includes(M1) ?? false),
  retried: retry !== null,
  focusBefore: focusBeforeT1,
  focusAfter: focusAfterT1,
  focusMoved: focusBeforeT1.focusedPaneId !== focusAfterT1.focusedPaneId,
  tabFocusMoved: JSON.stringify(focusBeforeT1.tabsFocused) !== JSON.stringify(focusAfterT1.tabsFocused),
  readA: readA1.split('\n').slice(-12),
  readB: readB1.split('\n').slice(-12),
  retryRead: retry === null ? null : { A: retry.A.split('\n').slice(-12), B: retry.B.split('\n').slice(-12) },
}
note('T1', { markerInA: t1.markerInA, markerInB: t1.markerInB, sendError: sendErr, focusMoved: t1.focusMoved, tabFocusMoved: t1.tabFocusMoved })
note('T5', { 질문: '입력만으로 herdr 포커스가 따라오나', before: focusBeforeT1.focusedPaneId, after: focusAfterT1.focusedPaneId, 탭포커스이동: t1.tabFocusMoved })

// --- T3: connB(포커스 보유 연결)도 같은 pane A 에 입력 → 둘 다 들어가나 -------------
const M2 = `L373T3-${NONCE}`
let sendErr3 = null
let sent3 = null
try {
  sent3 = sendBytes(connB, paneA.pane_id, `echo ${M2}\r`)
} catch (e) {
  sendErr3 = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
await sleep(1500)
const readA3 = paneRead(paneA.pane_id)
const t3 = {
  marker: M2,
  sendError: sendErr3,
  sent: sent3,
  marker1StillThere: readA3.includes(M1),
  marker2In: readA3.includes(M2),
  focus: snapshotFocus(),
  readA: readA3.split('\n').slice(-14),
}
note('T3', { marker1: t3.marker1StillThere, marker2: t3.marker2In, sendError: sendErr3 })

// --- T2: 비포커스 탭 pane 에 pane.scroll -------------------------------------------
const K = 40
const scrollBefore = paneGet(paneA.pane_id).scroll
let scrollErr = null
let scrollResp = null
try {
  scrollResp = await connA.client.callEndpoint('pane.scroll', { pane_id: paneA.pane_id, offset_from_bottom: K })
} catch (e) {
  scrollErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}
await sleep(1200)
const scrollAfter = paneGet(paneA.pane_id).scroll
// 원상 복귀
try {
  await connA.client.callEndpoint('pane.scroll', { pane_id: paneA.pane_id, offset_from_bottom: 0 })
} catch { /* 실패해도 아래 복구 확인에 남는다 */ }
await sleep(800)
const t2 = {
  요청offset: K,
  before: scrollBefore,
  after: scrollAfter,
  restored: paneGet(paneA.pane_id).scroll,
  변했나: scrollBefore.offset_from_bottom !== scrollAfter.offset_from_bottom,
  기대대로: scrollAfter.offset_from_bottom === K,
  error: scrollErr,
  response: scrollResp ?? null,
  advertisedMethods: connA.client.welcome?.endpointMethods ?? connA.client.welcome?.capabilities ?? null,
}
note('T2', { before: scrollBefore.offset_from_bottom, after: scrollAfter.offset_from_bottom, 기대: K, error: scrollErr })

// --- 정리 ---------------------------------------------------------------------
connA.client.close()
connB.client.close()
await sleep(600)
let cleanup = null
try {
  ctl('tab', 'close', tabB)
  await sleep(800)
  cleanup = { closedTab: tabB, tabsNow: tabList().map((t) => t.tab_id) }
} catch (e) {
  cleanup = { closedTab: tabB, error: e instanceof Error ? e.message : String(e), tabsNow: tabList().map((t) => t.tab_id) }
}
note('cleanup', cleanup)

writeRaw3('t1-nonfocus-input.json', {
  step: 'T1+T5+T3+T2',
  at: new Date().toISOString(),
  session: SESSION,
  nonce: NONCE,
  paneA: { id: paneA.pane_id, tab: tabA, maxOffsetFromBottom: paneA.scroll.max_offset_from_bottom },
  paneB: { id: paneB.pane_id, tab: tabB },
  gate: { 통과: gateOk, ...gate },
  T1: t1,
  T3: t3,
  T2: t2,
  cleanup,
  log,
})
process.exit(0)
