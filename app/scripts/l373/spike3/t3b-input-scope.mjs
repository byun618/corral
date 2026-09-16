// LIFE-373 3차 보강 — T3 후속: 입력이 "들어가는 pane" 의 경계가 무엇인가.
// 1차 T3 에서 connB(탭 B 서피스)가 탭 A 의 pane 에 보낸 입력이 사라졌다. 원인 후보:
//   (가) 연결 서피스(=그 연결이 보고 있는 탭)에 없는 pane 이면 버려진다
//   (나) 세션 포커스가 없는 연결의 입력이 버려진다
// (a)(b)(c) 세 케이스로 가른다. 판별자는 전부 control 소켓 pane.read.

import { execFileSync } from 'node:child_process'
import { SESSION, clientSocketPath, ctl, layout, loadVendor, paneList, sleep, tabList, writeRaw3 } from './lib3.mjs'

const { EndpointClient, VtInputClassifier } = await loadVendor()
const NONCE = String(Date.now()).slice(-8)
const cases = []
const paneRead = (id) =>
  execFileSync('herdr', ['--session', SESSION, 'pane', 'read', id, '--format', 'text', '--lines', '40'], { encoding: 'utf8' })
const focusNow = () => ({ focusedPaneId: layout().focused_pane_id, tabsFocused: tabList().filter((t) => t.focused).map((t) => t.tab_id) })

const panesT1 = paneList().filter((p) => p.tab_id === 'w1:t1')
const paneA = panesT1.find((p) => p.pane_id === 'w1:p1') ?? panesT1[0]
const paneA2 = panesT1.find((p) => p.pane_id !== paneA.pane_id)
if (!paneA2) throw new Error('탭 A 에 pane 이 2개가 아니다')

const createdTab = ctl('tab', 'create', '--label', `l373s3b-${NONCE}`)
const tabB = createdTab.tab?.tab_id ?? createdTab.tab_id
await sleep(1200)
const paneB = paneList().find((p) => p.tab_id === tabB)

const mkConn = async (pane) => {
  const client = new EndpointClient(clientSocketPath)
  client.on('error', () => {})
  await client.connect(160, 44)
  await client.callEndpoint('pane.focus', { pane_id: pane.pane_id })
  await sleep(900)
  return { client, classifier: new VtInputClassifier(), paneId: pane.pane_id }
}
const connA = await mkConn(paneA)
const connB = await mkConn(paneB)
await sleep(900)

const surfacePanes = (c) => c.client.currentSurface?.panes.map((p) => p.paneId) ?? null
const send = (conn, targetPaneId, marker) => {
  const events = conn.classifier.feed(Buffer.from(`echo ${marker}\r`, 'utf8'))
  conn.client.sendPaneInput(targetPaneId, events)
  const flushed = conn.classifier.flush()
  if (flushed.length > 0) conn.client.sendPaneInput(targetPaneId, flushed)
  return events.length + flushed.length
}

async function run(name, 설명, conn, targetPaneId) {
  const marker = `L373${name}-${NONCE}`
  const focusBefore = focusNow()
  const surfaceBefore = surfacePanes(conn)
  let error = null
  let eventCount = null
  try {
    eventCount = send(conn, targetPaneId, marker)
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
  await sleep(1500)
  const text = paneRead(targetPaneId)
  const entry = {
    case: name,
    설명,
    targetPane: targetPaneId,
    연결서피스: surfaceBefore,
    서피스에타깃있음: surfaceBefore?.includes(targetPaneId) ?? null,
    marker,
    eventCount,
    error,
    들어갔나: text.includes(marker),
    focusBefore,
    focusAfter: focusNow(),
    tail: text.split('\n').slice(-8),
  }
  cases.push(entry)
  console.log(`# ${name} ${설명} → 들어갔나=${entry.들어갔나} 서피스에타깃있음=${entry.서피스에타깃있음} focus=${entry.focusAfter.focusedPaneId}`)
  return entry
}

// (a) connA → 같은 탭(A)의 다른 pane. 세션 포커스는 탭 B 에 있다.
await run('A', 'connA(탭A 서피스) → 탭A 의 비포커스 pane', connA, paneA2.pane_id)
// (b) connB → 다른 탭(A)의 pane. 세션 포커스는 connB 가 쥐고 있다.
await run('B', 'connB(탭B 서피스, 포커스 보유) → 탭A 의 pane (교차 탭)', connB, paneA.pane_id)
// (c) connB 가 탭 A 로 서피스를 옮긴 뒤 같은 pane 에 다시.
await connB.client.callEndpoint('pane.focus', { pane_id: paneA.pane_id })
await sleep(1200)
await run('C', 'connB 가 탭A 로 pane.focus 한 뒤 → 탭A 의 pane', connB, paneA.pane_id)

connA.client.close()
connB.client.close()
await sleep(600)
ctl('tab', 'close', tabB)
await sleep(800)
const cleanup = { closedTab: tabB, tabsNow: tabList().map((t) => t.tab_id), focus: focusNow() }
console.log('# cleanup', JSON.stringify(cleanup))

writeRaw3('t3b-input-scope.json', {
  step: 'T3b',
  at: new Date().toISOString(),
  session: SESSION,
  nonce: NONCE,
  panes: { paneA: paneA.pane_id, paneA2: paneA2.pane_id, paneB: paneB.pane_id, tabB },
  cases,
  cleanup,
})
process.exit(0)
