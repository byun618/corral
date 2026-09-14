// `pane.report_agent_session` 이 **push 를 만드는가** — 2차 줄이 언제 붙는지가 여기 달렸다.
//
// 앱 실측(10-app-sessions 3차 실행)에서 참조를 보고해도 corral 이 30초 뒤 재동기 때까지
// 모르는 현상이 나왔다. 원인이 ⓐ herdr 가 push 를 안 보낸다 인지 ⓑ corral 이 그 push 를
// 안 듣는다(어댑터 결함) 인지를 가른다 — ⓑ 면 내가 고쳐야 한다.
//
// 방법: herdr 구독 커넥션을 열어 두고 같은 보고를 한 뒤 **들어오는 프레임을 전부** 적는다.
// 구독 타입 후보를 넓게 걸어 본다. 서버가 모르는 타입이면 ack 가 거절한다 — 그 거절도 답이다.

import net from 'node:net'
import { SESSION, controlSocketPath, ensureSession, herdrCall, herdrRequest, sleep, writeRaw } from './lib.mjs'

const CANDIDATES = [
  // 반례용 — tab.create 가 확실히 일으키는 이벤트. 이게 안 오면 구독 자체가 죽은 것이다.
  'pane.created',
  'pane.updated',
  'pane.agent_detected',
  'pane.agent_session_reported',
  'pane.agent_session_changed',
  'pane.agent_session_updated',
]

function subscribe(types) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlSocketPath(SESSION))
    socket.setEncoding('utf8')
    const frames = []
    let buffer = ''
    let ack = null
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 'probe', method: 'events.subscribe', params: { subscriptions: types.map((type) => ({ type })) } }) + '\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const parsed = JSON.parse(line)
        if (ack === null && parsed.id === 'probe') ack = parsed
        else frames.push({ at: Date.now(), frame: parsed })
      }
    })
    setTimeout(() => resolve({ ack, frames, close: () => socket.destroy(), socket }), 600)
  })
}

async function main() {
  await ensureSession()
  const out = { at: new Date().toISOString(), 후보: CANDIDATES }

  // ① 타입별로 따로 걸어 **어느 타입이 존재하는지** 부터 가른다.
  out['타입별 ack'] = {}
  for (const type of CANDIDATES) {
    const sub = await subscribe([type])
    out['타입별 ack'][type] = sub.ack
    sub.close()
  }

  // ② 존재하는 타입을 전부 걸고 실제 보고를 태운다.
  // **ack 가 실제로 온 타입만** 건다. 모르는 타입을 섞으면 herdr 가 그 커넥션을 거절해
  // 아무 프레임도 안 오는데, 그걸 "push 가 없다" 로 읽으면 정반대 결론이 난다.
  const alive = CANDIDATES.filter((type) => out['타입별 ack'][type]?.result != null)
  const listener = await subscribe(alive)
  const workspace = await herdrRequest('workspace.create', { path: process.cwd() })
  const workspaceId = workspace.workspace?.workspace_id ?? workspace.workspace_id
  const panes = await herdrRequest('pane.list', {})
  const pane = panes.panes.find((item) => item.workspace_id === workspaceId)
  // workspace.create 가 만든 `pane_created` 가 먼저 다 도착하게 둔다 — 안 그러면 그 프레임이
  // 보고의 결과인 것처럼 창에 걸린다.
  await sleep(1200)
  const reportedAt = Date.now()
  out.보고 = await herdrCall('pane.report_agent_session', {
    pane_id: pane.pane_id,
    source: 'herdr:claude',
    agent: 'claude',
    seq: Date.now(),
    agent_session_id: 'PUSH-PROBE-1',
  })
  await sleep(2500)
  const reportWindowEnd = Date.now()
  // 관문 ⑤ 반례 — 같은 구독이 **다른 조작에서는 프레임을 받는다**. 이게 없으면 "0건"이
  // 구독이 죽어 있었다는 뜻인지 herdr 가 안 보낸다는 뜻인지 못 가른다.
  const controlAt = Date.now()
  out['반례 조작(tab.create)'] = await herdrCall('tab.create', { workspace_id: workspaceId })
  await sleep(1500)
  out['반례 조작 뒤 받은 프레임'] = listener.frames
    .filter((item) => item.at >= controlAt - 50)
    .map((item) => ({ ms: item.at - controlAt, event: item.frame.event ?? null }))
  listener.close()
  out['건 타입'] = alive
  // 창을 **반례 조작 전까지**로 닫는다 — 안 그러면 반례가 만든 프레임이 보고의 것으로 새어든다.
  out['보고 뒤 받은 프레임'] = listener.frames
    .filter((item) => item.at >= reportedAt && item.at <= reportWindowEnd)
    .map((item) => ({ ms: item.at - reportedAt, event: item.frame.event ?? null, data: item.frame.data ?? item.frame }))
  out.판정 =
    out['보고 뒤 받은 프레임'].length > 0
      ? 'herdr 가 push 를 준다 — corral 이 놓친 것이면 어댑터를 고쳐야 한다'
      : 'herdr 가 push 를 안 준다 — 참조는 재동기 스냅샷으로만 온다 (upstream)'
  out.정리 = await herdrCall('workspace.close', { workspace_id: workspaceId })
  writeRaw('push-probe.json', out)
  console.log(
    JSON.stringify(
      {
        ack: out['타입별 ack'],
        건_타입: alive,
        보고_뒤_프레임: out['보고 뒤 받은 프레임'],
        반례_조작_뒤_프레임: out['반례 조작 뒤 받은 프레임'],
        판정: out.판정,
      },
      null,
      1,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
