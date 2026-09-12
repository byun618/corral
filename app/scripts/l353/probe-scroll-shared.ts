// S4 오라클 전제 프로브 — **하네스를 짓기 전에** 검증한다 (advisor 지시 1).
//
// 전제: endpoint 연결(herdr-client.sock)로 보낸 `pane.scroll` 이 서버측 pane 스크롤 상태를
// 움직이고, 그 상태를 **control 소켓(herdr.sock)의 `pane.read visible`** 이 반영한다.
// 스파이크(LIFE-342 b-scrollback)는 control↔control 만 증명했다 — S4 의 증거 설계는
// endpoint(재는 대상)와 control(제3 오라클)이 같은 스크롤 상태를 본다는 데 서 있다.
// 여기가 무너지면 S4 증거 설계를 다시 짜야 하므로 먼저 잰다.
//
// 실행: npx tsx scripts/l353/probe-scroll-shared.ts

import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { EndpointClient } from '../../src/main/adapter/internal/vendor/endpoint-client'

const SESSION = 'life353-claude'
const dir = path.join(os.homedir(), '.config/herdr/sessions', SESSION)
const controlSock = path.join(dir, 'herdr.sock')
const clientSock = path.join(dir, 'herdr-client.sock')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function control(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlSock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timeout ${method}`))
    }, 10000)
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'p1', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.end()
      const message = JSON.parse(buffer.slice(0, index))
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
  })
}

/** visible 텍스트에서 "마커 N" 의 최소·최대 줄 번호. */
function span(text: string): { min: number | null; max: number | null } {
  const numbers = [...text.matchAll(/마커 (\d+)/g)].map((m) => Number(m[1]))
  if (numbers.length === 0) return { min: null, max: null }
  return { min: Math.min(...numbers), max: Math.max(...numbers) }
}

async function readVisible(paneId: string) {
  const r = await control('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
  return { span: span(r.read.text), revision: r.read.revision }
}

async function main() {
  const panes = (await control('pane.list', {})).panes
  const paneId: string = panes[0].pane_id
  console.log('pane:', paneId)

  // 씨앗 — 스크롤백 300줄
  await control('pane.send_text', { pane_id: paneId, text: "clear; seq 1 300 | awk '{print \"마커 \" $1}'\n" })
  await sleep(2500)

  const result: Record<string, unknown> = { at: new Date().toISOString(), paneId }

  const bottom = await readVisible(paneId)
  console.log('bottom visible:', bottom)
  result['step1_bottom'] = bottom

  // endpoint 연결 — 재는 대상과 같은 경로
  const client = new EndpointClient(clientSock)
  client.on('error', (e) => console.log('endpoint error:', (e as Error).message))
  await client.connect(100, 30)
  await client.callEndpoint('pane.focus', { pane_id: paneId })
  await sleep(500)
  const surface = client.currentSurface
  const paneMeta = surface?.panes.find((p) => p.paneId === paneId)
  console.log('endpoint surface pane scroll:', paneMeta?.scroll)
  result['step2_endpointScrollMeta'] = paneMeta?.scroll ?? null

  // endpoint 로 스크롤 60줄 위로
  await client.callEndpoint('pane.scroll', { pane_id: paneId, offset_from_bottom: 60 })
  await sleep(700)
  const scrolled = await readVisible(paneId)
  const paneGet = await control('pane.get', { pane_id: paneId })
  console.log('after endpoint pane.scroll(60): control pane.read visible =', scrolled)
  console.log('control pane.get scroll =', paneGet.pane.scroll)
  result['step3_afterEndpointScroll'] = { controlRead: scrolled, controlPaneGetScroll: paneGet.pane.scroll }

  // endpoint surface 쪽도 움직였나
  const surfaceAfter = client.currentSurface
  result['step3_endpointScrollMeta'] = surfaceAfter?.panes.find((p) => p.paneId === paneId)?.scroll ?? null

  // 복귀
  await client.callEndpoint('pane.scroll', { pane_id: paneId, offset_from_bottom: 0 })
  await sleep(700)
  const restored = await readVisible(paneId)
  console.log('after restore(0):', restored)
  result['step4_restored'] = restored

  const moved =
    bottom.span.max !== null &&
    scrolled.span.max !== null &&
    scrolled.span.max < bottom.span.max &&
    restored.span.max === bottom.span.max
  result['verdict_sharedScrollState'] = moved
  console.log('\n=== 공유 스크롤 상태 판정:', moved ? '공유된다 (S4 설계 유지)' : '공유 안 됨 (S4 재설계 필요)')
  console.log(JSON.stringify(result))
  client.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
