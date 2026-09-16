// LIFE-373 3차 — T3 본문: **같은 pane** 에 연결 2개가 각각 입력하면 둘 다 들어가나(attach 소유권이 있나).
// T3b 로 "서피스에 있는 pane 이면 들어간다"가 밝혀졌으므로, 두 연결 모두 같은 탭에 붙인 뒤 같은 pane 에 쏜다.

import { execFileSync } from 'node:child_process'
import { SESSION, clientSocketPath, layout, loadVendor, paneList, sleep, writeRaw3 } from './lib3.mjs'

const { EndpointClient, VtInputClassifier } = await loadVendor()
const NONCE = String(Date.now()).slice(-8)
const paneRead = (id) =>
  execFileSync('herdr', ['--session', SESSION, 'pane', 'read', id, '--format', 'text', '--lines', '40'], { encoding: 'utf8' })

const target = paneList().find((p) => p.pane_id === 'w1:p1') ?? paneList()[0]

const mkConn = async () => {
  const client = new EndpointClient(clientSocketPath)
  client.on('error', () => {})
  await client.connect(160, 44)
  await client.callEndpoint('pane.focus', { pane_id: target.pane_id })
  await sleep(900)
  return { client, classifier: new VtInputClassifier() }
}
const c1 = await mkConn()
const c2 = await mkConn()
await sleep(900)

const send = (conn, marker) => {
  const events = conn.classifier.feed(Buffer.from(`echo ${marker}\r`, 'utf8'))
  conn.client.sendPaneInput(target.pane_id, events)
  const flushed = conn.classifier.flush()
  if (flushed.length > 0) conn.client.sendPaneInput(target.pane_id, flushed)
}
const m1 = `L373T3c1-${NONCE}`
const m2 = `L373T3c2-${NONCE}`
send(c1, m1)
await sleep(1200)
send(c2, m2)
await sleep(1500)
const text = paneRead(target.pane_id)
const result = {
  targetPane: target.pane_id,
  conn1마커: m1,
  conn2마커: m2,
  conn1들어감: text.includes(m1),
  conn2들어감: text.includes(m2),
  순서대로: text.indexOf(m1) >= 0 && text.indexOf(m2) > text.indexOf(m1),
  focusedPaneId: layout().focused_pane_id,
  tail: text.split('\n').slice(-10),
}
console.log('# T3c', JSON.stringify({ conn1: result.conn1들어감, conn2: result.conn2들어감, 순서대로: result.순서대로 }))
c1.client.close()
c2.client.close()
await sleep(600)
writeRaw3('t3c-same-pane-two-conns.json', { step: 'T3c', at: new Date().toISOString(), session: SESSION, nonce: NONCE, result })
process.exit(0)
