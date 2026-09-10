// herdr push 순서 실측 — 같은 workspace 의 create 와 close 가 뒤집혀 오는가.
//
// 왜 재나: K1 수렴 비교가 간헐적으로 어긋났고, 원인을 앱 로그에서 추적했더니
// `workspace_closed(w8G)` 가 `workspace_created(w8G)` 보다 **먼저** 도착해 있었다.
// 앱 로그는 앱의 해석이 섞이므로, 여기서는 하네스가 **구독 스트림 원문**으로 다시 잰다.
//
// 이건 herdr 의 성질이지 앱의 버그가 아니다 — 다만 클라이언트가 방어해야 한다.

import net from 'node:net'
import { SESSION, sleep, socketPath, startChurn, tidySession, writeRaw } from './lib.mjs'

const TYPES = [
  'workspace.created',
  'workspace.closed',
  'tab.created',
  'tab.closed',
  'pane.created',
  'pane.closed',
]

const SOCK = socketPath()
const events = []

const subscription = net.createConnection(SOCK)
subscription.setEncoding('utf8')
let buffer = ''
subscription.on('error', (error) => console.error('sub error', error.code))
subscription.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim().length === 0) continue
    const message = JSON.parse(line)
    if (message.event) events.push({ at: Date.now(), event: message.event, data: message.data })
  }
})
await new Promise((resolve) => subscription.on('connect', resolve))
subscription.write(
  JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: TYPES.map((type) => ({ type })) } }) +
    '\n',
)
await sleep(300)

await tidySession()
const churns = [0, 1, 2, 3].map(() => startChurn({ intervalMs: 0 }))
await sleep(6000)
for (const churn of churns) await churn.stop()
await sleep(2000)
subscription.end()
subscription.destroy()

// --- 도착 순서를 workspace 별로 정리한다 ---------------------------------
const byWorkspace = new Map()
for (const item of events) {
  const workspaceId =
    item.data?.workspace?.workspace_id ??
    item.data?.workspace_id ??
    item.data?.pane?.workspace_id ??
    item.data?.tab?.workspace_id ??
    null
  if (workspaceId === null) continue
  const list = byWorkspace.get(workspaceId) ?? []
  list.push({ at: item.at, event: item.event })
  byWorkspace.set(workspaceId, list)
}

const inversions = []
const lateChildren = []
for (const [workspaceId, list] of byWorkspace) {
  const created = list.find((item) => item.event === 'workspace_created')
  const closed = list.find((item) => item.event === 'workspace_closed')
  if (created && closed && closed.at < created.at) {
    inversions.push({ workspaceId, closedAt: closed.at, createdAt: created.at, lagMs: created.at - closed.at })
  }
  if (closed) {
    for (const item of list) {
      if ((item.event === 'pane_created' || item.event === 'tab_created') && item.at > closed.at) {
        lateChildren.push({ workspaceId, event: item.event, lagMs: item.at - closed.at })
      }
    }
  }
}

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  question: '같은 workspace 의 push 가 인과 순서대로 오는가 (create → close)',
  workspacesObserved: byWorkspace.size,
  eventsObserved: events.length,
  inversions: {
    count: inversions.length,
    samples: inversions.slice(0, 10),
    note: 'workspace_closed 가 같은 workspace 의 workspace_created 보다 먼저 도착한 경우',
  },
  lateChildren: {
    count: lateChildren.length,
    samples: lateChildren.slice(0, 10),
    note: 'workspace 가 닫힌 뒤에 그 workspace 의 pane_created/tab_created 가 도착한 경우',
  },
  conclusion:
    inversions.length > 0 || lateChildren.length > 0
      ? 'herdr push 는 같은 workspace 안에서도 인과 순서를 보장하지 않는다. 푸시에 시퀀스 번호가 ' +
        '없으므로 클라이언트가 막아야 한다 — corral 은 (1) 주인 없는 pane/tab 을 버리고 ' +
        '(2) 닫힌 지 5초 안에 온 create 를 늦게 온 과거로 보고 버린다.'
      : '이번 측정에서는 뒤집힘이 관측되지 않았다 (부하가 낮았을 수 있다 — 공백으로 남긴다).',
}

writeRaw('27-push-ordering.json', result)
console.log(JSON.stringify({ workspaces: result.workspacesObserved, inversions: inversions.length, lateChildren: lateChildren.length }, null, 2))
await tidySession()
