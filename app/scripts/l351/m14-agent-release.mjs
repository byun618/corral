// M14 — `pane.release_agent` 때 herdr 가 **무엇을 보내나** (수정 3회차 N8 이 문 자리).
//
// N8 이 "뗀 뒤에도 이름 칩이 남는다" 로 미달을 냈다. 원인을 추측으로 적지 않으려고,
// 두 구독을 하네스가 **직접** 열어 봉투를 통째로 받아 적는다 (제3 오라클은 `pane.list`).
//
//   agent 구독 = `pane.agent_status_changed` (pane_id 파라미터 구독)
//   본  구독  = `pane_agent_detected`
//
// 이 실측이 말하는 것: **상태 봉투에도 `agent` 가 실려 온다.** 그래서 그 값을 "지금 이 pane 의
// 에이전트" 로 읽으면, `released` 가 먼저 온 순서에서 방금 지운 이름을 도로 붙이게 된다.

import net from 'node:net'
import { REPO_DIR, request, socketPath, sleep, tidySession, writeRaw } from './lib.mjs'

/** 구독 한 줄만 쓰는 커넥션 — 앱의 `Subscription` 과 같은 모양(`events.subscribe`). */
function subscribe(subscriptions, label, sink) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath())
    let buffer = ''
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ id: `m14-${label}`, method: 'events.subscribe', params: { subscriptions } })}\n`),
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) sink({ label, at: Date.now(), frame: JSON.parse(line) })
      }
    })
    setTimeout(() => resolve(socket), 500)
  })
}

await tidySession(REPO_DIR)
const pane = (await request('pane.list', {})).panes[0]
const 받은것 = []
const main = await subscribe([{ type: 'pane.agent_detected' }], 'main', (item) => 받은것.push(item))
const agent = await subscribe([{ type: 'pane.agent_status_changed', pane_id: pane.pane_id }], 'agent', (item) =>
  받은것.push(item),
)
await sleep(300)

await request('pane.report_agent', { pane_id: pane.pane_id, source: 'l351-harness', agent: 'claude', state: 'working' })
await sleep(700)
const 붙은뒤 = (await request('pane.list', {})).panes.find((item) => item.pane_id === pane.pane_id)
await request('pane.release_agent', { pane_id: pane.pane_id, source: 'l351-harness', agent: 'claude' })
await sleep(1200)
const 뗀뒤 = (await request('pane.list', {})).panes.find((item) => item.pane_id === pane.pane_id)
main.destroy()
agent.destroy()

const 봉투 = 받은것.filter((item) => item.frame.event !== undefined)
const 뗌봉투 = 봉투.slice(-2)
const out = {
  at: new Date().toISOString(),
  질문: 'release_agent 때 어느 구독이 무엇을 싣고 오나 — 상태 봉투가 이름을 싣는가',
  paneId: pane.pane_id,
  받은봉투: 봉투.map((item) => ({ 구독: item.label, event: item.frame.event, data: item.frame.data })),
  '붙은 뒤 진실 (pane.list)': { agent: 붙은뒤?.agent ?? null, agent_status: 붙은뒤?.agent_status ?? null },
  '뗀 뒤 진실 (pane.list)': { agent: 뗀뒤?.agent ?? null, agent_status: 뗀뒤?.agent_status ?? null },
}
out.읽은것 = {
  '두 구독이 다 말했다': new Set(봉투.map((item) => item.label)).size === 2,
  '상태 봉투가 이름을 싣는다': 봉투.some(
    (item) => item.label === 'agent' && typeof item.frame.data?.agent === 'string',
  ),
  '뗌 봉투는 released 를 싣는다': 봉투.some((item) => item.frame.data?.released === true),
  '뗀 뒤 herdr 의 이름은 없다': (뗀뒤?.agent ?? null) === null,
  '뗀 뒤 herdr 의 상태는 unknown': (뗀뒤?.agent_status ?? null) === 'unknown',
  '뗌 앞뒤 두 줄이 붙어서 온다 (순서는 안 정해진다)': 뗌봉투.length === 2,
}
console.log(JSON.stringify({ 받은봉투: out.받은봉투, 읽은것: out.읽은것 }, null, 2))
writeRaw('00-shapes-release.json', out)
